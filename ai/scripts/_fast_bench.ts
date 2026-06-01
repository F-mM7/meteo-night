/**
 * tempoFastAI の smart 非依存強度ベンチ。
 *
 * 候補 = tempoFastAI（1 席, rotate） vs baseline（3 席）。
 * baseline は --base で選択:
 *   tempo : 現状 tempoAI（makeTempoWithOpts({tempoChainW:50})） = 越えるべきバー
 *   mcts  : Gen-3-X mcts（decideMcts(s,p,undefined,{weights:DEFAULT_WEIGHTS})）
 *
 * 公平基準 0.25。 勝率 + Wilson CI を出力。
 *
 * 使い方:
 *   npx tsx ai/scripts/_fast_bench.ts --base tempo --budget 150 --games 48 --seed 31001
 *   npx tsx ai/scripts/_fast_bench.ts --base mcts  --budget 250 --lookahead 1 --opp mcts --games 150 --seed 32001
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { decideAction as decideTempo } from '../../src/ai/tempoAI';
import {
  decideAction as decideTempoFast,
  type OpponentModel,
} from '../../src/ai/tempoFastAI';
import { wilsonInterval } from './stats';

type Decider = (state: GameState, playerId: number) => Action | null;

function currentActorId(s: GameState): number {
  if (s.phase === 'awaitingGiftPlacement' && s.turn.pendingGiftBatches.length > 0) {
    return s.turn.pendingGiftBatches[0].recipientId;
  }
  return s.currentPlayerIndex;
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

interface Args {
  base: 'tempo' | 'mcts';
  budget: number;
  lookahead: number;
  opp: OpponentModel;
  oppMctsIter: number;
  maxPlaceDepth: number;
  games: number;
  seed: number;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    base: 'tempo',
    budget: 150,
    lookahead: 0,
    opp: 'smart',
    oppMctsIter: 120,
    maxPlaceDepth: 12,
    games: 48,
    seed: 31001,
    maxSteps: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--base': {
        const v = argv[++i];
        if (v !== 'tempo' && v !== 'mcts') throw new Error('--base: tempo | mcts');
        a.base = v;
        break;
      }
      case '--budget':
        a.budget = Number(argv[++i]);
        break;
      case '--lookahead':
        a.lookahead = Number(argv[++i]);
        break;
      case '--opp': {
        const v = argv[++i];
        if (v !== 'smart' && v !== 'mcts' && v !== 'tempo') throw new Error('--opp: smart|mcts|tempo');
        a.opp = v;
        break;
      }
      case '--opp-mcts-iter':
        a.oppMctsIter = Number(argv[++i]);
        break;
      case '--max-place-depth':
        a.maxPlaceDepth = Number(argv[++i]);
        break;
      case '--games':
        a.games = Number(argv[++i]);
        break;
      case '--seed':
        a.seed = Number(argv[++i]);
        break;
      case '--max-steps':
        a.maxSteps = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

function playGame(seed: number, deciders: Decider[], maxSteps: number): { ranking: number[]; scores: number[]; finished: boolean } {
  let state: GameState = setupGame({
    seed,
    playerNames: ['p0', 'p1', 'p2', 'p3'],
    cpuFlags: [true, true, true, true],
  });
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const action = deciders[actor](state, actor);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }
  return {
    ranking: computeRanking(state),
    scores: state.players.map((p) => p.score),
    finished: state.phase === 'gameOver',
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const candidate: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, {
      tempoChainW: 50,
      timeBudgetMs: args.budget,
      lookaheadTurns: args.lookahead,
      opponentModel: args.opp,
      opponentMctsIterations: args.oppMctsIter,
      maxPlaceDepth: args.maxPlaceDepth,
    });

  const baseline: Decider =
    args.base === 'tempo'
      ? (s, pid) => decideTempo(s, pid, undefined, { tempoChainW: 50 })
      : (s, pid) => decideMcts(s, pid, undefined, { weights: DEFAULT_WEIGHTS });

  console.error(
    `[fast-bench] cand=tempoFast(budget=${args.budget},LA=${args.lookahead},opp=${args.opp},mpd=${args.maxPlaceDepth}) vs base=${args.base} | games=${args.games} seed=${args.seed} (1 席 vs 3 席 rotate)`
  );

  let candWins = 0;
  let candScoreSum = 0;
  let baseScoreSum = 0;
  const candRankCount = [0, 0, 0, 0];
  let unfinished = 0;
  const t0 = Date.now();

  for (let g = 0; g < args.games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    const r = playGame(args.seed + g, deciders, args.maxSteps);
    if (r.ranking[candSeat] === 0) candWins++;
    candRankCount[r.ranking[candSeat]]++;
    candScoreSum += r.scores[candSeat];
    for (let s = 0; s < 4; s++) if (s !== candSeat) baseScoreSum += r.scores[s];
    if (!r.finished) unfinished++;
  }

  const winRate = candWins / args.games;
  const ci = wilsonInterval(candWins, args.games);
  const out = {
    base: args.base,
    budgetMs: args.budget,
    lookahead: args.lookahead,
    opponentModel: args.lookahead > 0 ? args.opp : 'n/a',
    maxPlaceDepth: args.maxPlaceDepth,
    games: args.games,
    seed: args.seed,
    candWins,
    candWinRate: +winRate.toFixed(4),
    fairBaseline: 0.25,
    winRateCI95: { low: +ci.low.toFixed(4), high: +ci.high.toFixed(4) },
    candAvgScore: +(candScoreSum / args.games).toFixed(2),
    baseAvgScore: +(baseScoreSum / (args.games * 3)).toFixed(2),
    candRankDist: candRankCount,
    unfinishedGames: unfinished,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  console.log(JSON.stringify(out, null, 2));
  const verdict =
    ci.low > 0.25 ? 'cand significantly STRONGER' : ci.high < 0.25 ? 'cand significantly WEAKER' : 'no significant diff (parity)';
  console.error(
    `\ncand winrate ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs fair 25% -> ${verdict}`
  );
}

main();
