/**
 * ブラウザ向けニューラルネット推論 AI。
 *
 * 学習側 (`ai/scripts/nn/neuralMcts.ts`) と同じ AlphaZero 風アルゴリズム（PUCT + NN）の
 * **ブラウザ実装**。tfjs-node ではなく `@tensorflow/tfjs` を使う。
 *
 * モデルファイル:
 *   - `public/models/<name>/model.json` (+ `weights.bin`) を `loadModel(url)` でロード
 *   - tfjs 標準形式、 学習側の `saveModel()` で保存したものをそのまま読める
 *   - 価値出力は **NUM_PLAYERS 次元** (Gen-3-K6 で導入された mean-field 解消版)
 *
 * フォールバック:
 *   - モデル未ロード時 / ロード失敗時 / 古い形式（1 次元 value）時は **mctsAI に自動委譲**
 *   - これにより `src/ai/index.ts` で `decideAction` を `neuralAI` に切り替えても、
 *     モデルがなければ既存 mctsAI と同じ挙動になる
 */
import * as tf from '@tensorflow/tfjs';
import type { Action, GameState } from '../game/types';
import { stepGame } from '../game/reducer';
import { decideAction as decideMcts } from './mctsAI';
import { decideAction as decideSmart } from './smartAI';
import {
  ACTION_SPACE_SIZE,
  actionIdToAction,
  legalActionIds,
} from './actionSpace';
import { determinizeDeck, observationKey } from './infoSet';
import { encodeState } from './encoding';

// ============================================================================
// モデル管理
// ============================================================================

interface LoadedModel {
  net: tf.LayersModel;
  /** 価値出力の次元数（4 = mean-field 解消版、 1 = 旧版） */
  valueSize: number;
}

let cachedModel: LoadedModel | null = null;
let loadingPromise: Promise<LoadedModel | null> | null = null;
let lastLoadError: unknown = null;

/**
 * モデルをロードする。既にロード中なら同じ Promise を返す（多重呼び出し安全）。
 * 失敗時は `null` を返し、 以降の `decideAction` は mctsAI にフォールバックする。
 */
export async function loadModel(url: string): Promise<LoadedModel | null> {
  if (cachedModel) return cachedModel;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const net = await tf.loadLayersModel(url);
      // valueSize を出力 shape から推定
      const valueOutput = net.outputs[1];
      const valueShape = valueOutput?.shape;
      const valueSize =
        Array.isArray(valueShape) && typeof valueShape[1] === 'number' ? valueShape[1] : 1;
      cachedModel = { net, valueSize };
      lastLoadError = null;
      return cachedModel;
    } catch (e) {
      lastLoadError = e;
      console.warn('[neuralAI] model load failed, falling back to mctsAI:', e);
      cachedModel = null;
      return null;
    }
  })();

  return loadingPromise;
}

export function isModelLoaded(): boolean {
  return cachedModel !== null;
}

export function getLastLoadError(): unknown {
  return lastLoadError;
}

/**
 * テスト・リセット用に強制的にモデルを破棄する。
 */
export function disposeModel(): void {
  if (cachedModel) {
    cachedModel.net.dispose();
    cachedModel = null;
  }
  loadingPromise = null;
  lastLoadError = null;
}

// ============================================================================
// NN 推論 + PUCT MCTS (ブラウザ版、 ai/scripts/nn/neuralMcts.ts の移植)
// ============================================================================

const DEFAULT_ITERATIONS = 100;
const DEFAULT_PUCT_C = 1.4;
const DEFAULT_TREE_MAX_DEPTH = 50;

export interface NeuralAiOptions {
  iterations?: number;
  puctC?: number;
  treeMaxDepth?: number;
  determinize?: boolean;
}

interface NodeStats {
  actor: number;
  total: number;
  visits: Int32Array;
  values: Float32Array;
  priors: Float32Array | null;
  cachedValuePerPlayer: Float32Array | null;
}

function currentActorId(state: GameState): number {
  if (
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches.length > 0
  ) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

function rankToValue(rank: number, numPlayers: number): number {
  return numPlayers > 1 ? 1 - (2 * rank) / (numPlayers - 1) : 0;
}

function computeRanking(state: GameState): number[] {
  const players = state.players;
  const ordered = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = (a.id - state.startPlayerIndex + players.length) % players.length;
    const distB = (b.id - state.startPlayerIndex + players.length) % players.length;
    return distA - distB;
  });
  const rank = new Array<number>(players.length).fill(0);
  ordered.forEach((p, i) => {
    rank[p.id] = i;
  });
  return rank;
}

function makeRankingValueVec(s: GameState, numPlayers: number): Float32Array {
  const ranking = computeRanking(s);
  const vec = new Float32Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    vec[p] = rankToValue(ranking[p], numPlayers);
  }
  return vec;
}

function createNode(actor: number): NodeStats {
  return {
    actor,
    total: 0,
    visits: new Int32Array(ACTION_SPACE_SIZE),
    values: new Float32Array(ACTION_SPACE_SIZE),
    priors: null,
    cachedValuePerPlayer: null,
  };
}

/**
 * NN を呼んで方策 (ACTION_SPACE_SIZE 次元) と価値 (valueSize 次元) を返す。
 * tf.tidy で中間 tensor を解放してメモリリークを防ぐ。
 */
function nnPredict(
  loaded: LoadedModel,
  stateVec: Float32Array
): { policy: Float32Array; value: Float32Array } {
  return tf.tidy(() => {
    const input = tf.tensor2d(stateVec, [1, stateVec.length]);
    const out = loaded.net.predict(input) as tf.Tensor[];
    const policy = out[0].dataSync() as Float32Array;
    const value = out[1].dataSync() as Float32Array;
    return {
      policy: new Float32Array(policy),
      value: new Float32Array(value),
    };
  });
}

function puctSelect(node: NodeStats, legal: number[], c: number): number {
  let bestId = legal[0];
  let bestScore = -Infinity;
  const sqrtN = Math.sqrt(Math.max(1, node.total));
  const priors = node.priors;
  for (const aid of legal) {
    const n = node.visits[aid];
    const q = n > 0 ? node.values[aid] / n : 0;
    const p = priors ? priors[aid] : 1 / legal.length;
    const u = (c * p * sqrtN) / (1 + n);
    const score = q + u;
    if (score > bestScore) {
      bestScore = score;
      bestId = aid;
    }
  }
  return bestId;
}

function installPriors(node: NodeStats, policy: Float32Array, legal: number[]): void {
  const masked = new Float32Array(ACTION_SPACE_SIZE);
  let sum = 0;
  for (const aid of legal) {
    const p = Math.max(0, policy[aid]);
    masked[aid] = p;
    sum += p;
  }
  if (sum > 0) {
    for (let i = 0; i < ACTION_SPACE_SIZE; i++) masked[i] /= sum;
  } else {
    for (const aid of legal) masked[aid] = 1 / legal.length;
  }
  node.priors = masked;
}

/**
 * ブラウザ版 NN-guided MCTS。
 * 学習側 (`ai/scripts/nn/neuralMcts.ts`) と同じ PUCT + leaf 評価 NN だが、
 * バッチ推論はせず leaf 毎に 1 回 predict（ブラウザ環境では Promise/同期の都合で単発が単純）。
 */
function decideActionNeural(
  state: GameState,
  playerId: number,
  loaded: LoadedModel,
  options: NeuralAiOptions = {}
): Action | null {
  // CONFIRM_GIFTS は離散行動 ID 化が難しいので smartAI に委譲
  if (state.phase === 'awaitingGiftSelection') {
    return decideSmart(state, playerId);
  }

  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) return null;

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const puctC = options.puctC ?? DEFAULT_PUCT_C;
  const treeMaxDepth = options.treeMaxDepth ?? DEFAULT_TREE_MAX_DEPTH;
  const determinize = options.determinize ?? true;

  const rootActor = currentActorId(state);
  const rootLegal = legalActionIds(state, rootActor);
  if (rootLegal.length === 0) return null;
  if (rootLegal.length === 1) return actionIdToAction(state, rootActor, rootLegal[0]);

  const numPlayers = state.players.length;
  const nodes = new Map<string, NodeStats>();
  const baseSeed =
    (state.rngSeed ^ (state.turnNumber * 7919) ^ (playerId * 13) ^ state.log.length) | 0;

  function getOrCreateNode(s: GameState, actor: number): NodeStats {
    const key = observationKey(s, playerId) + '|a:' + actor;
    let n = nodes.get(key);
    if (!n) {
      n = createNode(actor);
      nodes.set(key, n);
    }
    return n;
  }

  function backprop(path: Array<{ node: NodeStats; aid: number }>, leafValuePerPlayer: Float32Array): void {
    for (const { node, aid } of path) {
      const v = leafValuePerPlayer[node.actor] ?? 0;
      node.total += 1;
      node.visits[aid] += 1;
      node.values[aid] += v;
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    const iterSeed = (baseSeed ^ Math.imul(iter + 1, 0x9e3779b1)) | 0;
    let s: GameState = determinize ? determinizeDeck(state, iterSeed) : state;
    const path: Array<{ node: NodeStats; aid: number }> = [];
    let leafValuePerPlayer: Float32Array | null = null;

    for (let depth = 0; depth < treeMaxDepth; depth++) {
      if (s.phase === 'gameOver') {
        leafValuePerPlayer = makeRankingValueVec(s, numPlayers);
        break;
      }
      const actor = currentActorId(s);
      const legal = legalActionIds(s, actor);
      if (legal.length === 0) {
        leafValuePerPlayer = new Float32Array(numPlayers);
        break;
      }
      const node = getOrCreateNode(s, actor);

      if (node.priors === null) {
        // 未展開ノード: NN で評価して expansion
        const stateVec = Float32Array.from(encodeState(s, actor));
        const { policy, value } = nnPredict(loaded, stateVec);
        installPriors(node, policy, legal);
        // valueSize == numPlayers の想定。 旧モデル (valueSize=1) は最初の値を全 actor に流用
        if (loaded.valueSize >= numPlayers) {
          node.cachedValuePerPlayer = new Float32Array(value.subarray(0, numPlayers));
        } else {
          const fallback = new Float32Array(numPlayers);
          fallback.fill(value[0] ?? 0);
          node.cachedValuePerPlayer = fallback;
        }
        leafValuePerPlayer = node.cachedValuePerPlayer;
        break;
      }

      const chosen = puctSelect(node, legal, puctC);
      const action = actionIdToAction(s, actor, chosen);
      if (!action) {
        leafValuePerPlayer = new Float32Array(numPlayers);
        break;
      }
      path.push({ node, aid: chosen });
      const before = s;
      s = stepGame(s, action);
      if (s === before) {
        leafValuePerPlayer = new Float32Array(numPlayers);
        break;
      }
    }

    if (leafValuePerPlayer) {
      backprop(path, leafValuePerPlayer);
    }
  }

  // 最終決定: 最多訪問 action
  const rootKey = observationKey(state, playerId) + '|a:' + rootActor;
  const rootNode = nodes.get(rootKey);
  if (!rootNode) return actionIdToAction(state, rootActor, rootLegal[0]);
  let bestAid = rootLegal[0];
  let bestVisits = -1;
  for (const aid of rootLegal) {
    if (rootNode.visits[aid] > bestVisits) {
      bestVisits = rootNode.visits[aid];
      bestAid = aid;
    }
  }
  return actionIdToAction(state, rootActor, bestAid);
}

// ============================================================================
// Public API (mctsAI と同じシグネチャ)
// ============================================================================

/**
 * NN モデルが読まれていれば NN-guided MCTS、 そうでなければ mctsAI で行動決定。
 * シグネチャは `decideMcts` と一致するため、 `src/ai/index.ts` の `decideAction` を
 * `from './mctsAI'` から `from './neuralAI'` に差し替えるだけで使える。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: NeuralAiOptions = {}
): Action | null {
  if (!cachedModel) {
    return decideMcts(state, playerId, seed);
  }
  return decideActionNeural(state, playerId, cachedModel, options);
}
