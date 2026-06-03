/**
 * _strong_bench ― 「とにかく強い探索」（レイテンシ無制約）を現状最強 tempoFast(LA=1,budget1000) と対戦。
 *
 * 候補 1 席 vs 現状最強 3 席（rotate, 公平 25%, Wilson CI）。候補は --cand で切替:
 *   - mcts : mctsAI を --iter 反復で（計算を増やせば tempo を超えるかの診断）
 *   - tempo: tempoFast を --la / --opp / --budget で（深い先読み＋強い相手モデルの診断）
 *
 * 例:
 *   npx tsx ai/scripts/_strong_bench.ts --cand mcts --iter 8000 --games 40 --seed 96001
 *   npx tsx ai/scripts/_strong_bench.ts --cand tempo --la 2 --opp tempo --budget 4000 --games 24 --seed 97001
 */
import { playOneGameWithDeciders, parseIntArg, type Decider } from './_runner';
import { decideAction as decideTempoFast, type OpponentModel } from '../../src/ai/tempoFastAI';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { wilsonInterval } from './stats';

const BASE_BUDGET = 1000;
const BASE_LA = 1;

interface Args {
  cand: 'mcts' | 'tempo';
  iter: number;
  la: number;
  opp: OpponentModel;
  budget: number;
  games: number;
  seed: number;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cand: 'mcts', iter: 8000, la: 2, opp: 'tempo', budget: 4000, games: 40, seed: 96001, maxSteps: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--cand': {
        const v = argv[++i];
        if (v !== 'mcts' && v !== 'tempo') throw new Error(`--cand must be mcts|tempo`);
        a.cand = v; break;
      }
      case '--iter': a.iter = parseIntArg('--iter', argv[++i]); break;
      case '--la': a.la = parseIntArg('--la', argv[++i]); break;
      case '--opp': {
        const v = argv[++i];
        if (v !== 'smart' && v !== 'mcts' && v !== 'tempo') throw new Error(`--opp must be smart|mcts|tempo`);
        a.opp = v; break;
      }
      case '--budget': a.budget = parseIntArg('--budget', argv[++i]); break;
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
    decideTempoFast(s, pid, undefined, { weights: DEFAULT_WEIGHTS, lookaheadTurns: BASE_LA, timeBudgetMs: BASE_BUDGET });

  let candidate: Decider;
  let candDesc: string;
  if (args.cand === 'mcts') {
    candidate = (s, pid) => decideMcts(s, pid, undefined, { iterations: args.iter, weights: DEFAULT_WEIGHTS });
    candDesc = `mcts(iter=${args.iter})`;
  } else {
    candidate = (s, pid) =>
      decideTempoFast(s, pid, undefined, { weights: DEFAULT_WEIGHTS, lookaheadTurns: args.la, opponentModel: args.opp, timeBudgetMs: args.budget });
    candDesc = `tempoFast(LA=${args.la}, opp=${args.opp}, budget=${args.budget})`;
  }

  console.error(`[strong] cand=${candDesc} vs base=tempoFast(LA=${BASE_LA}, budget=${BASE_BUDGET}) | games=${args.games} seed=${args.seed}`);

  let candWins = 0, candScoreSum = 0, baseScoreSum = 0, unfinished = 0;
  const candRankCount = [0, 0, 0, 0];
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
    if ((g + 1) % 8 === 0) console.error(`  ${g + 1}/${args.games} done, candWins=${candWins}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const winRate = candWins / args.games;
  const ci = wilsonInterval(candWins, args.games);
  const out = {
    candDesc, games: args.games, seed: args.seed, candWins,
    candWinRate: +winRate.toFixed(4), fairBaseline: 0.25,
    winRateCI95: { low: +ci.low.toFixed(4), high: +ci.high.toFixed(4) },
    candAvgScore: +(candScoreSum / args.games).toFixed(2),
    baseAvgScore: +(baseScoreSum / (args.games * 3)).toFixed(2),
    candRankDist: candRankCount, unfinishedGames: unfinished,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  console.log(JSON.stringify(out, null, 2));
  const verdict = ci.low > 0.25 ? '✅ 候補が有意に強い（現状最強を超えた）' : ci.high < 0.25 ? '❌ 候補が有意に弱い' : '― 有意差なし (parity)';
  console.error(`\ncand winrate ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs base (公平 25%) -> ${verdict}`);
}

main();
