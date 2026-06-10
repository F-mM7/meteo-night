/**
 * _latency-probe.ts — tempoChain の「1手あたり思考時間」を nodeLimit 別に測る。
 * ブラウザ（Web Worker 実行）での CPU 1手の所要時間の目安。decideAction の各呼び出しを計時する。
 *
 *   npx tsx ai/scripts/_latency-probe.ts --node-limits 60000,15000 --games 8 --seed 50001
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { GameState } from '../../src/game/types';
import { decideAction as decideTempoChain, DEFAULT_GENOME } from '../../src/ai/tempoChainAI';
import { currentActorId, parseIntArg } from './_runner';

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function measure(nodeLimit: number, games: number, seed: number): number[] {
  const genome = { ...DEFAULT_GENOME, nodeLimit };
  const times: number[] = [];
  for (let g = 0; g < games; g++) {
    let state: GameState = setupGame({ seed: seed + g, cpuFlags: [true, true, true, true] });
    let steps = 0;
    while (state.phase !== 'gameOver' && steps < 20000) {
      const actor = currentActorId(state);
      const t0 = Date.now();
      const a = decideTempoChain(state, actor, undefined, genome);
      times.push(Date.now() - t0);
      if (!a) break;
      const before = state;
      state = stepGame(state, a);
      if (state === before) break;
      steps++;
    }
  }
  return times;
}

function main(): void {
  const argv = process.argv.slice(2);
  let nodeLimitsArg = '60000,15000';
  let games = 8;
  let seed = 50001;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--node-limits') nodeLimitsArg = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const nodeLimits = nodeLimitsArg.split(',').map((s) => parseInt(s.trim(), 10));
  console.log(`tempoChain 1手あたり思考時間（4×自己対戦, games=${games}, seed=${seed}）`);
  console.log(`nodeLimit   手数   中央値  p90   p99   最大   平均(ms)`);
  for (const nl of nodeLimits) {
    const t = measure(nl, games, seed).sort((a, b) => a - b);
    const mean = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
    console.log(
      `${String(nl).padStart(8)}  ${String(t.length).padStart(5)}  ${String(pct(t, 50)).padStart(4)}  ${String(pct(t, 90)).padStart(4)}  ${String(pct(t, 99)).padStart(4)}  ${String(t[t.length - 1] ?? 0).padStart(4)}  ${mean.toFixed(1).padStart(6)}`
    );
  }
}
main();
