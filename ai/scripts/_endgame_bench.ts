/**
 * _endgame_bench ― 仮説 A（終盤適応先読み）/ B（思考予算引き上げ）の評価。
 *
 * 候補 1 席 vs 現状最強 tempoFast(LA=1, budget=1000, DEFAULT 重み) 3 席（rotate, 公平 25%, Wilson CI）。
 * 候補は --cand-ai で切替:
 *   - endgame: tempoEndgame（通常 LA=1、最大スコア >= --endgame-threshold で LA=--endgame-la）
 *   - tempo  : tempoFast(LA=1) を --cand-budget の予算で（B の予算検証用）
 *
 * 例:
 *   # A: 終盤(>=15)だけ LA=2、予算は配信と同じ 1000ms
 *   npx tsx ai/scripts/_endgame_bench.ts --cand-ai endgame --endgame-threshold 15 --endgame-la 2 --games 50 --seed 81001
 *   # B: LA=1 のまま予算を 2000ms に
 *   npx tsx ai/scripts/_endgame_bench.ts --cand-ai tempo --cand-budget 2000 --games 50 --seed 82001
 */
import { playOneGameWithDeciders, parseIntArg, type Decider } from './_runner';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { decideAction as decideTempoEndgame } from '../../src/ai/tempoEndgameAI';
import { DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { wilsonInterval } from './stats';

const BASE_BUDGET = 1000;
const BASE_LOOKAHEAD = 1;

interface Args {
  candAi: 'endgame' | 'tempo';
  endgameThreshold: number;
  endgameLa: number;
  candBudget: number;
  candLookahead: number;
  games: number;
  seed: number;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    candAi: 'endgame',
    endgameThreshold: 15,
    endgameLa: 2,
    candBudget: BASE_BUDGET,
    candLookahead: BASE_LOOKAHEAD,
    games: 50,
    seed: 81001,
    maxSteps: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--cand-ai': {
        const v = argv[++i];
        if (v !== 'endgame' && v !== 'tempo') throw new Error(`--cand-ai must be endgame|tempo, got ${v}`);
        a.candAi = v;
        break;
      }
      case '--endgame-threshold': a.endgameThreshold = parseIntArg('--endgame-threshold', argv[++i]); break;
      case '--endgame-la': a.endgameLa = parseIntArg('--endgame-la', argv[++i]); break;
      case '--cand-budget': a.candBudget = parseIntArg('--cand-budget', argv[++i]); break;
      case '--cand-lookahead': a.candLookahead = parseIntArg('--cand-lookahead', argv[++i]); break;
      case '--games': a.games = parseIntArg('--games', argv[++i]); break;
      case '--seed': a.seed = parseIntArg('--seed', argv[++i]); break;
      case '--max-steps': a.maxSteps = parseIntArg('--max-steps', argv[++i]); break;
      default: throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const baseline: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, {
      weights: DEFAULT_WEIGHTS,
      lookaheadTurns: BASE_LOOKAHEAD,
      timeBudgetMs: BASE_BUDGET,
    });

  let candidate: Decider;
  let candDesc: string;
  if (args.candAi === 'endgame') {
    candidate = (s, pid) =>
      decideTempoEndgame(s, pid, undefined, {
        weights: DEFAULT_WEIGHTS,
        lookaheadTurns: args.candLookahead,
        timeBudgetMs: args.candBudget,
        endgameScoreThreshold: args.endgameThreshold,
        endgameLookahead: args.endgameLa,
      });
    candDesc = `tempoEndgame(base LA=${args.candLookahead}, 終盤>=${args.endgameThreshold}→LA=${args.endgameLa}, budget=${args.candBudget})`;
  } else {
    candidate = (s, pid) =>
      decideTempoFast(s, pid, undefined, {
        weights: DEFAULT_WEIGHTS,
        lookaheadTurns: args.candLookahead,
        timeBudgetMs: args.candBudget,
      });
    candDesc = `tempoFast(LA=${args.candLookahead}, budget=${args.candBudget})`;
  }

  console.error(
    `[endgame] cand=${candDesc} vs base=tempoFast(LA=${BASE_LOOKAHEAD}, budget=${BASE_BUDGET}) | games=${args.games} seed=${args.seed}`
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
    const names = [0, 1, 2, 3].map((s) => (s === candSeat ? 'cand' : 'base'));
    const r = playOneGameWithDeciders({ seed: args.seed + g, deciders, names, maxSteps: args.maxSteps });
    if (r.ranking[candSeat] === 0) candWins++;
    candRankCount[r.ranking[candSeat]]++;
    candScoreSum += r.scores[candSeat];
    for (let s = 0; s < 4; s++) if (s !== candSeat) baseScoreSum += r.scores[s];
    if (!r.finished) unfinished++;
  }

  const winRate = candWins / args.games;
  const ci = wilsonInterval(candWins, args.games);
  const out = {
    candAi: args.candAi,
    candDesc,
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
    ci.low > 0.25 ? '✅ 候補が有意に強い' : ci.high < 0.25 ? '❌ 候補が有意に弱い' : '― 有意差なし (parity)';
  console.error(
    `\ncand winrate ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs base (公平 25%) -> ${verdict}`
  );
}

main();
