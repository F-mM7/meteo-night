/**
 * Gen-3-K: 自己対戦による (state, policy_target, value_target) データ生成の骨格。
 *
 * 現時点では「既存の mcts（手書き評価関数版）同士の対戦」からデータを抽出する。
 * 将来的にはネットワーク誘導 MCTS（PUCT + ニューラル prior）に切り替え、
 * AlphaZero ループ（self-play → train → self-play …）を完成させる。
 */
import { setupGame } from '../../../src/game/setup';
import { stepGame } from '../../../src/game/reducer';
import type { Action, GameState } from '../../../src/game/types';
import {
  decideActionWithInfo as decideMctsWithInfo,
  type MctsSearchInfo,
} from '../../../src/ai/mctsAI';
import { decideAction as decideSmart } from '../../../src/ai/smartAI';
import { ACTION_SPACE_SIZE, actionToActionId } from '../../../src/ai/actionSpace';
import { encodeState } from '../../../src/ai/encoding';
import type { MeteoAzModel } from './model';
import { decideActionNeural, decideActionNeuralParallel } from './neuralMcts';

export interface LearnerExample {
  /** 状態ベクトル（encoding.ENCODING_SIZE 次元） */
  state: Float32Array;
  /** 方策ターゲット（ACTION_SPACE_SIZE 次元、合法手のみ 1.0、それ以外 0）*/
  policyTarget: Float32Array;
  /**
   * 価値ターゲット（Gen-3-K6 以降: numPlayers 次元、各プレイヤー視点の rank-based value）
   * [-1, +1]、最終順位を線形マッピング。
   */
  valueTarget: Float32Array;
  /** 観測者（actor） */
  actor: number;
  /** 結果として打たれた action（CONFIRM_GIFTS など ID 化不可なら null） */
  recordedActionId: number | null;
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
  if (numPlayers <= 1) return 0;
  return 1 - (2 * rank) / (numPlayers - 1);
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

export interface SelfPlayOptions {
  seed: number;
  maxSteps?: number;
  /**
   * 方策ターゲットの温度パラメータ。
   * `softmax((visits)^(1/τ))` で正規化する。τ→0 で one-hot、τ→∞ で uniform。
   * AlphaZero 標準は τ=1.0（序盤）/ τ→0（終盤）の切替だが、本実装は単純に固定。
   */
  policyTemperature?: number;
  /**
   * Gen-3-K4: neuralMcts のバッチ推論サイズ。
   * 1 ならば従来通り leaf ごとに 1 回 predict。
   * N (N >= 2) で N 個の leaf をまとめて NN 推論し、 推論回数 1/N に削減。
   */
  mctsBatchSize?: number;
  /**
   * Gen-3-M: ハイブリッドモード。 leaf value を NN value head ではなく evaluator で計算。
   * policy-only モデルとの組み合わせを想定。
   */
  useHeuristicValue?: boolean;
}

/**
 * visits 配列を `softmax((v)^(1/τ))` に変換。
 * 合法手以外（visits = 0）は確率 0 として扱う（既に visits が 0 ならべき乗も 0）。
 */
function visitsToPolicy(visits: Int32Array, tau: number): Float32Array {
  const policy = new Float32Array(visits.length);
  if (tau <= 1e-3) {
    // τ→0: 最も訪問された手を one-hot
    let best = -1;
    let bestV = -1;
    for (let i = 0; i < visits.length; i++) {
      if (visits[i] > bestV) {
        bestV = visits[i];
        best = i;
      }
    }
    if (best >= 0) policy[best] = 1.0;
    return policy;
  }
  let sum = 0;
  const exps = new Float32Array(visits.length);
  const invTau = 1 / tau;
  for (let i = 0; i < visits.length; i++) {
    if (visits[i] > 0) {
      const v = Math.pow(visits[i], invTau);
      exps[i] = v;
      sum += v;
    }
  }
  if (sum === 0) return policy;
  for (let i = 0; i < visits.length; i++) {
    policy[i] = exps[i] / sum;
  }
  return policy;
}

/**
 * 1 局自己対戦を行い、各意思決定ステップを LearnerExample として収集する。
 *
 * Gen-3-K1a: MCTS の visit count を softmax 化して方策ターゲットに使う（AlphaZero 流）。
 * `awaitingGiftSelection` 等で MCTS を使わない step は one-hot にフォールバック。
 */
export function generateSelfPlayGame(options: SelfPlayOptions): LearnerExample[] {
  const examples: LearnerExample[] = [];
  let state: GameState = setupGame({
    seed: options.seed,
    playerNames: ['mcts-p0', 'mcts-p1', 'mcts-p2', 'mcts-p3'],
    cpuFlags: [true, true, true, true],
  });
  const maxSteps = options.maxSteps ?? 20000;
  const tau = options.policyTemperature ?? 1.0;
  const numPlayers = state.players.length;
  let steps = 0;

  // 各 step で actor / action_id / state を一旦バッファする
  interface PendingStep {
    actor: number;
    stateVec: Float32Array;
    actionId: number | null;
    info: MctsSearchInfo | null;
  }
  const pending: PendingStep[] = [];

  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    let action: Action | null = null;
    let info: MctsSearchInfo | null = null;
    if (state.phase === 'awaitingGiftSelection') {
      action = decideSmart(state, actor);
    } else {
      const r = decideMctsWithInfo(state, actor);
      action = r.action;
      info = r.info;
    }
    if (!action) break;

    const actionId = actionToActionId(action, state);
    // 行動 ID 化できた step のみ学習サンプルとして記録
    if (actionId !== null) {
      const stateVec = Float32Array.from(encodeState(state, actor));
      pending.push({ actor, stateVec, actionId, info });
    }

    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }

  const ranking = computeRanking(state);
  const finalValuePerPlayer = new Float32Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    finalValuePerPlayer[p] = rankToValue(ranking[p], numPlayers);
  }
  for (const p of pending) {
    let policyTarget: Float32Array;
    if (p.info) {
      policyTarget = visitsToPolicy(p.info.visits, tau);
    } else {
      policyTarget = new Float32Array(ACTION_SPACE_SIZE);
      if (p.actionId !== null) policyTarget[p.actionId] = 1.0;
    }
    examples.push({
      state: p.stateVec,
      policyTarget,
      valueTarget: new Float32Array(finalValuePerPlayer),
      actor: p.actor,
      recordedActionId: p.actionId,
    });
  }

  return examples;
}

/**
 * Gen-3-K2: ネットワーク誘導 MCTS（neuralMcts）で自己対戦する。
 * 学習済みモデルが prior + leaf 評価に使われるため、AlphaZero 流の「自己改善ループ」になる。
 */
export function generateSelfPlayGameWithModel(
  options: SelfPlayOptions & { model: MeteoAzModel }
): LearnerExample[] {
  const examples: LearnerExample[] = [];
  let state: GameState = setupGame({
    seed: options.seed,
    playerNames: ['neural-p0', 'neural-p1', 'neural-p2', 'neural-p3'],
    cpuFlags: [true, true, true, true],
  });
  const maxSteps = options.maxSteps ?? 20000;
  const tau = options.policyTemperature ?? 1.0;
  const numPlayers = state.players.length;
  let steps = 0;

  interface PendingStep {
    actor: number;
    stateVec: Float32Array;
    actionId: number | null;
    visits: Int32Array | null;
  }
  const pending: PendingStep[] = [];

  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    let action: Action | null = null;
    let visits: Int32Array | null = null;
    if (state.phase === 'awaitingGiftSelection') {
      action = decideSmart(state, actor);
    } else {
      const r = decideActionNeural(state, actor, options.model, undefined, {
        batchSize: options.mctsBatchSize,
        useHeuristicValue: options.useHeuristicValue,
      });
      action = r.action;
      // totalVisits == 0 のときは「決定論的 1 択 or 委譲」なので学習に使わない
      visits = r.totalVisits > 0 ? r.visits : null;
    }
    if (!action) break;

    const actionId = actionToActionId(action, state);
    if (actionId !== null) {
      const stateVec = Float32Array.from(encodeState(state, actor));
      pending.push({ actor, stateVec, actionId, visits });
    }

    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }

  const ranking = computeRanking(state);
  const finalValuePerPlayer = new Float32Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    finalValuePerPlayer[p] = rankToValue(ranking[p], numPlayers);
  }
  for (const p of pending) {
    let policyTarget: Float32Array;
    if (p.visits) {
      policyTarget = visitsToPolicy(p.visits, tau);
    } else {
      policyTarget = new Float32Array(ACTION_SPACE_SIZE);
      if (p.actionId !== null) policyTarget[p.actionId] = 1.0;
    }
    examples.push({
      state: p.stateVec,
      policyTarget,
      valueTarget: new Float32Array(finalValuePerPlayer),
      actor: p.actor,
      recordedActionId: p.actionId,
    });
  }

  return examples;
}

export function generateDatasetWithModel(
  seedBase: number,
  numGames: number,
  model: MeteoAzModel,
  policyTemperature = 1.0,
  mctsBatchSize = 1,
  useHeuristicValue = false
): LearnerExample[] {
  const all: LearnerExample[] = [];
  for (let g = 0; g < numGames; g++) {
    const ex = generateSelfPlayGameWithModel({
      seed: seedBase + g,
      model,
      policyTemperature,
      mctsBatchSize,
      useHeuristicValue,
    });
    all.push(...ex);
  }
  return all;
}

/**
 * N 局生成して結合した examples を返す。
 */
export function generateDataset(seedBase: number, numGames: number): LearnerExample[] {
  const all: LearnerExample[] = [];
  for (let g = 0; g < numGames; g++) {
    const ex = generateSelfPlayGame({ seed: seedBase + g });
    all.push(...ex);
  }
  return all;
}

// ============================================================================
// Gen-3-K11: parallel self-play 用のデータセット生成
// 複数 game を同時並行で進めて、 各 step で全 active game の MCTS を
// 1 つの NN batch にまとめて推論する。 GPU 利用効率の向上が目的。
// ============================================================================

interface ParallelGameSlot {
  state: GameState;
  pending: Array<{
    actor: number;
    stateVec: Float32Array;
    actionId: number | null;
    visits: Int32Array | null;
  }>;
  steps: number;
  done: boolean;
}

function makeSlot(seed: number): ParallelGameSlot {
  return {
    state: setupGame({
      seed,
      playerNames: ['neural-p0', 'neural-p1', 'neural-p2', 'neural-p3'],
      cpuFlags: [true, true, true, true],
    }),
    pending: [],
    steps: 0,
    done: false,
  };
}

function applyActionToSlot(
  slot: ParallelGameSlot,
  action: Action | null,
  actor: number,
  visits: Int32Array | null,
  maxSteps: number
): void {
  if (!action) {
    slot.done = true;
    return;
  }
  const actionId = actionToActionId(action, slot.state);
  if (actionId !== null) {
    const stateVec = Float32Array.from(encodeState(slot.state, actor));
    slot.pending.push({ actor, stateVec, actionId, visits });
  }
  const before = slot.state;
  slot.state = stepGame(slot.state, action);
  slot.steps++;
  if (slot.state === before || slot.steps >= maxSteps) slot.done = true;
  if (slot.state.phase === 'gameOver') slot.done = true;
}

function finalizeSlot(
  slot: ParallelGameSlot,
  tau: number,
  out: LearnerExample[]
): void {
  const numPlayers = slot.state.players.length;
  const ranking = computeRanking(slot.state);
  const finalValuePerPlayer = new Float32Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    finalValuePerPlayer[p] = rankToValue(ranking[p], numPlayers);
  }
  for (const p of slot.pending) {
    let policyTarget: Float32Array;
    if (p.visits) {
      policyTarget = visitsToPolicy(p.visits, tau);
    } else {
      policyTarget = new Float32Array(ACTION_SPACE_SIZE);
      if (p.actionId !== null) policyTarget[p.actionId] = 1.0;
    }
    out.push({
      state: p.stateVec,
      policyTarget,
      valueTarget: new Float32Array(finalValuePerPlayer),
      actor: p.actor,
      recordedActionId: p.actionId,
    });
  }
}

/**
 * Gen-3-K11: 並列 self-play でデータセットを生成する。
 *
 * `parallelGames` 個の game を同時並行で進める rolling 方式:
 *   - 同時に最大 parallelGames 個の game を進行
 *   - 各 step で active な全 game の next action を 1 つの NN batch で同時決定
 *   - gameOver になった slot は即 finalize + 次の game seed を投入
 *   - 全 numGames を処理したら終わり
 *
 * 利点: 1 batch のサンプル数が（並列数）に近づき、 GPU の PCIe 転送オーバーヘッドが
 * 分散される。 mcts-batch=16 の sequential と比べて、 batch サイズ N×16 級にできる。
 *
 * Note: `mctsBatchSize` パラメータは並列実装では使わない（並列度で吸収される）。
 */
export function generateDatasetParallel(
  seedBase: number,
  numGames: number,
  parallelGames: number,
  model: MeteoAzModel,
  policyTemperature = 1.0,
  mctsBatchSize = 16
): LearnerExample[] {
  if (parallelGames < 2) {
    // 並列度 1 以下なら従来の sequential 実装に委譲
    return generateDatasetWithModel(
      seedBase,
      numGames,
      model,
      policyTemperature,
      mctsBatchSize
    );
  }
  const all: LearnerExample[] = [];
  const maxSteps = 20000;
  const tau = policyTemperature;

  let nextSeed = seedBase;
  let openedGames = 0;
  const slotCount = Math.min(parallelGames, numGames);
  const slots: Array<ParallelGameSlot | null> = new Array(slotCount).fill(null);
  for (let i = 0; i < slotCount; i++) {
    slots[i] = makeSlot(nextSeed++);
    openedGames++;
  }

  while (slots.some((s) => s !== null)) {
    // 1. 各 active slot について next action を集める。
    //    awaitingGiftSelection は smart で個別決定、 それ以外は neural parallel。
    const giftRequests: Array<{ slotIdx: number; state: GameState; actor: number }> = [];
    const neuralRequests: Array<{ slotIdx: number; state: GameState; actor: number }> = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || slot.done) continue;
      const actor = currentActorId(slot.state);
      if (slot.state.phase === 'awaitingGiftSelection') {
        giftRequests.push({ slotIdx: i, state: slot.state, actor });
      } else {
        neuralRequests.push({ slotIdx: i, state: slot.state, actor });
      }
    }

    // 2. gift requests は smart で即決定
    for (const req of giftRequests) {
      const action = decideSmart(req.state, req.actor);
      applyActionToSlot(slots[req.slotIdx]!, action, req.actor, null, maxSteps);
    }

    // 3. neural requests は 1 batch で同時決定
    if (neuralRequests.length > 0) {
      const results = decideActionNeuralParallel(
        neuralRequests.map((inp) => ({ state: inp.state, playerId: inp.actor })),
        model,
        { batchSize: mctsBatchSize }
      );
      for (let i = 0; i < neuralRequests.length; i++) {
        const req = neuralRequests[i];
        const r = results[i];
        const visits = r.totalVisits > 0 ? r.visits : null;
        applyActionToSlot(slots[req.slotIdx]!, r.action, req.actor, visits, maxSteps);
      }
    }

    // 4. 完了した slot を finalize + 次の game を投入
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      if (slot.done) {
        finalizeSlot(slot, tau, all);
        if (openedGames < numGames) {
          slots[i] = makeSlot(nextSeed++);
          openedGames++;
        } else {
          slots[i] = null;
        }
      }
    }
  }

  return all;
}
