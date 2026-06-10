// 対称不変特徴の「重複（同一特徴点が複数盤面に対応）」がホールドアウト結果を楽観化していないか検証する。
//
// 同一特徴ベクトルを持つ盤面群は色/スロット対称で T* も等しい（はず）。train/test を盤面単位で割ると
// 特徴が同じ点が両側に出る＝実質ラベル漏洩。そこで「ユニーク特徴点」単位で割り直し、漏洩なしの
// ホールドアウト MAE を再評価する。また同一特徴点での T* 分散を測り、特徴が T* を一意に決めているか
// （表現の妥当性）も確認する。
import type { Color } from '../../src/game/types';
import {
  solveInstance,
  boardFeatures,
  ridgeFit,
  predict,
  mae,
  fitStandardizer,
  applyStandardizer,
  mulberry32,
  trainTestSplit,
  type InstanceSpec,
  type SolvedInstance,
} from './_grm-ml-lib';
import { estimateTurnsToG } from '../../src/ai/grmAI';
import { normalizeCounts } from '../../src/ai/grmReachF';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdout as any).reconfigure?.({ line_buffering: true });

const SPEC2: InstanceSpec = { colors: ['red', 'green'], K: 2, V: 3, P: 1, slotCount: 5 };
const SPEC3: InstanceSpec = { colors: ['red', 'green', 'purple'], K: 2, V: 3, P: 1, slotCount: 5 };
const CFG = { slotCount: 5, K: 2 };
const SEED = 12345;
const LAMBDA = 1.0;

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const gather = <T,>(arr: T[], idx: number[]) => idx.map((i) => arr[i]);

function run(name: string, spec: InstanceSpec) {
  const sol = solveInstance(spec) as SolvedInstance & { iter: number };
  const DECK = normalizeCounts(Object.fromEntries(spec.colors.map((c) => [c, 50])) as Partial<Record<Color, number>>);
  const DISC = normalizeCounts({});

  // 特徴ハッシュ → { tsAvg, tsMin, tsMax, heurAvg, count }
  const groups = new Map<string, { ts: number[]; heur: number[]; feat: number[] }>();
  for (const i of sol.trainableIdx) {
    const f = boardFeatures(sol.boards[i], CFG);
    const key = f.map((v) => v.toFixed(3)).join(',');
    const h = estimateTurnsToG(sol.boards[i], DECK, DISC, { V: spec.V, P: spec.P, K: spec.K });
    const g = groups.get(key);
    if (g) {
      g.ts.push(sol.T[i]);
      g.heur.push(h);
    } else {
      groups.set(key, { ts: [sol.T[i]], heur: [h], feat: f });
    }
  }

  // 同一特徴点内の T* ばらつき（表現が T* を決めているか）
  let maxSpread = 0;
  let spreadSum = 0;
  let multi = 0;
  for (const g of groups.values()) {
    const mn = Math.min(...g.ts);
    const mx = Math.max(...g.ts);
    const sp = mx - mn;
    if (g.ts.length > 1) multi++;
    if (sp > maxSpread) maxSpread = sp;
    spreadSum += sp;
  }
  const nUnique = groups.size;
  console.log(
    `[${name}] 盤面=${sol.trainableIdx.length} → ユニーク特徴点=${nUnique}（複数盤面が同一特徴=${multi}点）` +
      ` 同一特徴点内T*の最大スプレッド=${maxSpread.toFixed(4)} 平均=${(spreadSum / nUnique).toFixed(4)}`
  );

  // ユニーク特徴点単位（各点を1サンプルに集約: T*/heur は平均）でホールドアウト → 漏洩なし評価
  const uFeat: number[][] = [];
  const uTs: number[] = [];
  const uHeur: number[] = [];
  for (const g of groups.values()) {
    uFeat.push(g.feat);
    uTs.push(g.ts.reduce((a, b) => a + b, 0) / g.ts.length);
    uHeur.push(g.heur.reduce((a, b) => a + b, 0) / g.heur.length);
  }
  const rng = mulberry32(SEED);
  const { train, test } = trainTestSplit(
    uFeat.map((_, i) => i),
    0.3,
    rng
  );
  const Xtr = gather(uFeat, train);
  const std = fitStandardizer(Xtr);
  const Xtrs = applyStandardizer(Xtr, std);
  const wDirect = ridgeFit(Xtrs, gather(uTs, train), LAMBDA);
  const wResid = ridgeFit(Xtrs, sub(gather(uTs, train), gather(uHeur, train)), LAMBDA);
  const Xtes = applyStandardizer(gather(uFeat, test), std);
  const pDirect = Xtes.map((x) => predict(wDirect, x));
  const pResid = add(
    Xtes.map((x) => predict(wResid, x)),
    gather(uHeur, test)
  );
  const yTe = gather(uTs, test);
  const hTe = gather(uHeur, test);
  console.log(
    `  漏洩なし（ユニーク特徴点で分割）テストMAE: ヒューリスティック=${mae(hTe, yTe).toFixed(4)}` +
      ` 直接=${mae(pDirect, yTe).toFixed(4)} 残差=${mae(pResid, yTe).toFixed(4)} (train点=${train.length} test点=${test.length})`
  );
}

run('2色', SPEC2);
run('3色', SPEC3);
console.log('DEDUP DONE');
