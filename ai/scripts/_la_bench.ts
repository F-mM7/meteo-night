/**
 * _la_bench ― lookahead/相手モデルの強さ比較。候補 tempoFast vs baseline tempoFast を直接対戦。
 *
 * 候補 = tempoFast(timeBudgetMs=budget, lookaheadTurns=LA, opponentModel=opp) を 1 席、
 * baseline = tempoFast(timeBudgetMs=budget, lookaheadTurns=baseLA, opponentModel=baseOpp) を 3 席、
 * seat rotate で対戦。両者とも同 budget・bounded なので公平比較。公平基準 0.25、Wilson 95% CI。
 *
 * 例:
 *   # lookahead=1 vs lookahead=0（horizon が効くかの初検証）
 *   npx tsx ai/scripts/_la_bench.ts --budget 1000 --lookahead 1 --opp smart --games 150 --seed 31001
 *   # lookahead=2 が現採用 lookahead=1 を超えるか
 *   npx tsx ai/scripts/_la_bench.ts --budget 1000 --lookahead 2 --opp smart --base-lookahead 1 --base-opp smart --games 150 --seed 31001
 *   # 相手モデル tempo が opp=smart を超えるか
 *   npx tsx ai/scripts/_la_bench.ts --budget 1000 --lookahead 1 --opp tempo --base-lookahead 1 --base-opp smart --games 150 --seed 31001
 */
import { playOneGameWithDeciders, parseIntArg, type Decider } from './_runner';
import { decideAction as decideTempoFast, type OpponentModel } from '../../src/ai/tempoFastAI';
import { wilsonInterval } from './stats';

interface Args {
  budget: number;
  lookahead: number;
  opp: OpponentModel;
  baseLookahead: number;
  baseOpp: OpponentModel;
  games: number;
  seed: number;
  maxSteps: number;
}

function parseOpp(v: string | undefined): OpponentModel {
  if (v !== 'smart' && v !== 'mcts' && v !== 'tempo') throw new Error('opp requires: smart|mcts|tempo');
  return v;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    budget: 1000,
    lookahead: 1,
    opp: 'smart',
    baseLookahead: 0,
    baseOpp: 'smart',
    games: 150,
    seed: 31001,
    maxSteps: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--budget': a.budget = Number(argv[++i]); break;
      case '--lookahead': a.lookahead = Number(argv[++i]); break;
      case '--opp': a.opp = parseOpp(argv[++i]); break;
      case '--base-lookahead': a.baseLookahead = Number(argv[++i]); break;
      case '--base-opp': a.baseOpp = parseOpp(argv[++i]); break;
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
  const candidate: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, {
      tempoChainW: 50,
      timeBudgetMs: args.budget,
      lookaheadTurns: args.lookahead,
      opponentModel: args.opp,
    });
  const baseline: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, {
      tempoChainW: 50,
      timeBudgetMs: args.budget,
      lookaheadTurns: args.baseLookahead,
      opponentModel: args.baseOpp,
    });

  console.error(
    `[la-bench] cand=tempoFast(b=${args.budget},LA=${args.lookahead},opp=${args.opp}) vs base=tempoFast(b=${args.budget},LA=${args.baseLookahead},opp=${args.baseOpp}) | games=${args.games} seed=${args.seed} (1 席 vs 3 席 rotate)`
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
    budgetMs: args.budget,
    cand: { lookahead: args.lookahead, opp: args.opp },
    base: { lookahead: args.baseLookahead, opp: args.baseOpp },
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
