// 教師あり T* 回帰 実験 本体（純 JS リッジ回帰）。
//
// 検証する問い:
//  (Q1) ホールドアウトで、線形/リッジ回帰モデル（直接 or 残差）はヒューリスティック estimateTHat の
//       テスト MAE を下回るか。
//  (Q2) 色数をまたいで汎化するか（2色で学習→3色でテスト、およびその逆）。対称不変特徴を使う。
//
// 2 つのモデル:
//  (a) 直接: T* を予測。
//  (b) 残差: T* − estimateTHat を予測し、ヒューリスティックに足し戻す。
import { performance } from 'node:perf_hooks';
import type { Color } from '../../src/game/types';
import {
  solveInstance,
  boardFeatures,
  featureDim,
  ridgeFit,
  predict,
  mae,
  rmse,
  fitStandardizer,
  applyStandardizer,
  mulberry32,
  trainTestSplit,
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
const RIDGE_LAMBDA = 1.0; // 標準化済み特徴に対するリッジ係数（数本のグリッドで選定。下で確認）。
const SEED = 12345;
const TEST_FRAC = 0.3;

interface Dataset {
  name: string;
  spec: InstanceSpec;
  sol: SolvedInstance;
  X: number[][]; // 生特徴（bias 列込み）
  yTstar: number[]; // 厳密 T*
  yHeur: number[]; // ヒューリスティック値
  idx: number[]; // trainable index（X/y と同順）
}

function buildDataset(name: string, spec: InstanceSpec): Dataset {
  const t0 = performance.now();
  const sol = solveInstance(spec) as SolvedInstance & { iter: number };
  const DECK = normalizeCounts(Object.fromEntries(spec.colors.map((c) => [c, 50])) as Partial<Record<Color, number>>);
  const DISC = normalizeCounts({});
  const X: number[][] = [];
  const yTstar: number[] = [];
  const yHeur: number[] = [];
  for (const i of sol.trainableIdx) {
    X.push(boardFeatures(sol.boards[i], CFG));
    yTstar.push(sol.T[i]);
    yHeur.push(estimateTHat(sol.boards[i], DECK, DISC, { V: spec.V, P: spec.P, K: spec.K }));
  }
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[${name}] 構築完了: 状態数=${sol.nStates} 学習対象=${sol.trainableIdx.length} 特徴次元=${X[0].length} (${dt}s)`);
  return { name, spec, sol, X, yTstar, yHeur, idx: sol.trainableIdx };
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const gather = <T,>(arr: T[], idx: number[]) => idx.map((i) => arr[i]);

/** 学習: 直接モデルと残差モデルの重みと標準化器を返す。標準化は train で fit。 */
function trainModels(Xtr: number[][], yTr: number[], hTr: number[], lambda: number) {
  const std = fitStandardizer(Xtr);
  const Xs = applyStandardizer(Xtr, std);
  const wDirect = ridgeFit(Xs, yTr, lambda);
  const wResid = ridgeFit(Xs, sub(yTr, hTr), lambda); // 残差 = T* - heur
  return { std, wDirect, wResid };
}

function evalOn(
  model: ReturnType<typeof trainModels>,
  Xte: number[][],
  yTe: number[],
  hTe: number[]
): { heur: number; direct: number; resid: number; heurRmse: number; directRmse: number; residRmse: number } {
  const Xs = applyStandardizer(Xte, model.std);
  const pDirect = Xs.map((x) => predict(model.wDirect, x));
  const pResidRaw = Xs.map((x) => predict(model.wResid, x));
  const pResid = add(pResidRaw, hTe); // ヒューリスティックに残差を足し戻す
  return {
    heur: mae(hTe, yTe),
    direct: mae(pDirect, yTe),
    resid: mae(pResid, yTe),
    heurRmse: rmse(hTe, yTe),
    directRmse: rmse(pDirect, yTe),
    residRmse: rmse(pResid, yTe),
  };
}

function fmt(n: number) {
  return n.toFixed(4);
}

function main() {
  console.log('=== 教師あり T* 回帰 実験（純JSリッジ回帰）===');
  console.log(`設定: K=${CFG.K} V=3 5スロット / テスト割合=${TEST_FRAC} / リッジλ=${RIDGE_LAMBDA} / seed=${SEED}`);
  console.log(`特徴次元=${featureDim(CFG)}（色5枠×5次元 + スロット5×3次元 + グローバル5 + bias）\n`);

  const d2 = buildDataset('2色', SPEC2);
  const d3 = buildDataset('3色', SPEC3);

  // --- λ の簡易選定（2色 train 内 80/20 で）---
  {
    const rng = mulberry32(SEED + 99);
    const { train, test } = trainTestSplit(
      d2.idx.map((_, i) => i),
      0.2,
      rng
    );
    console.log('\n--- リッジλ 選定（2色・内部検証 直接モデル MAE）---');
    for (const lam of [0.01, 0.1, 1, 3, 10, 30]) {
      const m = trainModels(gather(d2.X, train), gather(d2.yTstar, train), gather(d2.yHeur, train), lam);
      const r = evalOn(m, gather(d2.X, test), gather(d2.yTstar, test), gather(d2.yHeur, test));
      console.log(`  λ=${String(lam).padStart(5)}: direct MAE=${fmt(r.direct)}  resid MAE=${fmt(r.resid)}`);
    }
  }

  // === Q1: 同一インスタンス内ホールドアウト ===
  console.log('\n=== Q1: 同一インスタンス内ホールドアウト評価（テスト集合の MAE）===');
  const results: Record<string, ReturnType<typeof evalOn>> = {};
  for (const d of [d2, d3]) {
    const rng = mulberry32(SEED);
    const localIdx = d.idx.map((_, i) => i);
    const { train, test } = trainTestSplit(localIdx, TEST_FRAC, rng);
    const m = trainModels(gather(d.X, train), gather(d.yTstar, train), gather(d.yHeur, train), RIDGE_LAMBDA);
    const r = evalOn(m, gather(d.X, test), gather(d.yTstar, test), gather(d.yHeur, test));
    results[d.name] = r;
    console.log(`\n[${d.name}] train=${train.length} test=${test.length}`);
    console.log(`  MAE   ヒューリスティック=${fmt(r.heur)}  直接T*=${fmt(r.direct)}  残差=${fmt(r.resid)}`);
    console.log(`  RMSE  ヒューリスティック=${fmt(r.heurRmse)}  直接T*=${fmt(r.directRmse)}  残差=${fmt(r.residRmse)}`);
    const bestML = Math.min(r.direct, r.resid);
    const verdict = bestML < r.heur ? `ML が ${fmt(r.heur - bestML)} 改善` : `ML はヒューリスティックを下回れず（差 ${fmt(bestML - r.heur)}）`;
    console.log(`  → ${verdict}`);
  }

  // === Q2: クロス色 汎化 ===
  console.log('\n=== Q2: 色数をまたぐ汎化（学習側 全 trainable で学習 → 相手側 全 trainable でテスト）===');
  const crossEval = (trainD: Dataset, testD: Dataset) => {
    const m = trainModels(trainD.X, trainD.yTstar, trainD.yHeur, RIDGE_LAMBDA);
    const r = evalOn(m, testD.X, testD.yTstar, testD.yHeur);
    console.log(`\n[学習=${trainD.name} → テスト=${testD.name}]  (test n=${testD.X.length})`);
    console.log(`  MAE  ヒューリスティック=${fmt(r.heur)}  直接T*=${fmt(r.direct)}  残差=${fmt(r.resid)}`);
    const bestML = Math.min(r.direct, r.resid);
    const verdict = bestML < r.heur ? `ML が汎化（${fmt(r.heur - bestML)} 改善）` : `汎化せず（ヒューリスティックに ${fmt(bestML - r.heur)} 劣後）`;
    console.log(`  → ${verdict}`);
    return r;
  };
  crossEval(d2, d3);
  crossEval(d3, d2);

  // 参考: 両方を混ぜて学習し各々でテスト（プール学習の効果）。
  console.log('\n=== 参考: 2色+3色プール学習 → 各色でテスト（同一の学習器で両色を見る）===');
  {
    const Xall = [...d2.X, ...d3.X];
    const yAll = [...d2.yTstar, ...d3.yTstar];
    const hAll = [...d2.yHeur, ...d3.yHeur];
    const m = trainModels(Xall, yAll, hAll, RIDGE_LAMBDA);
    for (const d of [d2, d3]) {
      const r = evalOn(m, d.X, d.yTstar, d.yHeur);
      console.log(`  [プール学習 → ${d.name}] MAE ヒューリスティック=${fmt(r.heur)} 直接=${fmt(r.direct)} 残差=${fmt(r.resid)}`);
    }
  }

  console.log('\nEXPERIMENT DONE');
}

main();
