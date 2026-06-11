// スモークテスト: solveInstance が 2色/3色で動くか、3色の値反復が現実的時間で解けるか、
// および estimateTHat の import が生きているかを確認する。
import { performance } from 'node:perf_hooks';
import type { Color } from '../../src/game/types';
import { solveInstance, boardFeatures, featureDim, type InstanceSpec } from './_grm-ml-lib';
import { estimateTHat } from '../../src/ai/grmAI';
import { normalizeCounts } from '../../src/ai/grmReachQ';

process.stdout.write(''); // flush 促進
// 出力を即時に。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).reconfigure?.({ line_buffering: true });

const SPEC2: InstanceSpec = { colors: ['red', 'green'], K: 2, V: 3, P: 1, slotCount: 5 };
const SPEC3: InstanceSpec = { colors: ['red', 'green', 'purple'], K: 2, V: 3, P: 1, slotCount: 5 };

function report(name: string, spec: InstanceSpec) {
  const t0 = performance.now();
  const sol = solveInstance(spec) as ReturnType<typeof solveInstance> & { iter: number };
  const dt = ((performance.now() - t0) / 1000).toFixed(2);
  const nG = sol.isG.reduce((a, b) => a + b, 0);
  const nFire = sol.isFire.reduce((a, b) => a + b, 0);
  const nFireNonG = nFire - nG;
  let sumT = 0;
  for (const i of sol.trainableIdx) sumT += sol.T[i];
  console.log(
    `[${name}] 状態数=${sol.nStates} G=${nG} 小発火=${nFireNonG} 学習対象(非発火非G)=${sol.trainableIdx.length}` +
      ` 値反復iter=${sol.iter} 平均T*=${(sumT / sol.trainableIdx.length).toFixed(3)} 所要=${dt}s`
  );
  // 特徴次元
  console.log(`  特徴次元=${featureDim({ slotCount: spec.slotCount, K: spec.K })}`);
  // ヒューリスティック MAE（参照と一致するか）
  const DECK = normalizeCounts(Object.fromEntries(spec.colors.map((c) => [c, 50])) as Partial<Record<Color, number>>);
  const DISC = normalizeCounts({});
  let sa = 0;
  for (const i of sol.trainableIdx) {
    const heur = estimateTHat(sol.boards[i], DECK, DISC, { V: spec.V, P: spec.P, K: spec.K });
    sa += Math.abs(heur - sol.T[i]);
  }
  console.log(`  ヒューリスティックMAE=${(sa / sol.trainableIdx.length).toFixed(4)}`);
  return sol;
}

const s2 = report('2色', SPEC2);
report('3色', SPEC3);

// 特徴量サンプル表示（不変性のサニティ: 色を入れ替えた盤面が同じ特徴になるか）
const cfg = { slotCount: 5, K: 2 };
const b1: Color[][] = [['red'], ['red'], ['green'], [], []];
const b2: Color[][] = [['green'], ['green'], ['red'], [], []]; // red<->green スワップ
const f1 = boardFeatures(b1, cfg);
const f2 = boardFeatures(b2, cfg);
const same = f1.every((v, i) => Math.abs(v - f2[i]) < 1e-9);
console.log(`\n色スワップ不変性チェック: ${same ? 'OK（同一特徴）' : 'NG（差異あり）'}`);
// スロット入れ替え不変性
const b3: Color[][] = [[], ['red'], [], ['red'], ['green']];
const f3 = boardFeatures(b3, cfg);
const sameSlot = f1.every((v, i) => Math.abs(v - f3[i]) < 1e-9);
console.log(`スロットスワップ不変性チェック: ${sameSlot ? 'OK（同一特徴）' : 'NG（差異あり）'}`);
console.log('SMOKE DONE');
void s2;
