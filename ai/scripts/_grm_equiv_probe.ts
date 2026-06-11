/**
 * _grm_equiv_probe ― 閾値探索（reachesAtLeast）導入後の GRM が、厳密 q 値判定の旧経路と
 * **全着手で同一の判断**をすることを実対局で確認する（ゼロ損失高速化の前提検証）。
 *
 * GRM 1 席 vs tempoChain 3 席を席回転で N ゲーム回し、GRM の全 (step, phase, action) を
 * JSON Lines で stdout に出力する。次の 2 プロセスの出力が byte 同一なら判断同一:
 *
 *   npx tsx ai/scripts/_grm_equiv_probe.ts --games 6 --seed 9501 --P 0.5 > /tmp/new.jsonl
 *   GRM_EXACT_Q=1 npx tsx ai/scripts/_grm_equiv_probe.ts --games 6 --seed 9501 --P 0.5 > /tmp/old.jsonl
 *   diff /tmp/new.jsonl /tmp/old.jsonl
 *
 * （モジュール共有キャッシュが経路で汚染し合わないよう、必ず別プロセスで比較する。）
 */
import { playOneGameWithDeciders, parseIntArg, parseFloatArg, type Decider } from './_runner';
import { decideAction as decideGrm, lazyAuditStats, type GrmOptions } from '../../src/ai/grmAI';
import { decideAction as decideTempoChain } from '../../src/ai/tempoChainAI';

function main(): void {
  let games = 6;
  let seed = 9501;
  let P = 0.5;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--P') P = parseFloatArg('--P', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const grmOptions: GrmOptions = { V: 20, P, H: 1, K: 6 };
  console.error(
    `[grm-equiv] mode=${process.env.GRM_EXACT_Q === '1' ? 'EXACT_Q(旧経路)' : 'threshold(新経路)'} games=${games} seed=${seed} P=${P}`
  );

  for (let g = 0; g < games; g++) {
    const grmSeat = g % 4;
    let step = 0;
    const grm: Decider = (s, p) => {
      const a = decideGrm(s, p, undefined, grmOptions);
      console.log(JSON.stringify({ g, step: step++, phase: s.phase, turn: s.turnNumber, a }));
      return a;
    };
    const base: Decider = (s, p) => decideTempoChain(s, p);
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === grmSeat ? grm : base));
    const r = playOneGameWithDeciders({ seed: seed + g, deciders, maxSteps: 20000 });
    console.error(`  game ${g + 1}/${games}: ${(r.durationMs / 1000).toFixed(0)}s steps=${r.steps} finished=${r.finished}`);
  }
  const audit = lazyAuditStats();
  if (audit.decisions > 0) {
    console.error(
      `[lazy-audit] decisions=${audit.decisions} mismatches=${audit.mismatches} maxGap=${audit.maxGap.toFixed(3)} (Δ=${1.5})`
    );
  }
}

main();
