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
import * as tf from '@tensorflow/tfjs-node-gpu';
import type { Action, GameState } from '../../../src/game/types';
import { stepGame } from '../../../src/game/reducer';
import { decideAction as decideSmart } from '../../../src/ai/smartAI';
import {
  ACTION_SPACE_SIZE,
  actionIdToAction,
  legalActionIds,
} from '../../../src/ai/actionSpace';
import { determinizeDeck, observationKey } from '../../../src/ai/infoSet';
import { encodeState } from '../../../src/ai/encoding';
import { evaluateState, DEFAULT_WEIGHTS } from '../../../src/ai/evaluator';
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
   * 効果: NN 呼び出し回数を 1/N に削減（実測 ~8x speedup）。
   */
  batchSize?: number;
  /**
   * Gen-3-K8: Virtual loss を使うかどうか（default false）。
   * batch 内で同じ leaf に集中するのを防ぐため探索中 path に「-1 (最下位)」を加算。
   * しかし試行（az-v8）では vs smart 勝率が 8% → 0% に大幅悪化、 default off。
   * 残置する理由: パラメータチューニング次第で再評価の余地があり、 機能を完全削除しない。
   */
  virtualLoss?: boolean;
  /**
   * Gen-3-M ハイブリッド: leaf value を NN value head ではなく、
   * 既存 evaluator (`evaluateState` with `DEFAULT_WEIGHTS` = Gen-3-F) で計算する。
   *
   * 利点:
   *   - 既存 Gen-3-F の強さ（vs smart 89.5%）を baseline として保証
   *   - NN は policy（prior）の補助だけに使われるため学習データ要求が桁違いに少ない
   *   - value head 無しの policy-only NN（`createPolicyOnlyModel`）と組み合わせ可
   *
   * NN value head ありモデルでも `useHeuristicValue=true` を渡せば value 出力を無視する。
   * policy-only モデル（valueSize=0）の場合はこのフラグに関わらず heuristic を強制使用。
   */
  useHeuristicValue?: boolean;
  /**
   * Gen-3-N: heuristic leaf value の tanh スケール。 mctsAI の DEFAULT_LEAF_EVAL_SCALE=1500 に合わせる。
   * 小さすぎると tanh が飽和して value の識別力が落ちる。
   */
  leafEvalScale?: number;
}

const DEFAULT_LEAF_EVAL_SCALE = 1500;

/**
 * Gen-3-M: leaf state を全プレイヤー視点で `evaluateState` で評価し、
 * tanh で `[-1, +1]` に正規化した numPlayers 次元のベクトルを返す。
 * scale は mctsAI と同じ 1500（Gen-3-N で 1000 から修正）。
 */
function evaluateLeafHeuristic(
  state: GameState,
  numPlayers: number,
  scale: number
): Float32Array {
  const vec = new Float32Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    const raw = evaluateState(state, p, DEFAULT_WEIGHTS);
    vec[p] = Math.tanh(raw / scale);
  }
  return vec;
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
  /**
   * Gen-3-K11: parallel 用の仮 priors フラグ。
   * true: NN 推論待ちの状態で uniform priors を仮置きしている → NN 結果到着で上書き可
   * false / undefined: 真の priors（既に NN で評価済み or sequential 経由）
   */
  provisional?: boolean;
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
    // policy-only モデル（valueSize=0）の場合は predict が tf.Tensor を返す。
    // policy+value モデルの場合は tf.Tensor[] を返す。
    const rawOut = model.net.predict(input);
    const out: tf.Tensor[] = Array.isArray(rawOut) ? rawOut : [rawOut];
    const policyFlat = out[0].dataSync() as Float32Array;
    const policySize = policyFlat.length / n;
    const policies: Float32Array[] = new Array(n);
    const values: Float32Array[] = new Array(n);
    if (out.length >= 2) {
      const valueFlat = out[1].dataSync() as Float32Array;
      const valueSize = valueFlat.length / n;
      for (let i = 0; i < n; i++) {
        policies[i] = new Float32Array(policyFlat.subarray(i * policySize, (i + 1) * policySize));
        values[i] = new Float32Array(valueFlat.subarray(i * valueSize, (i + 1) * valueSize));
      }
    } else {
      // policy-only: value は呼び出し側で heuristic 計算するためダミー（長さ 0）
      for (let i = 0; i < n; i++) {
        policies[i] = new Float32Array(policyFlat.subarray(i * policySize, (i + 1) * policySize));
        values[i] = new Float32Array(0);
      }
    }
    return { policies, values };
  });
}

function puctSelect(
  node: NodeStats,
  legal: number[],
  c: number
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
  const useVirtualLoss = options.virtualLoss ?? false;

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

      const chosen = puctSelect(node, legal, puctC);
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
        // Gen-3-K8: useVirtualLoss=true のときのみ仮想 loss を apply（default off）。
        // az-v8 検証で「学習データを偏らせて勝率を大幅悪化させる」と判明したため。
        if (useVirtualLoss) applyVirtualLoss(r.path);
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
      const { policies, values: nnValues } = nnPredictBatch(model, stateVecs);
      // Gen-3-M: hybrid モードでは leaf value を heuristic で計算（NN value 出力を無視）
      // policy-only モデル（valueSize=0）でも自動的に heuristic を使う
      const useHeuristic = (options.useHeuristicValue ?? false) || model.valueSize === 0;
      for (let i = 0; i < expandList.length; i++) {
        const e = expandList[i];
        // Gen-3-K8: 先程 apply した virtual loss があれば解除してから real backprop
        if (useVirtualLoss) unapplyVirtualLoss(e.path);
        const leafValue = useHeuristic
          ? evaluateLeafHeuristic(e.leafState, numPlayers, options.leafEvalScale ?? DEFAULT_LEAF_EVAL_SCALE)
          : nnValues[i];
        // ノードがバッチ内の別 iter で既に expand 済みなら、priors を上書きしない
        if (e.leafNode.priors === null) {
          installPriors(e.leafNode, policies[i], e.leafLegal);
          e.leafNode.cachedValuePerPlayer = leafValue;
        }
        backprop(e.path, leafValue);
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

// ============================================================================
// Gen-3-K11: Parallel self-play 用の並列 decide API
// 複数の独立した (state, playerId) の MCTS を同時進行させ、 全 game の simulation
// で発生する未展開 leaf を 1 つの batch にまとめて NN 推論する。
// 効果: NN 呼び出し回数を 1/parallelGames に削減し、 1 batch あたりサンプル数を
// 元の mctsBatchSize → mctsBatchSize × parallelGames に拡大できる。
// GPU 利用効率の向上に直結する（PCIe 転送オーバーヘッドが分散される）。
// ============================================================================

interface PerGameMctsContext {
  rootState: GameState;
  playerId: number;
  rootActor: number;
  rootLegal: number[];
  rootKey: string;
  iterations: number;
  iterDone: number;
  baseSeed: number;
  numPlayers: number;
  puctC: number;
  treeMaxDepth: number;
  determinize: boolean;
  nodes: Map<string, NodeStats>;
  /** 即答ケース（awaitingGiftSelection 委譲 / 1 択 / 行動権なし）の結果 */
  shortcut: NeuralMctsResult | null;
}

function makePerGameContext(
  state: GameState,
  playerId: number,
  options: NeuralMctsOptions,
  seed?: number
): PerGameMctsContext {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const puctC = options.puctC ?? DEFAULT_PUCT_C;
  const treeMaxDepth = options.treeMaxDepth ?? DEFAULT_TREE_MAX_DEPTH;
  const determinize = options.determinize ?? true;
  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;
  const numPlayers = state.players.length;
  const nodes = new Map<string, NodeStats>();

  let shortcut: NeuralMctsResult | null = null;
  let rootActor = -1;
  let rootLegal: number[] = [];
  let rootKey = '';

  if (state.phase === 'awaitingGiftSelection') {
    shortcut = {
      action: decideSmart(state, playerId, seed),
      visits: new Int32Array(ACTION_SPACE_SIZE),
      totalVisits: 0,
    };
  } else {
    const isGiftPlacementActor =
      state.phase === 'awaitingGiftPlacement' &&
      state.turn.pendingGiftBatches[0]?.recipientId === playerId;
    if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) {
      shortcut = {
        action: null,
        visits: new Int32Array(ACTION_SPACE_SIZE),
        totalVisits: 0,
      };
    } else {
      rootActor = currentActorId(state);
      rootLegal = legalActionIds(state, rootActor);
      rootKey = observationKey(state, playerId) + '|a:' + rootActor;
      if (rootLegal.length === 0) {
        shortcut = {
          action: null,
          visits: new Int32Array(ACTION_SPACE_SIZE),
          totalVisits: 0,
        };
      } else if (rootLegal.length === 1) {
        shortcut = {
          action: actionIdToAction(state, rootActor, rootLegal[0]),
          visits: new Int32Array(ACTION_SPACE_SIZE),
          totalVisits: 0,
        };
      }
    }
  }

  return {
    rootState: state,
    playerId,
    rootActor,
    rootLegal,
    rootKey,
    iterations,
    iterDone: 0,
    baseSeed,
    numPlayers,
    puctC,
    treeMaxDepth,
    determinize,
    nodes,
    shortcut,
  };
}

function ctxRankingValueVec(s: GameState, numPlayers: number): Float32Array {
  const ranking = computeRanking(s);
  const vec = new Float32Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    vec[p] = rankToValue(ranking[p], numPlayers);
  }
  return vec;
}

function ctxZeroValueVec(numPlayers: number): Float32Array {
  return new Float32Array(numPlayers);
}

function ctxGetOrCreateNode(ctx: PerGameMctsContext, s: GameState, actor: number): NodeStats {
  const key = observationKey(s, ctx.playerId) + '|a:' + actor;
  let n = ctx.nodes.get(key);
  if (!n) {
    n = createNode(actor);
    ctx.nodes.set(key, n);
  }
  return n;
}

type CtxIterResult =
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

function ctxRunSelection(ctx: PerGameMctsContext, iter: number): CtxIterResult {
  const iterSeed = (ctx.baseSeed ^ Math.imul(iter + 1, 0x9e3779b1)) | 0;
  let s: GameState = ctx.determinize ? determinizeDeck(ctx.rootState, iterSeed) : ctx.rootState;
  const path: Array<{ node: NodeStats; aid: number }> = [];

  for (let depth = 0; depth < ctx.treeMaxDepth; depth++) {
    if (s.phase === 'gameOver') {
      return { kind: 'terminal', path, leafValuePerPlayer: ctxRankingValueVec(s, ctx.numPlayers) };
    }
    const actor = currentActorId(s);
    const legal = legalActionIds(s, actor);
    if (legal.length === 0) return { kind: 'cut', path, leafValuePerPlayer: ctxZeroValueVec(ctx.numPlayers) };
    const node = ctxGetOrCreateNode(ctx, s, actor);

    if (node.priors === null) {
      return { kind: 'expand', path, leafState: s, leafActor: actor, leafLegal: legal, leafNode: node };
    }

    const chosen = puctSelect(node, legal, ctx.puctC);
    const action = actionIdToAction(s, actor, chosen);
    if (!action) return { kind: 'cut', path, leafValuePerPlayer: ctxZeroValueVec(ctx.numPlayers) };
    path.push({ node, aid: chosen });
    const before = s;
    s = stepGame(s, action);
    if (s === before) return { kind: 'cut', path, leafValuePerPlayer: ctxZeroValueVec(ctx.numPlayers) };
  }
  return { kind: 'cut', path, leafValuePerPlayer: ctxZeroValueVec(ctx.numPlayers) };
}

function ctxInstallPriors(node: NodeStats, policy: Float32Array, legal: number[]): void {
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
  node.provisional = false;
}

/**
 * Gen-3-K11: 並列 round 内で同じ leaf に衝突するのを防ぐため、 expand 時に
 * uniform priors を仮置きする。 NN 結果到着で真の priors に上書きされる。
 */
function ctxInstallUniformProvisional(node: NodeStats, legal: number[]): void {
  const masked = new Float32Array(ACTION_SPACE_SIZE);
  const p = 1 / legal.length;
  for (const aid of legal) masked[aid] = p;
  node.priors = masked;
  node.provisional = true;
}

function ctxBackprop(
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

function ctxFinalize(ctx: PerGameMctsContext): NeuralMctsResult {
  if (ctx.shortcut) return ctx.shortcut;
  const rootNode = ctx.nodes.get(ctx.rootKey);
  if (!rootNode) {
    return {
      action: actionIdToAction(ctx.rootState, ctx.rootActor, ctx.rootLegal[0]),
      visits: new Int32Array(ACTION_SPACE_SIZE),
      totalVisits: 0,
    };
  }
  let bestAid = ctx.rootLegal[0];
  let bestVisits = -1;
  for (const aid of ctx.rootLegal) {
    if (rootNode.visits[aid] > bestVisits) {
      bestVisits = rootNode.visits[aid];
      bestAid = aid;
    }
  }
  return {
    action: actionIdToAction(ctx.rootState, ctx.rootActor, bestAid),
    visits: new Int32Array(rootNode.visits),
    totalVisits: rootNode.total,
  };
}

/**
 * 複数 game の MCTS を同時進行して、 各 game の最終 action を返す。
 *
 * アルゴリズム:
 *   - 各 context について独立の MCTS tree を持つ
 *   - 1 round で、 各 context について「未展開 leaf に到達するか iterations 完了するまで」 1 simulation を進める
 *   - 1 round で集まった全 context の未展開 leaf を 1 つの NN batch で評価
 *   - 各 leaf に priors / value を install し、 backprop する
 *   - 全 context が iterations を完了するまで繰り返す
 *
 * これにより 1 batch のサンプル数が（並列数 × ~1）になり、 GPU の PCIe 転送
 * オーバーヘッドが分散される。
 *
 * Note: 各 context は独自の `iterations` 設定だが、 並列効率上は全 context で
 * 同じ値を使うのが理想（バラつくと最後の context だけ残って 1 サンプル predict になる）。
 */
export function decideActionNeuralParallel(
  inputs: Array<{ state: GameState; playerId: number; seed?: number }>,
  model: MeteoAzModel,
  options: NeuralMctsOptions = {}
): NeuralMctsResult[] {
  const contexts = inputs.map((inp) =>
    makePerGameContext(inp.state, inp.playerId, options, inp.seed)
  );
  // 1 round 内で各 context が試みる selection 数。 大きいほど 1 batch が大きくなる。
  // デフォルト 16（sequential の mcts-batch=16 と同じ感覚）。
  const perContextBatch = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  // shortcut でないもの = MCTS が必要な context
  const activeIdx: number[] = [];
  for (let i = 0; i < contexts.length; i++) {
    if (!contexts[i].shortcut) activeIdx.push(i);
  }

  // 各 expand entry: 仮 priors を install したかどうかを保持
  // pending を true にしている間、 同 round 内で他の selection から「priors !== null」 と見える
  // → 同じ leaf に集中しなくなる
  while (activeIdx.length > 0) {
    const expandQueue: Array<{
      ctxIdx: number;
      iter: number;
      path: Array<{ node: NodeStats; aid: number }>;
      leafState: GameState;
      leafActor: number;
      leafLegal: number[];
      leafNode: NodeStats;
    }> = [];
    // この round 中に仮 install したノード（後で必ず NN 結果で上書きするためフォロー）
    const provisionalNodes: NodeStats[] = [];

    const nextActive: number[] = [];
    for (const idx of activeIdx) {
      const ctx = contexts[idx];
      // この context について perContextBatch 回まで selection を試みる
      const tryCount = Math.min(perContextBatch, ctx.iterations - ctx.iterDone);
      for (let b = 0; b < tryCount; b++) {
        const r = ctxRunSelection(ctx, ctx.iterDone + b);
        if (r.kind === 'expand') {
          expandQueue.push({
            ctxIdx: idx,
            iter: ctx.iterDone + b,
            path: r.path,
            leafState: r.leafState,
            leafActor: r.leafActor,
            leafLegal: r.leafLegal,
            leafNode: r.leafNode,
          });
          // 仮 priors を install して、 次の selection が同じ leaf に集中しないようにする
          ctxInstallUniformProvisional(r.leafNode, r.leafLegal);
          provisionalNodes.push(r.leafNode);
        } else {
          ctxBackprop(r.path, r.leafValuePerPlayer);
        }
      }
      ctx.iterDone += tryCount;
      if (ctx.iterDone < ctx.iterations) nextActive.push(idx);
    }
    activeIdx.length = 0;
    for (const idx of nextActive) activeIdx.push(idx);

    if (expandQueue.length > 0) {
      const stateVecs = expandQueue.map((e) =>
        Float32Array.from(encodeState(e.leafState, e.leafActor))
      );
      const { policies, values } = nnPredictBatch(model, stateVecs);
      // 同じ leaf を複数 expand で踏んだ場合、 最初の 1 つだけ priors を install
      // （複数ヒットの場合でも各々の path には backprop する）
      const installed = new Set<NodeStats>();
      for (let i = 0; i < expandQueue.length; i++) {
        const e = expandQueue[i];
        if (!installed.has(e.leafNode)) {
          ctxInstallPriors(e.leafNode, policies[i], e.leafLegal);
          e.leafNode.cachedValuePerPlayer = values[i];
          installed.add(e.leafNode);
        }
        ctxBackprop(e.path, values[i]);
      }
      // provisional のまま残ったノードがあれば、 (NN 結果が来てない = expandQueue から漏れた)
      // 強制的に uniform を真扱いにして次 round に進めるしかない（理論上は起こらないはず）
      for (const n of provisionalNodes) {
        if (n.provisional) n.provisional = false;
      }
    }
  }

  return contexts.map((c) => ctxFinalize(c));
}
