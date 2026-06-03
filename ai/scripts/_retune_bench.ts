/**
 * _retune_bench ― ルール変更（山札 24/色=120枚化）後の評価重み/tempoChainW 再調整用。
 *
 * 候補 tempoFast(weights=DEFAULT+override, tempoChainW=cand) vs baseline tempoFast(DEFAULT, chainW=50)。
 * 両者とも同 lookahead/budget。1 席 vs 3 席 rotate、公平基準 0.25、Wilson 95% CI。葉の最適化なので
 * screen は高速設定（--lookahead 0 --budget 40）で広く、確証は実配信（--lookahead 1 --budget 1000）で。
 *
 * 例:
 *   npx tsx ai/scripts/_retune_bench.ts --cand-chain-w 70 --lookahead 0 --budget 40 --games 100 --seed 71001
 *   npx tsx ai/scripts/_retune_bench.ts --cand-weights '{"chainReadyMult":20}' --lookahead 0 --budget 40 --games 100 --seed 71001
 */
import { playOneGameWithDeciders, parseIntArg, parseFloatArg, type Decider } from './_runner';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { wilsonInterval } from './stats';

interface Args {
  candOverride: Partial<EvalWeights>;
  candChainW: number;
  lookahead: number;
  budget: number;
  games: number;
  seed: number;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    candOverride: {},
    candChainW: 50,
    lookahead: 0,
    budget: 40,
    games: 100,
    seed: 71001,
    maxSteps: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--cand-weights': a.candOverride = JSON.parse(argv[++i] ?? '{}'); break;
      case '--cand-chain-w': a.candChainW = parseFloatArg('--cand-chain-w', argv[++i]); break;
      case '--lookahead': a.lookahead = parseIntArg('--lookahead', argv[++i]); break;
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
  const candWeights: EvalWeights = { ...DEFAULT_WEIGHTS, ...args.candOverride };
  const candidate: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, {
      weights: candWeights,
      tempoChainW: args.candChainW,
      lookaheadTurns: args.lookahead,
      timeBudgetMs: args.budget,
    });
  const baseline: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, {
      weights: DEFAULT_WEIGHTS,
      tempoChainW: 50,
      lookaheadTurns: args.lookahead,
      timeBudgetMs: args.budget,
    });

  console.error(
    `[retune] cand=tempoFast(chainW=${args.candChainW}, override=${JSON.stringify(args.candOverride)}) vs base=tempoFast(chainW=50, DEFAULT) | LA=${args.lookahead} budget=${args.budget} games=${args.games} seed=${args.seed}`
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
    candOverride: args.candOverride,
    candChainW: args.candChainW,
    lookahead: args.lookahead,
    budgetMs: args.budget,
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
