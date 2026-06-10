// 教師あり T* 回帰 実験の共有ライブラリ。
//
// 役割:
//  1) 小インスタンス（N 色・K=2・V=3・5 スロット）の厳密 T*（i.i.d. 2枚モデルの最適期待 G 到達ターン数）を
//     値反復で解く。遷移モデル・発火/G 判定は src/ai/grmReachF.ts（createChainSolver / fireSlots）を再利用し、
//     _tstar-bench.ts の値反復ロジックを N 色へ一般化したもの。
//  2) 色・スロットの付け替えで T* が不変であることを利用した対称不変特徴量を作る（固定長・色数非依存）。
//
// 既存の src/ai/* は一切編集しない。grmAI からの import（estimateTurnsToG）は read-only。
import type { Color } from '../../src/game/types';
import { createChainSolver, fireSlots, normalizeCounts } from '../../src/ai/grmReachF';

const BIG = 1e9;

export interface InstanceSpec {
  /** 使用する色（この上で一様 i.i.d. にドロー）。 */
  colors: Color[];
  /** スタック切り詰め長 K。 */
  K: number;
  /** 目標点 V。 */
  V: number;
  /** 目標確率 P。 */
  P: number;
  /** スロット数。 */
  slotCount: number;
}

export interface SolvedInstance {
  spec: InstanceSpec;
  /** 全列挙した盤面（slots: 下→上）。 */
  boards: Color[][][];
  /** 各盤面の厳密 T*（G は 0）。到達不能は BIG。 */
  T: Float64Array;
  isFire: Uint8Array;
  isG: Uint8Array;
  /** 比較対象（非発火・非G・到達可能）な盤面 index の配列。 */
  trainableIdx: number[];
  /** デバッグ用キー生成。 */
  keyOf: (bd: Color[][]) => string;
  nStates: number;
}

/** 各スロットの取りうるスタック（長さ 0..K の色列）を全列挙。 */
function genStacks(colors: Color[], K: number): Color[][] {
  const out: Color[][] = [[]];
  let frontier: Color[][] = [[]];
  for (let len = 1; len <= K; len++) {
    const next: Color[][] = [];
    for (const s of frontier) for (const c of colors) next.push([...s, c]);
    out.push(...next);
    frontier = next;
  }
  return out;
}

/**
 * インスタンスを厳密に解く。状態数 = (Σ_{l=0..K} C^l)^slotCount（C=色数）。
 * 値反復は _tstar-bench.ts と同一の遷移モデル:
 *   毎ターン 2 枚を色集合上で一様 i.i.d. にドロー → 2 枚を最適配置（同スロット時は両順序も試行）。
 *   置いた結果が G なら cost 0、小発火（発火だが f<P）は採らない（最悪）、非発火なら T[s']。
 *   T[s] = 1 + Σ_ω P(ω) min_配置 cost。G 盤面は吸収（T=0）。
 */
export function solveInstance(spec: InstanceSpec, maxNodes = 5_000_000): SolvedInstance {
  const { colors, K, V, P, slotCount } = spec;
  const C = colors.length;
  const colIdx = new Map<Color, number>();
  colors.forEach((c, i) => colIdx.set(c, i));

  const stacks = genStacks(colors, K);
  // 盤面 = slotCount 個のスタックの直積。再帰で列挙。
  const boards: Color[][][] = [];
  const cur: Color[][] = new Array(slotCount);
  (function rec(d: number) {
    if (d === slotCount) {
      boards.push(cur.map((s) => s.slice()));
      return;
    }
    for (const s of stacks) {
      cur[d] = s;
      rec(d + 1);
    }
  })(0);
  const N = boards.length;

  const keyOf = (bd: Color[][]) => bd.map((s) => s.map((x) => colIdx.get(x)!).join('')).join('|');
  const idx = new Map<string, number>();
  boards.forEach((bd, i) => idx.set(keyOf(bd), i));

  const place = (bd: Color[][], slot: number, c: Color): Color[][] =>
    bd.map((s, j) => {
      if (j !== slot) return s;
      const ns = [...s, c];
      return ns.length > K ? ns.slice(ns.length - K) : ns;
    });

  // ドロー分布を山札に反映しない近似（_tstar-bench と同じく定常・大きめ等量プールで f を評価）。
  const DECK = normalizeCounts(Object.fromEntries(colors.map((c) => [c, 50])) as Partial<Record<Color, number>>);
  const DISC = normalizeCounts({});

  const solver = createChainSolver(V, K, maxNodes);
  const isFire = new Uint8Array(N);
  const isG = new Uint8Array(N);
  // placeIdx[i*slotCount*C + slot*C + color] = 配置後の盤面 index
  const placeIdx = new Int32Array(N * slotCount * C);
  for (let i = 0; i < N; i++) {
    const bd = boards[i];
    isFire[i] = fireSlots(bd) ? 1 : 0;
    isG[i] = isFire[i] && solver.resolveValue(bd, 0, 0, DECK, DISC) >= P ? 1 : 0;
    for (let s = 0; s < slotCount; s++) {
      for (let c = 0; c < C; c++) {
        placeIdx[i * slotCount * C + s * C + c] = idx.get(keyOf(place(bd, s, colors[c])))!;
      }
    }
  }

  // ドロー事象 ω: 2 枚を一様 i.i.d.（色 c は確率 1/C）。色ペア (x<=y) の出現確率を集約。
  const OMEGA: { cards: [number, number]; p: number }[] = [];
  for (let x = 0; x < C; x++) {
    for (let y = x; y < C; y++) {
      const p = x === y ? 1 / (C * C) : 2 / (C * C);
      OMEGA.push({ cards: [x, y], p });
    }
  }

  const T = new Float64Array(N); // init 0
  const stride = slotCount * C;
  let iter = 0;
  for (; iter < 10000; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      if (isG[i]) continue; // 吸収
      let exp = 0;
      for (const { cards, p } of OMEGA) {
        let best = BIG;
        const orderings: [number, number][] = cards[0] === cards[1] ? [cards] : [cards, [cards[1], cards[0]]];
        for (const [x, y] of orderings) {
          for (let a = 0; a < slotCount; a++) {
            const i1 = placeIdx[i * stride + a * C + x];
            for (let b = 0; b < slotCount; b++) {
              const i2 = placeIdx[i1 * stride + b * C + y];
              let cost: number;
              if (isG[i2]) cost = 0;
              else if (isFire[i2]) continue; // 小発火は採らない（最悪）
              else cost = T[i2];
              if (cost < best) best = cost;
            }
          }
        }
        exp += p * best;
      }
      const nv = 1 + exp;
      const d = Math.abs(nv - T[i]);
      if (d > maxDelta) maxDelta = d;
      T[i] = nv;
    }
    if (maxDelta < 1e-7) break;
  }

  const trainableIdx: number[] = [];
  for (let i = 0; i < N; i++) {
    if (isFire[i] || isG[i]) continue;
    if (T[i] >= BIG) continue;
    trainableIdx.push(i);
  }

  return { spec, boards, T, isFire, isG, trainableIdx, keyOf, nStates: N, iter } as SolvedInstance & { iter: number };
}

// ---------------------------------------------------------------------------
// 対称不変特徴量
// ---------------------------------------------------------------------------
//
// T* は (1) 色の付け替え、(2) スロットの付け替え、で不変。固定長・色数非依存にするため:
//  - 「色ごとの記述子ベクトル」を作り、降順ソート（色不変）。上位 MAX_COLOR_SLOTS 色まで採り、足りなければ 0 詰め。
//  - 「スロットごとの記述子ベクトル」を作り、ソート（スロット不変）。スロット数は固定なのでそのまま。
//  - 山札の色割合をソートして含める（このインスタンスでは一様なので情報量は小さいが、汎化のため一般化）。
// これにより 2 色・3 色を同一次元で表現でき、相互汎化を試せる。

export const MAX_COLOR_SLOTS = 5; // 記述子に残す色の最大数（5 色ゲーム上限に合わせる）

export interface FeatureConfig {
  slotCount: number;
  K: number;
}

/**
 * 盤面 → 対称不変な固定長特徴ベクトル。
 *
 * 色ごとの記述子（各 5 次元）:
 *   [最上段にこの色がある数, 盤面上の総数, 最上段からの連続同色長の最大, この色が最上段の連続長の合計, 「あと1枚で発火」寄与]
 * スロットごとの記述子（各 3 次元）:
 *   [高さ, 最上段からの連続同色長, 最上段が他スロット最上段と一致する数(局所揃い度)]
 * グローバル:
 *   [発火まであと何枚（最大の最上段色カウントを 3 から引いた値, 下限0）, 総枚数, 空きスロット数]
 */
export function boardFeatures(board: Color[][], cfg: FeatureConfig): number[] {
  const { slotCount } = cfg;
  // --- 最上段の色カウント ---
  const topColor: (Color | null)[] = board.map((s) => (s.length ? s[s.length - 1] : null));
  const topCount = new Map<Color, number>();
  for (const c of topColor) if (c) topCount.set(c, (topCount.get(c) ?? 0) + 1);

  // --- 色ごとの記述子 ---
  const colorSet = new Set<Color>();
  for (const s of board) for (const c of s) colorSet.add(c);
  const colorDesc: number[][] = [];
  for (const col of colorSet) {
    let topN = 0; // この色が最上段のスロット数
    let total = 0; // 盤面上の総数
    let maxRun = 0; // 全スロットを通じた「最上段からの連続同色長」の最大
    let topRunSum = 0; // この色が最上段であるスロットの連続同色長の合計
    for (const s of board) {
      for (const c of s) if (c === col) total++;
      // 最上段からの連続同色長
      let run = 0;
      for (let k = s.length - 1; k >= 0; k--) {
        if (s[k] === col) run++;
        else break;
      }
      if (s.length && s[s.length - 1] === col) {
        topN++;
        topRunSum += run;
        if (run > maxRun) maxRun = run;
      }
    }
    // 「あと1枚で発火」寄与: この色の最上段数がちょうど 2 なら 1（発火直前）。
    const nearFire = topN === 2 ? 1 : 0;
    colorDesc.push([topN, total, maxRun, topRunSum, nearFire]);
  }
  // 色不変化: 記述子を辞書式に降順ソートし、上位 MAX_COLOR_SLOTS 色、足りなければ 0 ベクトル詰め。
  colorDesc.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  });
  const COLOR_DESC_DIM = 5;
  const colorFeat: number[] = [];
  for (let i = 0; i < MAX_COLOR_SLOTS; i++) {
    if (i < colorDesc.length) colorFeat.push(...colorDesc[i]);
    else colorFeat.push(...new Array(COLOR_DESC_DIM).fill(0));
  }

  // --- スロットごとの記述子（スロット不変化のためソート）---
  const slotDesc: number[][] = [];
  for (const s of board) {
    const h = s.length;
    let run = 0;
    if (h) {
      const t = s[h - 1];
      for (let k = h - 1; k >= 0; k--) {
        if (s[k] === t) run++;
        else break;
      }
    }
    // 局所揃い度: 自分の最上段色を最上段に持つ他スロット数（自分含むカウント-1）。
    const t = h ? s[h - 1] : null;
    const localMatch = t ? (topCount.get(t) ?? 0) - 1 : 0;
    slotDesc.push([h, run, localMatch]);
  }
  slotDesc.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  });
  const slotFeat: number[] = [];
  for (let i = 0; i < slotCount; i++) slotFeat.push(...slotDesc[i]);

  // --- グローバル ---
  let maxTop = 0;
  for (const v of topCount.values()) if (v > maxTop) maxTop = v;
  const toFire = Math.max(0, 3 - maxTop); // 発火（最上段同色3）まで最良色であと何枚
  let total = 0;
  for (const s of board) total += s.length;
  const empty = board.filter((s) => s.length === 0).length;
  const distinctTopColors = topCount.size;
  const globalFeat = [toFire, total, empty, distinctTopColors, maxTop];

  return [...colorFeat, ...slotFeat, ...globalFeat, 1 /* bias */];
}

export function featureDim(cfg: FeatureConfig): number {
  return boardFeatures(
    Array.from({ length: cfg.slotCount }, () => [] as Color[]),
    cfg
  ).length;
}

// ---------------------------------------------------------------------------
// 純 JS リッジ回帰（正規方程式 + ガウス消去）
// ---------------------------------------------------------------------------

/** X: n×d（bias 列込み想定）, y: n。 (XᵀX + λI) w = Xᵀy を解く。bias 列(最終列=定数1)は正則化しない。 */
export function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const n = X.length;
  const d = X[0].length;
  // A = XᵀX (+λ), b = Xᵀy
  const A: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  const b: number[] = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    const yi = y[i];
    for (let a = 0; a < d; a++) {
      const xa = xi[a];
      if (xa === 0) continue;
      b[a] += xa * yi;
      for (let c = a; c < d; c++) A[a][c] += xa * xi[c];
    }
  }
  for (let a = 0; a < d; a++) for (let c = a + 1; c < d; c++) A[c][a] = A[a][c];
  // 正則化（bias 列=最後の列は除く）
  for (let a = 0; a < d - 1; a++) A[a][a] += lambda;
  return solveLinear(A, b);
}

/** ガウス消去（部分ピボット）。A は破壊的に使用。 */
function solveLinear(A: number[][], b: number[]): number[] {
  const d = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue; // 特異列はスキップ（係数0扱い）
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    for (let c = col; c <= d; c++) M[col][c] /= pv;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= d; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[d]);
}

export function predict(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

export function mae(pred: number[], actual: number[]): number {
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += Math.abs(pred[i] - actual[i]);
  return s / pred.length;
}

export function rmse(pred: number[], actual: number[]): number {
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += (pred[i] - actual[i]) ** 2;
  return Math.sqrt(s / pred.length);
}

/** 列ごとの標準化パラメータ（bias 列は変換しない）。 */
export interface Standardizer {
  mean: number[];
  std: number[];
}

export function fitStandardizer(X: number[][]): Standardizer {
  const n = X.length;
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  return { mean, std };
}

export function applyStandardizer(X: number[][], s: Standardizer): number[][] {
  // 最終列は bias(=1) のまま残す。
  return X.map((x) => x.map((v, j) => (j === x.length - 1 ? 1 : (v - s.mean[j]) / s.std[j])));
}

/** シード付き擬似乱数（再現性のため）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** インデックス配列をシャッフルして train/test に分割。 */
export function trainTestSplit(idx: number[], testFrac: number, rng: () => number): { train: number[]; test: number[] } {
  const a = idx.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nTest = Math.floor(a.length * testFrac);
  return { test: a.slice(0, nTest), train: a.slice(nTest) };
}
