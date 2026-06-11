/**
 * _la_chain_bench ― tempoChainLA（1 ターン先読み付き tempoChain）の強さ計測。
 *
 * 候補 = tempoChainLA(DEFAULT_GENOME + LA オプション) を 1 席、baseline を 3 席、
 * 席回転（candSeat = g % 4, 公平基準 25%）で対戦させる。grid/confirm と同じ物差し
 * （smart 非依存・Wilson 95%CI）。候補 1 手あたりのレイテンシ（max/p50/p99）も併せて測る。
 *
 * baseline:
 *   --base chain : tempoChain(DEFAULT_GENOME) ＝ 現 champion（Gen-15）
 *   --base fast  : tempoFast(lookaheadTurns=--base-la, timeBudgetMs=--budget) ＝ 旧 champion 系
 *
 * 例:
 *   # スクリーニング（vs 現 champion）
 *   npx tsx ai/scripts/_la_chain_bench.ts --base chain --games 96 --seed 41001
 *   # 実体旧 champion（LA=1, budget1000）との確証
 *   npx tsx ai/scripts/_la_chain_bench.ts --base fast --base-la 1 --budget 1000 --games 300 --seed 43001
 *   # 発火候補なしの ablation（laSubFireMin を事実上 ∞ に）
 *   npx tsx ai/scripts/_la_chain_bench.ts --base chain --games 96 --seed 41001 --subfire-min 99
 */
import { playOneGameWithDeciders, parseIntArg, type Decider } from './_runner';
import { decideAction as decideLa, type TempoChainLaParams } from '../../src/ai/tempoChainLaAI';
import { decideAction as decideTempoChain } from '../../src/ai/tempoChainAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { wilsonInterval } from './stats';

interface Args {
  games: number;
  seed: number;
  base: 'chain' | 'fast';
  baseLA: number;
  budget: number;
  laCandidates: number;
  subFireMin: number;
  laBudget: number;
  laSamples: number;
  maxSteps: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    games: 96,
    seed: 41001,
    base: 'chain',
    baseLA: 1,
    budget: 1000,
    laCandidates: 6,
    subFireMin: 99,
    laBudget: 1000,
    laSamples: 1,
    maxSteps: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--games':
        a.games = parseIntArg('--games', argv[++i]);
        break;
      case '--seed':
        a.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--base': {
        const v = argv[++i];
        if (v !== 'chain' && v !== 'fast') throw new Error('--base requires: chain|fast');
        a.base = v;
        break;
      }
      case '--base-la':
        a.baseLA = parseIntArg('--base-la', argv[++i]);
        break;
      case '--budget':
        a.budget = parseIntArg('--budget', argv[++i]);
        break;
      case '--la-candidates':
        a.laCandidates = parseIntArg('--la-candidates', argv[++i]);
        break;
      case '--subfire-min':
        a.subFireMin = parseIntArg('--subfire-min', argv[++i]);
        break;
      case '--la-budget':
        a.laBudget = parseIntArg('--la-budget', argv[++i]);
        break;
      case '--la-samples':
        a.laSamples = parseIntArg('--la-samples', argv[++i]);
        break;
      case '--max-steps':
        a.maxSteps = parseIntArg('--max-steps', argv[++i]);
        break;
      default:
        throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const laParams: TempoChainLaParams = {
    laCandidates: args.laCandidates,
    laSubFireMin: args.subFireMin,
    laTimeBudgetMs: args.laBudget,
    laAdvanceSamples: args.laSamples,
  };
  const baseName =
    args.base === 'chain' ? 'tempoChain(DEFAULT_GENOME)' : `tempoFast(LA=${args.baseLA}, budget=${args.budget})`;
  console.error(
    `[la-chain-bench] tempoChainLA(K=${args.laCandidates}, subFireMin=${args.subFireMin}, laBudget=${args.laBudget}, samples=${args.laSamples}) vs ${baseName} | games=${args.games} seed=${args.seed} (候補1席 vs baseline 3席, rotate)`
  );

  const base: Decider =
    args.base === 'chain'
      ? (s, p) => decideTempoChain(s, p)
      : (s, p) => decideTempoFast(s, p, undefined, { timeBudgetMs: args.budget, lookaheadTurns: args.baseLA });

  const latencies: number[] = [];
  const candidate: Decider = (s, p) => {
    const t0 = Date.now();
    const a = decideLa(s, p, undefined, laParams);
    latencies.push(Date.now() - t0);
    return a;
  };

  let wins = 0;
  let candScoreSum = 0;
  let baseScoreSum = 0;
  const rankCount = [0, 0, 0, 0];
  let unfinished = 0;
  const t0 = Date.now();

  for (let g = 0; g < args.games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : base));
    const names = [0, 1, 2, 3].map((s) => (s === candSeat ? 'la' : 'base'));
    const r = playOneGameWithDeciders({ seed: args.seed + g, deciders, names, maxSteps: args.maxSteps });
    if (r.ranking[candSeat] === 0) wins++;
    rankCount[r.ranking[candSeat]]++;
    candScoreSum += r.scores[candSeat];
    for (let s = 0; s < 4; s++) if (s !== candSeat) baseScoreSum += r.scores[s];
    if (!r.finished) unfinished++;
    if ((g + 1) % 8 === 0) {
      console.error(`  ${g + 1}/${args.games} done, wins=${wins}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const ci = wilsonInterval(wins, args.games);
  latencies.sort((a, b) => a - b);
  const res = {
    games: args.games,
    seed: args.seed,
    base: baseName,
    laParams,
    wins,
    winRate: +(wins / args.games).toFixed(4),
    fairBaseline: 0.25,
    winRateCI95: { low: +ci.low.toFixed(4), high: +ci.high.toFixed(4) },
    candAvgScore: +(candScoreSum / args.games).toFixed(2),
    baseAvgScore: +(baseScoreSum / (args.games * 3)).toFixed(2),
    candRankDist: rankCount,
    unfinishedGames: unfinished,
    latencyMs: {
      n: latencies.length,
      p50: percentile(latencies, 0.5),
      p99: percentile(latencies, 0.99),
      max: latencies[latencies.length - 1] ?? 0,
    },
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  console.log(JSON.stringify(res, null, 2));

  const verdict = ci.low > 0.25 ? '✅ 有意に強い' : ci.high < 0.25 ? '❌ 有意に弱い' : '― 有意差なし';
  console.error(
    `\ntempoChainLA 勝率 ${((wins / args.games) * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs 公平基準 25% → ${verdict} | latency p50=${res.latencyMs.p50}ms p99=${res.latencyMs.p99}ms max=${res.latencyMs.max}ms`
  );
}

main();
