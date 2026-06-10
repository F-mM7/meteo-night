// 教師あり T* 回帰 実験 — 小さな MLP 版（@tensorflow/tfjs-node）。
//
// 線形/リッジは同一インスタンス内ではヒューリスティックを大きく下回ったが、色数をまたぐ汎化が
// 不完全（特に 3色→2色の直接モデル）。非線形モデルでホールドアウト精度・クロス色汎化が改善するかを検証する。
//
// 同じ対称不変特徴・同じ Q1/Q2 評価を MLP で行い、純JSリッジの結果と直接比較する。
import { performance } from 'node:perf_hooks';
import * as tf from '@tensorflow/tfjs-node';
import type { Color } from '../../src/game/types';
import {
  solveInstance,
  boardFeatures,
  featureDim,
  mae,
  rmse,
  fitStandardizer,
  applyStandardizer,
  mulberry32,
  trainTestSplit,
  type InstanceSpec,
  type SolvedInstance,
  type Standardizer,
} from './_grm-ml-lib';
import { estimateTurnsToG } from '../../src/ai/grmAI';
import { normalizeCounts } from '../../src/ai/grmReachF';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).reconfigure?.({ line_buffering: true });
tf.setBackend('cpu'); // 小モデル・小バッチでは CPU で十分（GPU 初期化コスト回避）。

const SPEC2: InstanceSpec = { colors: ['red', 'green'], K: 2, V: 3, P: 1, slotCount: 5 };
const SPEC3: InstanceSpec = { colors: ['red', 'green', 'purple'], K: 2, V: 3, P: 1, slotCount: 5 };
const CFG = { slotCount: 5, K: 2 };
const SEED = 12345;
const TEST_FRAC = 0.3;
const EPOCHS = 40;
const BATCH = 256;
const HIDDEN = [64, 64];

interface Dataset {
  name: string;
  spec: InstanceSpec;
  sol: SolvedInstance;
  X: number[][];
  yTstar: number[];
  yHeur: number[];
  idx: number[];
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
    yHeur.push(estimateTurnsToG(sol.boards[i], DECK, DISC, { V: spec.V, P: spec.P, K: spec.K }));
  }
  console.log(`[${name}] 構築: 学習対象=${X.length} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  return { name, spec, sol, X, yTstar, yHeur, idx: sol.trainableIdx };
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const gather = <T,>(arr: T[], idx: number[]) => idx.map((i) => arr[i]);

function buildModel(inputDim: number): tf.Sequential {
  const m = tf.sequential();
  m.add(tf.layers.dense({ units: HIDDEN[0], activation: 'relu', inputShape: [inputDim] }));
  for (let i = 1; i < HIDDEN.length; i++) m.add(tf.layers.dense({ units: HIDDEN[i], activation: 'relu' }));
  m.add(tf.layers.dense({ units: 1 }));
  m.compile({ optimizer: tf.train.adam(0.005), loss: 'meanAbsoluteError' });
  return m;
}

async function trainMLP(Xtr: number[][], ytr: number[], std: Standardizer): Promise<tf.Sequential> {
  const Xs = applyStandardizer(Xtr, std);
  const xt = tf.tensor2d(Xs);
  const yt = tf.tensor2d(ytr.map((v) => [v]));
  const model = buildModel(Xs[0].length);
  await model.fit(xt, yt, { epochs: EPOCHS, batchSize: BATCH, shuffle: true, verbose: 0 });
  xt.dispose();
  yt.dispose();
  return model;
}

function infer(model: tf.Sequential, X: number[][], std: Standardizer): number[] {
  const Xs = applyStandardizer(X, std);
  const xt = tf.tensor2d(Xs);
  const out = model.predict(xt) as tf.Tensor;
  const arr = Array.from(out.dataSync());
  xt.dispose();
  out.dispose();
  return arr;
}

interface Trained {
  std: Standardizer;
  direct: tf.Sequential;
  resid: tf.Sequential;
}

async function trainBoth(Xtr: number[][], yTr: number[], hTr: number[]): Promise<Trained> {
  const std = fitStandardizer(Xtr);
  const direct = await trainMLP(Xtr, yTr, std);
  const resid = await trainMLP(Xtr, sub(yTr, hTr), std);
  return { std, direct, resid };
}

function evalOn(t: Trained, Xte: number[][], yTe: number[], hTe: number[]) {
  const pDirect = infer(t.direct, Xte, t.std);
  const pResid = add(infer(t.resid, Xte, t.std), hTe);
  return {
    heur: mae(hTe, yTe),
    direct: mae(pDirect, yTe),
    resid: mae(pResid, yTe),
    heurRmse: rmse(hTe, yTe),
    directRmse: rmse(pDirect, yTe),
    residRmse: rmse(pResid, yTe),
  };
}

const fmt = (n: number) => n.toFixed(4);

async function main() {
  console.log('=== 教師あり T* 回帰 実験 — 小MLP（tfjs-node, CPU）===');
  console.log(`隠れ層=${JSON.stringify(HIDDEN)} epochs=${EPOCHS} batch=${BATCH} 特徴次元=${featureDim(CFG)}\n`);

  const d2 = buildDataset('2色', SPEC2);
  const d3 = buildDataset('3色', SPEC3);

  // === Q1 ===
  console.log('\n=== Q1: 同一インスタンス内ホールドアウト（MLP）===');
  for (const d of [d2, d3]) {
    const rng = mulberry32(SEED);
    const { train, test } = trainTestSplit(
      d.idx.map((_, i) => i),
      TEST_FRAC,
      rng
    );
    const t = await trainBoth(gather(d.X, train), gather(d.yTstar, train), gather(d.yHeur, train));
    const r = evalOn(t, gather(d.X, test), gather(d.yTstar, test), gather(d.yHeur, test));
    console.log(`\n[${d.name}] train=${train.length} test=${test.length}`);
    console.log(`  MAE   ヒューリスティック=${fmt(r.heur)}  直接T*=${fmt(r.direct)}  残差=${fmt(r.resid)}`);
    console.log(`  RMSE  ヒューリスティック=${fmt(r.heurRmse)}  直接T*=${fmt(r.directRmse)}  残差=${fmt(r.residRmse)}`);
    const bestML = Math.min(r.direct, r.resid);
    console.log(`  → ${bestML < r.heur ? `ML が ${fmt(r.heur - bestML)} 改善` : `ML 劣後 ${fmt(bestML - r.heur)}`}`);
    t.direct.dispose();
    t.resid.dispose();
  }

  // === Q2 ===
  console.log('\n=== Q2: 色数をまたぐ汎化（MLP）===');
  const cross = async (trainD: Dataset, testD: Dataset) => {
    const t = await trainBoth(trainD.X, trainD.yTstar, trainD.yHeur);
    const r = evalOn(t, testD.X, testD.yTstar, testD.yHeur);
    console.log(`\n[学習=${trainD.name} → テスト=${testD.name}] test n=${testD.X.length}`);
    console.log(`  MAE  ヒューリスティック=${fmt(r.heur)}  直接T*=${fmt(r.direct)}  残差=${fmt(r.resid)}`);
    const bestML = Math.min(r.direct, r.resid);
    console.log(`  → ${bestML < r.heur ? `ML が汎化（${fmt(r.heur - bestML)} 改善）` : `汎化せず（${fmt(bestML - r.heur)} 劣後）`}`);
    t.direct.dispose();
    t.resid.dispose();
  };
  await cross(d2, d3);
  await cross(d3, d2);

  console.log('\nMLP EXPERIMENT DONE');
}

main().catch((e) => {
  console.error('MLP 実験で例外:', e);
  process.exit(1);
});
