import type { Action, GameState } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32 } from '../game/rng';
import { decideAction as decideRandom } from './randomAI';
import { decideAction as decideSmart } from './smartAI';
import { evaluateState, type EvalWeights } from './evaluator';
import {
  ACTION_SPACE_SIZE,
  actionIdToAction,
  legalActionIds,
} from './actionSpace';
import { determinizeDeck, observationKey } from './infoSet';

const DEFAULT_ITERATIONS = 400;
/**
 * UCT1 の探索係数。
 *
 * Gen-3-L で grid search により最適化された値:
 *   uctC ∈ {0.3, 0.5, 0.7, 1.0, 1.4142, 1.7, 2.0, 2.4} (100 局 vs smart x3)
 *   uctC = 2.0 で勝率 94% / avgScore 21.11 がピーク（旧 √2 ≈ 1.4142 は 88%）。
 *   200 局ホールドアウト ×2 seed で +2.0〜+3.5pt の改善を確認、 採用。
 *   詳細は `ai/CHANGELOG.md` の Gen-3-L エントリ。
 */
const DEFAULT_UCT_C = 2.0;
const DEFAULT_PB_C = 1.5;
const DEFAULT_ROLLOUT_MAX_STEPS = 400;
const DEFAULT_TREE_MAX_DEPTH = 50;
const DEFAULT_LEAF_EVAL_SCALE = 1500;

export type LeafEvalMode = 'rollout' | 'evaluator';

export interface MctsOptions {
  iterations?: number;
  uctC?: number;
  rolloutMaxSteps?: number;
  treeMaxDepth?: number;
  determinize?: boolean;
  /**
   * リーフでの価値推定方法。
   *   - 'evaluator' (デフォルト): `evaluateState` を tanh で [-1, +1] にマッピングし即値を返す。高速・安定。
   *   - 'rollout': ランダムプレイアウトで最後まで進めて順位ベース価値を返す。Gen-1 互換、低速・高分散。
   */
  leafEval?: LeafEvalMode;
  leafEvalScale?: number;
  /**
   * Progressive Bias (PUCT) を有効にする。デフォルト false（Gen-3-C で不採用となったため）。
   *   - true: 子アクションの prior を事前計算し、PUCT 風スコア Q + C·P·√N/(1+n) で選択
   *   - false: 旧来の UCT1 (Q + C·√(lnN/n))、未訪問は random 展開
   *
   * Note: 機能自体は残してあるため、prior の与え方や pbC のチューニングで再挑戦可能。
   * 直接使う場合は `decideMcts(state, pid, undefined, { progressiveBias: true, pbC: ... })`
   */
  progressiveBias?: boolean;
  pbC?: number;
  /**
   * 評価関数の重み。省略時は evaluator のモジュール global を使う。
   * Gen-3-J 以降は smartAI とは独立した重みで mcts を動かせる。
   */
  weights?: EvalWeights;
}

interface NodeStats {
  actor: number;
  total: number;
  visits: Int32Array;
  values: Float64Array;
  /** Progressive Bias 用の prior。lazy 初期化。null なら未計算。 */
  priors: Float64Array | null;
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

/**
 * 0(1位)=+1.0, 1(2位)=+0.33, 2(3位)=-0.33, 3(4位)=-1.0
 * 線形マッピングで [-1, +1] の範囲に収める。
 */
function rankToValue(rank: number, numPlayers: number): number {
  if (numPlayers <= 1) return 0;
  return 1 - (2 * rank) / (numPlayers - 1);
}

function stateBaseSeed(state: GameState, playerId: number): number {
  const a = state.rngSeed >>> 0;
  const b = Math.imul(state.turnNumber + 1, 0x9e3779b1);
  const c = Math.imul(playerId + 1, 0x85ebca6b);
  const d = Math.imul(state.log.length + 1, 0xc2b2ae35);
  return (a ^ b ^ c ^ d) | 0;
}

function rolloutPolicy(state: GameState, seed: number): Action | null {
  const actorId = currentActorId(state);
  return decideRandom(state, actorId, seed);
}

function rolloutToEnd(
  state: GameState,
  maxSteps: number,
  rng: () => number
): GameState {
  let s = state;
  for (let i = 0; i < maxSteps && s.phase !== 'gameOver'; i++) {
    const seed = (rng() * 2 ** 32) | 0;
    const action = rolloutPolicy(s, seed);
    if (!action) break;
    const before = s;
    s = stepGame(s, action);
    if (s === before) break;
  }
  return s;
}

/**
 * `evaluateState` を [-1, +1] に圧縮した価値を返す。
 * 終端なら順位ベース価値を返す。
 */
function leafValueByEvaluator(
  state: GameState,
  viewerId: number,
  scale: number,
  numPlayers: number,
  weights: EvalWeights | undefined
): number {
  if (state.phase === 'gameOver') {
    const ranking = computeRanking(state);
    return rankToValue(ranking[viewerId], numPlayers);
  }
  const raw = evaluateState(state, viewerId, weights);
  return Math.tanh(raw / scale);
}

function uctSelect(node: NodeStats, legal: number[], c: number): number {
  let bestId = legal[0];
  let bestScore = -Infinity;
  const logN = Math.log(Math.max(1, node.total));
  for (const aid of legal) {
    const n = node.visits[aid];
    let score: number;
    if (n === 0) {
      score = Number.POSITIVE_INFINITY;
    } else {
      const exploit = node.values[aid] / n;
      const explore = c * Math.sqrt(logN / n);
      score = exploit + explore;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = aid;
    }
  }
  return bestId;
}

/**
 * PUCT 風選択: Score(a) = Q(a) + C * P(a) * sqrt(N) / (1 + n(a))
 * 未訪問アクションも prior に基づき順序付けられるため、別途 "unvisited を random 展開" のロジックは不要。
 */
function puctSelect(node: NodeStats, legal: number[], c: number): number {
  let bestId = legal[0];
  let bestScore = -Infinity;
  const sqrtN = Math.sqrt(Math.max(1, node.total));
  const priors = node.priors;
  for (const aid of legal) {
    const n = node.visits[aid];
    const q = n > 0 ? node.values[aid] / n : 0;
    const p = priors ? priors[aid] : 0;
    const u = c * p * sqrtN / (1 + n);
    const score = q + u;
    if (score > bestScore) {
      bestScore = score;
      bestId = aid;
    }
  }
  return bestId;
}

/**
 * 各 legal action を一手だけ仮実行し、actor 視点の leaf 評価値を prior として格納する。
 * ノード初回利用時に lazy で呼ぶ。
 */
function computePriors(
  state: GameState,
  actor: number,
  legal: number[],
  scale: number,
  numPlayers: number,
  weights: EvalWeights | undefined
): Float64Array {
  const priors = new Float64Array(ACTION_SPACE_SIZE);
  for (const aid of legal) {
    const action = actionIdToAction(state, actor, aid);
    if (!action) continue;
    let nextState: GameState;
    try {
      nextState = stepGame(state, action);
    } catch {
      continue;
    }
    if (nextState === state) continue;
    if (nextState.phase === 'gameOver') {
      const ranking = computeRanking(nextState);
      priors[aid] = rankToValue(ranking[actor], numPlayers);
    } else {
      const raw = evaluateState(nextState, actor, weights);
      priors[aid] = Math.tanh(raw / scale);
    }
  }
  return priors;
}

function createNode(actor: number): NodeStats {
  return {
    actor,
    total: 0,
    visits: new Int32Array(ACTION_SPACE_SIZE),
    values: new Float64Array(ACTION_SPACE_SIZE),
    priors: null,
  };
}

/**
 * MCTS の root 探索情報（学習データ生成・デバッグ用）。
 * Gen-3-K1a で追加：方策ターゲットを `softmax(visits^(1/τ))` で作るのに使う。
 */
export interface MctsSearchInfo {
  /** root の actor（行動を選ぶプレイヤー） */
  rootActor: number;
  /** 行動 ID 別の root 訪問回数（ACTION_SPACE_SIZE 次元） */
  visits: Int32Array;
  /** root の総訪問回数 */
  totalVisits: number;
  /** 行動 ID 別の root 平均価値（visits == 0 のものは 0） */
  meanValues: Float32Array;
}

export interface DecideActionResult {
  action: Action | null;
  /** MCTS 探索を実際に行った場合のみ非 null。`awaitingGiftSelection` 等は null。 */
  info: MctsSearchInfo | null;
}

/**
 * IS-MCTS（Information Set MCTS）による行動決定。
 *
 * 概要:
 *   - 各 iteration の冒頭で「隠れ情報＝山札の順序」を determinize する
 *   - 観測情報集合キーでノードを共有（同じ観測なら同じ統計を使う）
 *   - 多人数ゲームのため、各ノードに actor を記録し、その actor の rank-based value を蓄積
 *   - 各 actor は自分の順位を最大化する想定（mean-field）
 *   - リーフ評価は `leafEval`:
 *      'evaluator' (デフォルト): `evaluateState` を tanh で圧縮した即値（高速）
 *      'rollout': ランダムプレイアウトで終端まで進めて順位ベース価値（Gen-1 互換）
 *
 * 限界:
 *   - CONFIRM_GIFTS は離散行動空間化が難しいため smartAI のヒューリスティックに委譲
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: MctsOptions = {}
): Action | null {
  return decideActionWithInfo(state, playerId, seed, options).action;
}

/**
 * `decideAction` と同じだが、root の探索情報（visit count 等）も返す。
 * 学習データ生成（softmax(visits) を方策ターゲットにする）に使う。
 *
 * `awaitingGiftSelection` 等で smartAI に委譲する場合や、root 合法手が 1 つ以下で
 * 探索を行わない場合は `info` が null になる。
 */
export function decideActionWithInfo(
  state: GameState,
  playerId: number,
  seed?: number,
  options: MctsOptions = {}
): DecideActionResult {
  if (state.phase === 'awaitingGiftSelection') {
    return { action: decideSmart(state, playerId, seed), info: null };
  }

  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) {
    return { action: null, info: null };
  }

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const uctC = options.uctC ?? DEFAULT_UCT_C;
  const rolloutMaxSteps = options.rolloutMaxSteps ?? DEFAULT_ROLLOUT_MAX_STEPS;
  const treeMaxDepth = options.treeMaxDepth ?? DEFAULT_TREE_MAX_DEPTH;
  const determinize = options.determinize ?? true;
  const leafEval: LeafEvalMode = options.leafEval ?? 'evaluator';
  const leafEvalScale = options.leafEvalScale ?? DEFAULT_LEAF_EVAL_SCALE;
  const progressiveBias = options.progressiveBias ?? false;
  const pbC = options.pbC ?? DEFAULT_PB_C;
  const weights = options.weights;

  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;

  const rootActor = currentActorId(state);
  const rootLegal = legalActionIds(state, rootActor);
  if (rootLegal.length === 0) return { action: null, info: null };
  if (rootLegal.length === 1) {
    return {
      action: actionIdToAction(state, rootActor, rootLegal[0]),
      info: null,
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

  const searchRng = mulberry32(baseSeed);

  for (let iter = 0; iter < iterations; iter++) {
    const iterSeed = (baseSeed ^ Math.imul(iter + 1, 0x9e3779b1)) | 0;
    let s: GameState = determinize ? determinizeDeck(state, iterSeed) : state;

    const path: Array<{ node: NodeStats; aid: number }> = [];
    let expanded = false;

    for (let depth = 0; depth < treeMaxDepth; depth++) {
      if (s.phase === 'gameOver') break;
      const actor = currentActorId(s);
      const legal = legalActionIds(s, actor);
      if (legal.length === 0) break;
      const node = getOrCreateNode(s, actor);

      let chosen: number;
      if (progressiveBias) {
        if (!node.priors) {
          node.priors = computePriors(s, actor, legal, leafEvalScale, numPlayers, weights);
        }
        chosen = puctSelect(node, legal, pbC);
        // PUCT は未訪問アクションも prior 順で扱うため、unvisited を別途 random 展開する必要はない。
        // expansion 判定は「初めてこの node.visits[chosen] が 0 だった場合」とする
        if (node.visits[chosen] === 0) expanded = true;
      } else {
        const unvisited: number[] = [];
        for (const aid of legal) {
          if (node.visits[aid] === 0) unvisited.push(aid);
        }
        if (unvisited.length > 0) {
          chosen = unvisited[Math.floor(searchRng() * unvisited.length)];
          expanded = true;
        } else {
          chosen = uctSelect(node, legal, uctC);
        }
      }

      const action = actionIdToAction(s, actor, chosen);
      if (!action) break;
      path.push({ node, aid: chosen });

      const before = s;
      s = stepGame(s, action);
      if (s === before) break;

      if (expanded) break;
    }

    const leafState = s;
    let ranking: number[] | null = null;
    if (leafEval === 'rollout') {
      const rolloutEnd =
        leafState.phase !== 'gameOver'
          ? rolloutToEnd(leafState, rolloutMaxSteps, () => searchRng())
          : leafState;
      ranking = computeRanking(rolloutEnd);
    } else if (leafState.phase === 'gameOver') {
      ranking = computeRanking(leafState);
    }

    for (const { node, aid } of path) {
      let value: number;
      if (ranking) {
        value = rankToValue(ranking[node.actor], numPlayers);
      } else {
        value = leafValueByEvaluator(leafState, node.actor, leafEvalScale, numPlayers, weights);
      }
      node.total += 1;
      node.visits[aid] += 1;
      node.values[aid] += value;
    }
  }

  const rootNode = nodes.get(observationKey(state, playerId) + '|a:' + rootActor);
  if (!rootNode) {
    return {
      action: actionIdToAction(state, rootActor, rootLegal[0]),
      info: null,
    };
  }
  let bestAid = rootLegal[0];
  let bestVisits = -1;
  let bestValue = -Infinity;
  for (const aid of rootLegal) {
    const v = rootNode.visits[aid];
    const meanValue =
      v > 0 ? rootNode.values[aid] / v : Number.NEGATIVE_INFINITY;
    if (v > bestVisits || (v === bestVisits && meanValue > bestValue)) {
      bestVisits = v;
      bestValue = meanValue;
      bestAid = aid;
    }
  }
  const meanValuesOut = new Float32Array(ACTION_SPACE_SIZE);
  for (let i = 0; i < ACTION_SPACE_SIZE; i++) {
    const v = rootNode.visits[i];
    meanValuesOut[i] = v > 0 ? rootNode.values[i] / v : 0;
  }
  return {
    action: actionIdToAction(state, rootActor, bestAid),
    info: {
      rootActor,
      visits: new Int32Array(rootNode.visits),
      totalVisits: rootNode.total,
      meanValues: meanValuesOut,
    },
  };
}
