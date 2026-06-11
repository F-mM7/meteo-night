// 漏洩なし（ユニーク対称類で分割）の in-distribution 精度を k-fold 交差検証で安定評価する。
// 単一分割だとユニーク類が少なく（2色55 / 3色382）分散が大きいため。
import type { Color } from '../../src/game/types';
import {
  solveInstance,
  boardFeatures,
  ridgeFit,
  predict,
  fitStandardizer,
  applyStandardizer,
  mulberry32,
  type InstanceSpec,
  type SolvedInstance,
} from './_grm-ml-lib';
import { estimateTHat } from '../../src/ai/grmAI';
import { normalizeCounts } from '../../src/ai/grmReachQ';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).reconfigure?.({ line_buffering: true });

const SPEC2: InstanceSpec = { colors: ['red', 'green'], K: 2, V: 3, P: 1, slotCount: 5 };
const SPEC3: InstanceSpec = { colors: ['red', 'green', 'purple'], K: 2, V: 3, P: 1, slotCount: 5 };
const CFG = { slotCount: 5, K: 2 };
const LAMBDA = 1.0;
const SEED = 12345;
const KFOLD = 5;

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const gather = <T,>(arr: T[], idx: number[]) => idx.map((i) => arr[i]);
const absMean = (p: number[], y: number[]) => p.reduce((s, v, i) => s + Math.abs(v - y[i]), 0) / p.length;

/** trainable 盤面を対称類（同一特徴）に集約。各類: 代表特徴・平均T*・平均heur・盤面数（重み）。 */
function uniqueClasses(spec: InstanceSpec) {
  const sol = solveInstance(spec) as SolvedInstance & { iter: number };
  const DECK = normalizeCounts(Object.fromEntries(spec.colors.map((c) => [c, 50])) as Partial<Record<Color, number>>);
  const DISC = normalizeCounts({});
  const groups = new Map<string, { feat: number[]; ts: number[]; heur: number[] }>();
  for (const i of sol.trainableIdx) {
    const f = boardFeatures(sol.boards[i], CFG);
    const key = f.map((v) => v.toFixed(3)).join(',');
    const h = estimateTHat(sol.boards[i], DECK, DISC, { V: spec.V, P: spec.P, K: spec.K });
    const g = groups.get(key);
    if (g) {
      g.ts.push(sol.T[i]);
      g.heur.push(h);
    } else groups.set(key, { feat: f, ts: [sol.T[i]], heur: [h] });
  }
  const feat: number[][] = [];
  const ts: number[] = [];
  const heur: number[] = [];
  const weight: number[] = []; // この類に属する盤面数（盤面加重 MAE 用）
  for (const g of groups.values()) {
    feat.push(g.feat);
    ts.push(g.ts.reduce((a, b) => a + b, 0) / g.ts.length);
    heur.push(g.heur.reduce((a, b) => a + b, 0) / g.heur.length);
    weight.push(g.ts.length);
  }
  return { feat, ts, heur, weight, nBoards: sol.trainableIdx.length };
}

function kfold(name: string, spec: InstanceSpec) {
  const { feat, ts, heur, weight, nBoards } = uniqueClasses(spec);
  const n = feat.length;
  const order = feat.map((_, i) => i);
  const rng = mulberry32(SEED);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // 類単位（非加重）と盤面加重の両方で集計。
  const accH: number[] = [];
  const accD: number[] = [];
  const accR: number[] = [];
  // 盤面加重: 全 test 類の |誤差|×weight を集め最後に Σweight で割る。
  let whSum = 0;
  let wdSum = 0;
  let wrSum = 0;
  let wTot = 0;
  for (let k = 0; k < KFOLD; k++) {
    const test = order.filter((_, i) => i % KFOLD === k);
    const train = order.filter((_, i) => i % KFOLD !== k);
    const Xtr = gather(feat, train);
    const std = fitStandardizer(Xtr);
    const Xtrs = applyStandardizer(Xtr, std);
    const wDirect = ridgeFit(Xtrs, gather(ts, train), LAMBDA);
    const wResid = ridgeFit(Xtrs, sub(gather(ts, train), gather(heur, train)), LAMBDA);
    const Xtes = applyStandardizer(gather(feat, test), std);
    const yTe = gather(ts, test);
    const hTe = gather(heur, test);
    const pD = Xtes.map((x) => predict(wDirect, x));
    const pR = add(
      Xtes.map((x) => predict(wResid, x)),
      hTe
    );
    accH.push(absMean(hTe, yTe));
    accD.push(absMean(pD, yTe));
    accR.push(absMean(pR, yTe));
    const wTe = gather(weight, test);
    for (let i = 0; i < test.length; i++) {
      whSum += Math.abs(hTe[i] - yTe[i]) * wTe[i];
      wdSum += Math.abs(pD[i] - yTe[i]) * wTe[i];
      wrSum += Math.abs(pR[i] - yTe[i]) * wTe[i];
      wTot += wTe[i];
    }
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\n[${name}] ${KFOLD}-fold 漏洩なし（対称類 ${n} 件, 盤面 ${nBoards}）`);
  console.log(`  類単位 平均テストMAE : ヒューリスティック=${avg(accH).toFixed(4)} 直接=${avg(accD).toFixed(4)} 残差=${avg(accR).toFixed(4)}`);
  console.log(`  盤面加重 テストMAE   : ヒューリスティック=${(whSum / wTot).toFixed(4)} 直接=${(wdSum / wTot).toFixed(4)} 残差=${(wrSum / wTot).toFixed(4)}`);
  const bestML = Math.min(avg(accD), avg(accR));
  console.log(`  → 類単位で ${bestML < avg(accH) ? `ML が ${(avg(accH) - bestML).toFixed(4)} 改善` : `ML 劣後 ${(bestML - avg(accH)).toFixed(4)}`}`);
}

console.log(`=== 漏洩なし in-distribution（${KFOLD}-fold CV, 対称類単位で分割）===`);
kfold('2色', SPEC2);
kfold('3色', SPEC3);
console.log('\nKFOLD DONE');
