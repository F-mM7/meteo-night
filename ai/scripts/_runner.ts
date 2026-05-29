import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';
import { decideAction as decideMcts, type MctsOptions } from '../../src/ai/mctsAI';
import { decideAction as decideChainRush } from '../../src/ai/chainRushAI';
import type { EvalWeights } from '../../src/ai/evaluator';
import { GEN_3B_WEIGHTS } from '../../src/ai/tunedWeights';

export type StrategyName =
  | 'random'
  | 'smart'
  | 'mcts'
  | 'mctsRollout'
  | 'mctsPuct'
  | 'mctsTuned'
  | 'chainRush';

export type Decider = (state: GameState, playerId: number) => Action | null;

const decideMctsRollout: Decider = (state, playerId) =>
  decideMcts(state, playerId, undefined, { leafEval: 'rollout', iterations: 100 });

// Gen-3-C で不採用となった PUCT 版（progressive bias）。比較・再挑戦用に保持。
const decideMctsPuct: Decider = (state, playerId) =>
  decideMcts(state, playerId, undefined, { progressiveBias: true });

/**
 * Gen-3-B の tuned weights を **AI 内部に直接渡す** 形で動かす mcts。
 * Gen-3-J 以降は global state を使わず、options.weights で渡せるので副作用なし。
 */
const decideMctsTuned: Decider = (state, playerId) =>
  decideMcts(state, playerId, undefined, { weights: GEN_3B_WEIGHTS });

/**
 * 任意の重みで動く mcts decider を生成するファクトリ。
 * Gen-3-J 用：学習中の重みを動的に差し替えながらベンチを取りたいときに使う。
 * 対戦相手の smart 等は global default 重みのまま動くので、学習中の mcts と比較できる。
 */
export function makeMctsWithWeights(weights: EvalWeights): Decider {
  return (state, playerId) =>
    decideMcts(state, playerId, undefined, { weights });
}

/**
 * 任意の MctsOptions（uctC / leafEvalScale / weights 等）で動く mcts decider。
 * Gen-3-L 用：探索ハイパラの grid search で 1 ファクトリ呼びだけで切替えるためのもの。
 */
export function makeMctsWithOpts(opts: MctsOptions): Decider {
  return (state, playerId) => decideMcts(state, playerId, undefined, opts);
}

export const STRATEGIES: Record<StrategyName, Decider> = {
  random: decideRandom,
  smart: decideSmart,
  mcts: decideMcts,
  mctsRollout: decideMctsRollout,
  mctsPuct: decideMctsPuct,
  mctsTuned: decideMctsTuned,
  chainRush: decideChainRush,
};

export function isStrategyName(s: string): s is StrategyName {
  return s in STRATEGIES;
}

export interface GameResult {
  seed: number;
  winnerId: number | null;
  scores: number[];
  ranking: number[]; // ranking[playerId] = 0(=1位) .. 3(=4位)
  turns: number;
  steps: number;
  durationMs: number;
  finished: boolean; // gameOver に到達したか（max-steps で打ち切られたら false）
}

export function currentActorId(state: GameState): number {
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

export interface PlayOneGameOptions {
  seed: number;
  strategies: StrategyName[];
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 20000;

export function playOneGame({
  seed,
  strategies,
  maxSteps = DEFAULT_MAX_STEPS,
}: PlayOneGameOptions): GameResult {
  if (strategies.length !== 4) {
    throw new Error(`strategies must have 4 entries, got ${strategies.length}`);
  }
  return playOneGameWithDeciders({
    seed,
    deciders: strategies.map((s) => STRATEGIES[s]),
    names: strategies.map((s, i) => `P${i}-${s}`),
    maxSteps,
  });
}

/**
 * Gen-3-X: 任意の Decider 4 つを直接対戦させる。
 * `makeMctsWithWeights` 等で作った「候補重みの mcts」 と「baseline mcts」 を直接戦わせ、
 * smart 非依存で相対強度を測るために使う（vs smart は評価関数の盲点を共有して検出不能なため）。
 */
export function playOneGameWithDeciders({
  seed,
  deciders,
  names,
  maxSteps = DEFAULT_MAX_STEPS,
}: {
  seed: number;
  deciders: Decider[];
  names?: string[];
  maxSteps?: number;
}): GameResult {
  if (deciders.length !== 4) {
    throw new Error(`deciders must have 4 entries, got ${deciders.length}`);
  }
  const t0 = Date.now();
  let state: GameState = setupGame({
    seed,
    playerNames: names ?? deciders.map((_, i) => `P${i}`),
    cpuFlags: deciders.map(() => true),
  });

  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actorId = currentActorId(state);
    const decider = deciders[actorId];
    const action = decider(state, actorId);
    if (!action) {
      break;
    }
    const before = state;
    state = stepGame(state, action);
    if (state === before) {
      break;
    }
    steps++;
  }

  return {
    seed,
    winnerId: state.winnerId,
    scores: state.players.map((p) => p.score),
    ranking: computeRanking(state),
    turns: state.turnNumber,
    steps,
    durationMs: Date.now() - t0,
    finished: state.phase === 'gameOver',
  };
}

/**
 * 数値オプション（整数）を安全にパースする。
 * `Number(argv[++i])` の素朴な実装だと `--games abc` や値忘れ `--games`（次が undefined）
 * が `NaN` になり、ループ回数 0 等で正常終了したように見えてしまうため、
 * 不正値・整数でない値・値忘れは throw する。
 */
export function parseIntArg(name: string, raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error(`${name} requires a value`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`${name} requires a finite integer, got: ${raw}`);
  }
  return v;
}

/**
 * 数値オプション（実数）を安全にパースする。`parseIntArg` の浮動小数点版。
 */
export function parseFloatArg(name: string, raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error(`${name} requires a value`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new Error(`${name} requires a finite number, got: ${raw}`);
  }
  return v;
}

export interface CommonArgs {
  games: number;
  strategies: StrategyName[];
  seed: number;
  rotate: boolean;
  silent: boolean;
  json: boolean;
  maxSteps: number;
}

export function parseCommonArgs(argv: string[], defaults: Partial<CommonArgs> = {}): CommonArgs {
  const out: CommonArgs = {
    games: defaults.games ?? 10,
    strategies: defaults.strategies ?? ['smart', 'smart', 'smart', 'smart'],
    seed: defaults.seed ?? 42,
    rotate: defaults.rotate ?? false,
    silent: defaults.silent ?? false,
    json: defaults.json ?? false,
    maxSteps: defaults.maxSteps ?? DEFAULT_MAX_STEPS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--games':
        out.games = parseIntArg('--games', argv[++i]);
        break;
      case '--strategies': {
        const raw = argv[++i];
        if (raw === undefined) {
          throw new Error('--strategies requires a value');
        }
        const list = raw.split(',');
        if (list.length !== 4) {
          throw new Error('--strategies must have 4 comma-separated entries');
        }
        for (const s of list) {
          if (!isStrategyName(s)) {
            throw new Error(`unknown strategy: ${s}`);
          }
        }
        out.strategies = list as StrategyName[];
        break;
      }
      case '--seed':
        out.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--rotate':
        out.rotate = true;
        break;
      case '--silent':
        out.silent = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--max-steps':
        out.maxSteps = parseIntArg('--max-steps', argv[++i]);
        break;
      case '--help':
      case '-h':
        return out;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

export function rotateSeats<T>(arr: T[], n: number): T[] {
  const len = arr.length;
  return arr.map((_, i) => arr[(i + n) % len]);
}
