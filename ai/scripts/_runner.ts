import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideRandom } from '../../src/ai/randomAI';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { setEvalWeights, DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { GEN_3B_WEIGHTS } from '../../src/ai/tunedWeights';

export type StrategyName =
  | 'random'
  | 'smart'
  | 'mcts'
  | 'mctsRollout'
  | 'mctsPuct'
  | 'mctsTuned';

export type Decider = (state: GameState, playerId: number) => Action | null;

const decideMctsRollout: Decider = (state, playerId) =>
  decideMcts(state, playerId, undefined, { leafEval: 'rollout', iterations: 100 });

// Gen-3-C で不採用となった PUCT 版（progressive bias）。比較・再挑戦用に保持。
const decideMctsPuct: Decider = (state, playerId) =>
  decideMcts(state, playerId, undefined, { progressiveBias: true });

/**
 * Gen-3-B で採用された tuned weights を、決定の前後で set/reset する mcts。
 * Note: setEvalWeights はモジュール global state を変えるため、
 * 同一ベンチ内で他の戦略にも影響しうる。`--weights` フラグでベンチ全体を
 * 統一する方が望ましい。本ラッパーは「他の戦略は default のままで、
 * mcts だけ tuned で動く」状況の再現用。
 */
const decideMctsTuned: Decider = (state, playerId) => {
  setEvalWeights(GEN_3B_WEIGHTS);
  const action = decideMcts(state, playerId);
  setEvalWeights(DEFAULT_WEIGHTS);
  return action;
};

export const STRATEGIES: Record<StrategyName, Decider> = {
  random: decideRandom,
  smart: decideSmart,
  mcts: decideMcts,
  mctsRollout: decideMctsRollout,
  mctsPuct: decideMctsPuct,
  mctsTuned: decideMctsTuned,
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
  const t0 = Date.now();
  let state: GameState = setupGame({
    seed,
    playerNames: strategies.map((s, i) => `P${i}-${s}`),
    cpuFlags: strategies.map(() => true),
  });

  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actorId = currentActorId(state);
    const strat = strategies[actorId];
    const decider = STRATEGIES[strat];
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
        out.games = Number(argv[++i]);
        break;
      case '--strategies': {
        const list = argv[++i].split(',');
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
        out.seed = Number(argv[++i]);
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
        out.maxSteps = Number(argv[++i]);
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
