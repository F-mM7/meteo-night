/**
 * _grm_latency_probe ― GRM の 1 手あたりレイテンシ分布を実対局で測る（配信判定の材料）。
 *
 * GRM 1 席 vs tempoChain(DEFAULT_GENOME) 3 席で数ゲーム回し、GRM の decideAction の
 * 壁時計時間（p50/p90/p99/max）とフェーズ別の重い順を出す。baseline が ms 級なので
 * ゲーム全体がほぼ GRM の思考時間になる構成で測る。
 *
 * 例: npx tsx ai/scripts/_grm_latency_probe.ts --games 4 --seed 9001 --P 0.5
 */
import { playOneGameWithDeciders, parseIntArg, parseFloatArg, type Decider } from './_runner';
import { decideAction as decideGrm, budgetStats, type GrmOptions } from '../../src/ai/grmAI';
import { decideAction as decideTempoChain } from '../../src/ai/tempoChainAI';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function main(): void {
  let games = 4;
  let seed = 9001;
  let P = 0.5;
  let budget = 0; // 0 = 無制限
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--P') P = parseFloatArg('--P', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const grmOptions: GrmOptions = { V: 20, P, H: 1, K: 6 };
  if (budget > 0) grmOptions.timeBudgetMs = budget;

  const latByPhase = new Map<string, number[]>();
  const all: number[] = [];
  const grm: Decider = (s, p) => {
    const t0 = Date.now();
    const a = decideGrm(s, p, undefined, grmOptions);
    const dt = Date.now() - t0;
    all.push(dt);
    const arr = latByPhase.get(s.phase) ?? [];
    arr.push(dt);
    latByPhase.set(s.phase, arr);
    return a;
  };
  const base: Decider = (s, p) => decideTempoChain(s, p);

  console.error(`[grm-latency] GRM(P=${P}) 1席 vs tempoChain 3席 | games=${games} seed=${seed}`);
  for (let g = 0; g < games; g++) {
    const grmSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === grmSeat ? grm : base));
    const r = playOneGameWithDeciders({ seed: seed + g, deciders, maxSteps: 20000 });
    console.error(`  game ${g + 1}/${games}: ${(r.durationMs / 1000).toFixed(0)}s, finished=${r.finished}`);
  }

  all.sort((a, b) => a - b);
  const summary = {
    P,
    games,
    budgetMs: budget > 0 ? budget : null,
    budget: budgetStats(),
    grmMoves: all.length,
    latencyMs: {
      p50: percentile(all, 0.5),
      p90: percentile(all, 0.9),
      p99: percentile(all, 0.99),
      max: all[all.length - 1] ?? 0,
    },
    byPhase: Object.fromEntries(
      [...latByPhase.entries()].map(([ph, arr]) => {
        arr.sort((a, b) => a - b);
        return [ph, { n: arr.length, p50: percentile(arr, 0.5), max: arr[arr.length - 1] }];
      })
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
