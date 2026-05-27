/**
 * Gen-3-K1b: ネットワーク誘導 MCTS。
 *
 * 既存 mctsAI と同じ IS-MCTS フレームワークだが:
 *   - prior（PUCT 風スコアの事前確率）に NN の方策出力を使う
 *   - leaf 評価に NN の価値出力（tanh で [-1, +1]）を使う
 *
 * AlphaZero と同じ「方策ネット + 価値ネット + MCTS」構成の最小実装。
 * 本実装は tfjs-node を直接 import するため学習側専用。ブラウザ移植は別途。
 */
import * as tf from '@tensorflow/tfjs-node';
import type { Action, GameState } from '../../../src/game/types';
import { stepGame } from '../../../src/game/reducer';
import { mulberry32 } from '../../../src/game/rng';
import { decideAction as decideSmart } from '../../../src/ai/smartAI';
import {
  ACTION_SPACE_SIZE,
  actionIdToAction,
  legalActionIds,
} from '../../../src/ai/actionSpace';
import { determinizeDeck, observationKey } from '../../../src/ai/infoSet';
import { encodeState } from '../../../src/ai/encoding';
import type { MeteoAzModel } from './model';

const DEFAULT_ITERATIONS = 100;
const DEFAULT_PUCT_C = 1.4;
const DEFAULT_TREE_MAX_DEPTH = 50;
const DEFAULT_BATCH_SIZE = 1;

export interface NeuralMctsOptions {
  iterations?: number;
  puctC?: number;
  treeMaxDepth?: number;
  determinize?: boolean;
  /**
   * NN バッチ推論サイズ（Gen-3-K4）。
   * 1 ならば従来通り leaf ごとに 1 回 predict。
   * N (N >= 2) ならば N 個の独立 iter を並列に traverse し、まとめて 1 回 predict する。
   * 効果: NN 呼び出し回数を 1/N に削減（推定 3-5x speedup）。
   * 注意: virtual loss を実装していないので、同じ leaf に集中する可能性がある（mitigation:
   *       各 iter は別 determinize seed を使うため、実質的には異なる leaf に到達することが多い）。
   */
  batchSize?: number;
}

export interface NeuralMctsResult {
  action: Action | null;
  visits: Int32Array;
  totalVisits: number;
}

interface NodeStats {
  actor: number;
  total: number;
  visits: Int32Array;
  values: Float32Array;
  /** NN 方策出力（事前確率） */
  priors: Float32Array | null;
  /**
   * 一度だけ NN を呼んで value 全プレイヤー分を保存。
   * Gen-3-K6: 各プレイヤー視点の rank-based value（numPlayers 次元）。
   */
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

function stateBaseSeed(state: GameState, playerId: number): number {
  const a = state.rngSeed >>> 0;
  const b = Math.imul(state.turnNumber + 1, 0x9e3779b1);
  const c = Math.imul(playerId + 1, 0x85ebca6b);
  const d = Math.imul(state.log.length + 1, 0xc2b2ae35);
  return (a ^ b ^ c ^ d) | 0;
}

/**
 * 複数状態をまとめて NN 推論する（Gen-3-K4 / K6）。
 * 価値出力は K6 から `valueSize` 次元（各プレイヤー視点の rank-based value）。
 * 戻り値: policies[i] = 方策（ACTION_SPACE_SIZE 次元）、values[i] = 価値（valueSize 次元）
 */
function nnPredictBatch(
  model: MeteoAzModel,
  stateVecs: Float32Array[]
): { policies: Float32Array[]; values: Float32Array[] } {
  return tf.tidy(() => {
    const n = stateVecs.length;
    const stateSize = stateVecs[0].length;
    const buf = new Float32Array(n * stateSize);
    for (let i = 0; i < n; i++) buf.set(stateVecs[i], i * stateSize);
    const input = tf.tensor2d(buf, [n, stateSize]);
    const out = model.net.predict(input) as tf.Tensor[];
    const policyFlat = out[0].dataSync() as Float32Array;
    const valueFlat = out[1].dataSync() as Float32Array;
    const policySize = policyFlat.length / n;
    const valueSize = valueFlat.length / n;
    const policies: Float32Array[] = new Array(n);
    const values: Float32Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
      policies[i] = new Float32Array(policyFlat.subarray(i * policySize, (i + 1) * policySize));
      values[i] = new Float32Array(valueFlat.subarray(i * valueSize, (i + 1) * valueSize));
    }
    return { policies, values };
  });
}

function puctSelect(
  node: NodeStats,
  legal: number[],
  c: number,
  numPlayers: number,
  rootActor: number
): number {
  let bestId = legal[0];
  let bestScore = -Infinity;
  const sqrtN = Math.sqrt(Math.max(1, node.total));
  const priors = node.priors;
  // node.actor 視点での Q（root から見て自分か敵かで符号反転は不要：
  // 各 actor は自分の rank を最大化したい、 という mean-field 仮定）
  for (const aid of legal) {
    const n = node.visits[aid];
    const q = n > 0 ? node.values[aid] / n : 0;
    const p = priors ? priors[aid] : 1 / legal.length;
    const u = c * p * sqrtN / (1 + n);
    const score = q + u;
    if (score > bestScore) {
      bestScore = score;
      bestId = aid;
    }
  }
  void numPlayers;
  void rootActor;
  return bestId;
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

export function decideActionNeural(
  state: GameState,
  playerId: number,
  model: MeteoAzModel,
  seed?: number,
  options: NeuralMctsOptions = {}
): NeuralMctsResult {
  // CONFIRM_GIFTS は離散 ID 化が困難なので smart heuristic に委譲（既存 mctsAI 同様）
  if (state.phase === 'awaitingGiftSelection') {
    return {
      action: decideSmart(state, playerId, seed),
      visits: new Int32Array(ACTION_SPACE_SIZE),
      totalVisits: 0,
    };
  }

  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) {
    return { action: null, visits: new Int32Array(ACTION_SPACE_SIZE), totalVisits: 0 };
  }

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const puctC = options.puctC ?? DEFAULT_PUCT_C;
  const treeMaxDepth = options.treeMaxDepth ?? DEFAULT_TREE_MAX_DEPTH;
  const determinize = options.determinize ?? true;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;

  const rootActor = currentActorId(state);
  const rootLegal = legalActionIds(state, rootActor);
  if (rootLegal.length === 0) {
    return { action: null, visits: new Int32Array(ACTION_SPACE_SIZE), totalVisits: 0 };
  }
  if (rootLegal.length === 1) {
    return {
      action: actionIdToAction(state, rootActor, rootLegal[0]),
      visits: new Int32Array(ACTION_SPACE_SIZE),
      totalVisits: 0,
    };
  }

  const numPlayers = state.players.length;
  const nodes = new Map<string, NodeStats>();

  function getOrCreateNode(s: GameState, actor: number): NodeStats {
    const key = observationKey(s, playerId) + '|a:' + actor;
    let n = nodes.get(key);
    if (!n) {
      n = createNode(actor);
      nodes.set(key, n);
    }
    return n;
  }

  /**
   * NN 出力（合法手以外を 0 でマスク後、再正規化）を node の priors に書き込む。
   */
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

  // searchRng は将来「tie-break ランダム」「Dirichlet noise」等のために用意。
  // 現状 PUCT は決定論的なので未使用だが、シグネチャ将来拡張用に保持。
  void mulberry32(baseSeed);

  // 1 iter 分の selection を実行し、 expansion または terminal で停止する。
  // 戻り値は path と「leaf 評価方式」の指示。
  // Gen-3-K6: leafValue は numPlayers 次元（全プレイヤー視点の rank-based value）。
  type IterResult =
    | { kind: 'terminal'; path: Array<{ node: NodeStats; aid: number }>; leafValuePerPlayer: Float32Array }
    | {
        kind: 'expand';
        path: Array<{ node: NodeStats; aid: number }>;
        leafState: GameState;
        leafActor: number;
        leafLegal: number[];
        leafNode: NodeStats;
      }
    | { kind: 'cut'; path: Array<{ node: NodeStats; aid: number }>; leafValuePerPlayer: Float32Array };

  function makeRankingValueVec(s: GameState): Float32Array {
    const ranking = computeRanking(s);
    const vec = new Float32Array(numPlayers);
    for (let p = 0; p < numPlayers; p++) {
      vec[p] = rankToValue(ranking[p], numPlayers);
    }
    return vec;
  }

  function zeroValueVec(): Float32Array {
    return new Float32Array(numPlayers);
  }

  function runSelection(iter: number): IterResult {
    const iterSeed = (baseSeed ^ Math.imul(iter + 1, 0x9e3779b1)) | 0;
    let s: GameState = determinize ? determinizeDeck(state, iterSeed) : state;
    const path: Array<{ node: NodeStats; aid: number }> = [];

    for (let depth = 0; depth < treeMaxDepth; depth++) {
      if (s.phase === 'gameOver') {
        return {
          kind: 'terminal',
          path,
          leafValuePerPlayer: makeRankingValueVec(s),
        };
      }
      const actor = currentActorId(s);
      const legal = legalActionIds(s, actor);
      if (legal.length === 0) return { kind: 'cut', path, leafValuePerPlayer: zeroValueVec() };
      const node = getOrCreateNode(s, actor);

      if (node.priors === null) {
        // 未展開ノード → NN 評価対象として返す
        return {
          kind: 'expand',
          path,
          leafState: s,
          leafActor: actor,
          leafLegal: legal,
          leafNode: node,
        };
      }

      const chosen = puctSelect(node, legal, puctC, numPlayers, rootActor);
      const action = actionIdToAction(s, actor, chosen);
      if (!action) return { kind: 'cut', path, leafValuePerPlayer: zeroValueVec() };
      path.push({ node, aid: chosen });
      const before = s;
      s = stepGame(s, action);
      if (s === before) return { kind: 'cut', path, leafValuePerPlayer: zeroValueVec() };
    }
    return { kind: 'cut', path, leafValuePerPlayer: zeroValueVec() };
  }

  /**
   * Gen-3-K6: path の各 node の actor 視点 value を leafValuePerPlayer から取り出して backup。
   * これによりプレイヤー間で利害が対立する場面でも、各 actor が自分の最終 rank 期待値を
   * 最大化する形で MCTS が探索できる（mean-field 仮定の解消）。
   */
  function backprop(
    path: Array<{ node: NodeStats; aid: number }>,
    leafValuePerPlayer: Float32Array
  ): void {
    for (const { node, aid } of path) {
      const v = leafValuePerPlayer[node.actor] ?? 0;
      node.total += 1;
      node.visits[aid] += 1;
      node.values[aid] += v;
    }
  }

  /**
   * Gen-3-K8: バッチ内で同じ leaf に集中するのを防ぐため、 探索中の path に
   * 「-1 (最下位)」を仮想的に加算する。 backprop（NN 推論）の前に必ず `unapplyVirtualLoss` で解除する。
   */
  function applyVirtualLoss(path: Array<{ node: NodeStats; aid: number }>): void {
    for (const { node, aid } of path) {
      node.total += 1;
      node.visits[aid] += 1;
      node.values[aid] -= 1; // 仮想的に「最下位」を一票
    }
  }

  function unapplyVirtualLoss(path: Array<{ node: NodeStats; aid: number }>): void {
    for (const { node, aid } of path) {
      node.total -= 1;
      node.visits[aid] -= 1;
      node.values[aid] += 1;
    }
  }

  let iterDone = 0;
  while (iterDone < iterations) {
    const bsz = Math.min(batchSize, iterations - iterDone);

    // 1. Selection phase: bsz 個の path を集める
    const expandList: Array<{
      path: Array<{ node: NodeStats; aid: number }>;
      leafState: GameState;
      leafActor: number;
      leafLegal: number[];
      leafNode: NodeStats;
    }> = [];

    for (let b = 0; b < bsz; b++) {
      const r = runSelection(iterDone + b);
      if (r.kind === 'expand') {
        expandList.push({
          path: r.path,
          leafState: r.leafState,
          leafActor: r.leafActor,
          leafLegal: r.leafLegal,
          leafNode: r.leafNode,
        });
        // Gen-3-K8: Virtual loss を path 上に apply して、 同じ batch 内の後続 iter が
        // 同じ leaf に集中しないようにする（exploration 促進）。
        // 価値は [-1, +1] の rank-based、 -1 (最下位) を仮想的に加算 = 「負け前提」。
        applyVirtualLoss(r.path);
      } else {
        // terminal or cut: 即時 backprop（NN 不要）
        backprop(r.path, r.leafValuePerPlayer);
      }
    }

    // 2. Batch predict (expansion 必要なノードがあれば)
    if (expandList.length > 0) {
      const stateVecs = expandList.map((e) =>
        Float32Array.from(encodeState(e.leafState, e.leafActor))
      );
      const { policies, values } = nnPredictBatch(model, stateVecs);
      for (let i = 0; i < expandList.length; i++) {
        const e = expandList[i];
        // Gen-3-K8: 先程 apply した virtual loss を解除してから real backprop
        unapplyVirtualLoss(e.path);
        // ノードがバッチ内の別 iter で既に expand 済みなら、priors を上書きしない
        if (e.leafNode.priors === null) {
          installPriors(e.leafNode, policies[i], e.leafLegal);
          e.leafNode.cachedValuePerPlayer = values[i];
        }
        backprop(e.path, values[i]);
      }
    }

    iterDone += bsz;
  }

  // 最終決定: 最多訪問
  const rootKey = observationKey(state, playerId) + '|a:' + rootActor;
  const rootNode = nodes.get(rootKey);
  if (!rootNode) {
    return {
      action: actionIdToAction(state, rootActor, rootLegal[0]),
      visits: new Int32Array(ACTION_SPACE_SIZE),
      totalVisits: 0,
    };
  }
  let bestAid = rootLegal[0];
  let bestVisits = -1;
  for (const aid of rootLegal) {
    if (rootNode.visits[aid] > bestVisits) {
      bestVisits = rootNode.visits[aid];
      bestAid = aid;
    }
  }
  return {
    action: actionIdToAction(state, rootActor, bestAid),
    visits: new Int32Array(rootNode.visits),
    totalVisits: rootNode.total,
  };
}
