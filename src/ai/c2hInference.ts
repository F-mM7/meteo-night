/**
 * tstar C2-h0 成果物（プローブゼロ h 候補）の純 TS 推論 — 本体移植・外部依存ゼロ。
 *
 * 出典: tstar リポジトリ `src/features.ts`（置換不変特徴量）と `src/c2.ts`（`createFitted` の
 * h0 バックボーン経路・`predictResidual`）。**忠実な移植**であり、同値性は golden fixture
 * （tstar 実装で生成した盤面→期待値の対）テストで 1e-9 一致を担保する。
 *
 * 実行時は「h0（発火形レースの閉形式）＋ 盤面特徴量（fire 判定のみ・q 不使用）＋ 小型 MLP」のみ
 * ＝ greedy 構築・q プローブ・探索ゼロ（探査不要 h の硬条件、`ai/OBJECTIVE.md` / TSTAR-DEPS R1）。
 * 用途は LA1（深さ 1 実レート展開）の葉評価（`GrmOptions.leafFn`）。実分布の注入は
 * ハイブリッド形 `max(0, C2h0(盤面) + h0実レート − h0一様)` で行う（実分布注入は meteo 主導）。
 *
 * 既知の近似: 学習は一様 i.i.d.・V=20 中心の P×V 格子。終盤モード（P=0 化・V<20）への厳密適応は
 * しない（leaf の P/V は生成時に固定。終盤の主役は厳密 q 側で T̂ の寄与は小さい）。
 */
import type { Color } from '../game/types';
import { COLORS } from '../game/types';
import { h0Turns, h0TurnsReal } from './grmAI';
import type { ColorCounts } from './grmReachQ';

export interface C2hMlpModel {
  kind: 'mlp';
  hidden: number;
  W1: number[][];
  b1: number[];
  W2: number[];
  b2: number;
}
export interface C2hRidgeModel {
  kind: 'ridge';
  weights: number[];
}
export interface C2hArtifact {
  inst: { m: number; L: number; K: number; V: number; P: number };
  backboneKind?: string;
  featureNames: string[];
  model: C2hMlpModel | C2hRidgeModel;
  meta?: Record<string, unknown>;
}

// tstar c2.ts と同一の正規化定数（変更すると成果物と非互換になる）。
const BACKBONE_SCALE = 10;
const V_SCALE = 20;

/** tstar `predictResidual` の移植（ridge＝線形 / mlp＝tanh 1 隠れ層）。 */
function predictResidual(model: C2hMlpModel | C2hRidgeModel, x: Float64Array): number {
  if (model.kind === 'ridge') {
    let s = 0;
    for (let i = 0; i < model.weights.length; i++) s += model.weights[i] * x[i];
    return s;
  }
  let out = model.b2;
  for (let h = 0; h < model.hidden; h++) {
    let a = model.b1[h];
    const w = model.W1[h];
    for (let i = 0; i < w.length; i++) a += w[i] * x[i];
    out += model.W2[h] * Math.tanh(a);
  }
  return out;
}

/** tstar `boardFeatures` の移植（盤面は色インデックスの number[][]。すべて盤面統計＝プローブゼロ）。 */
function boardFeatures(board: number[][], m: number, L: number, K: number): Float64Array {
  const cap = L * K;
  let cards = 0;
  let emptySlots = 0;
  let fullSlots = 0;
  let topPairSame = 0;
  const lens: number[] = [];
  for (const s of board) {
    cards += s.length;
    lens.push(s.length / K);
    if (s.length === 0) emptySlots++;
    if (s.length === K) fullSlots++;
    if (s.length >= 2 && s[s.length - 1] === s[s.length - 2]) topPairSame++;
  }
  lens.sort((a, b) => b - a);

  const tops = new Array<number>(m).fill(0);
  for (const s of board) {
    const t = s[s.length - 1];
    if (t !== undefined) tops[t]++;
  }
  const topsSorted = tops.map((t) => t / L).sort((a, b) => b - a);

  const colorRows: { cards: number; tops: number; vertPairs: number; topRun: number }[] = [];
  for (let c = 0; c < m; c++) {
    let cc = 0;
    let vp = 0;
    let run = 0;
    for (const s of board) {
      let r = 0;
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] === c) {
          cc++;
          if (i + 1 < s.length && s[i + 1] === c) vp++;
          if (i === s.length - 1 - r) r++;
        }
      }
      if (r > run) run = r;
    }
    colorRows.push({ cards: cc, tops: tops[c], vertPairs: vp, topRun: run });
  }
  colorRows.sort((a, b) => b.tops - a.tops || b.cards - a.cards || b.vertPairs - a.vertPairs);

  // 力学の近傍プローブ: 1 枚配置で発火する割合（fire 判定のみ・q 不使用。重複盤面は数えない）
  let fireable = 0;
  let placements = 0;
  const seen = new Set<string>();
  for (let c = 0; c < m; c++) {
    for (let j = 0; j < L; j++) {
      // placeCard 相当: j へ c を積み、上から K 枚に切り詰め
      const st = board[j].length >= K ? [...board[j].slice(board[j].length - K + 1), c] : [...board[j], c];
      const key =
        board.map((s, idx) => (idx === j ? st : s).join(',')).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      placements++;
      // fire 判定: 最上段同色 ≥3
      const topCount = new Array<number>(m).fill(0);
      for (let idx = 0; idx < board.length; idx++) {
        const s = idx === j ? st : board[idx];
        const t = s[s.length - 1];
        if (t !== undefined) topCount[t]++;
      }
      if (topCount.some((v) => v >= 3)) fireable++;
    }
  }

  const out: number[] = [
    1,
    cards / cap,
    emptySlots / L,
    fullSlots / L,
    topPairSame / L,
    placements > 0 ? fireable / placements : 0,
  ];
  out.push(...lens);
  out.push(...topsSorted);
  for (const r of colorRows) {
    out.push(r.cards / cap, r.tops / L, r.vertPairs / cap, r.topRun / K);
  }
  return Float64Array.from(out);
}

const MEMO_CAP = 1_000_000; // 上限超過で全消去（値は不変。無上限メモ化バグ一族への定石）

/**
 * 成果物から葉評価 `(slots) => T̂` を再構成する（tstar `createFitted` の h0 バックボーン経路と同値）。
 * P / V は実行時引数（P×V 格子学習の成果物に入力として渡る。配信は P=P\*, V=20）。
 */
export function createC2hLeaf(artifact: C2hArtifact, P: number, V: number): (slots: Color[][]) => number {
  if ((artifact.backboneKind ?? 'baseline') !== 'h0') {
    throw new Error('createC2hLeaf: h0 バックボーンの成果物のみ移植対応（baseline 系は q ソルバ依存）');
  }
  const { m, L, K } = artifact.inst;
  if (m !== COLORS.length || L !== 5) {
    throw new Error(`createC2hLeaf: インスタンス不一致（m=${m}, L=${L}）`);
  }
  const names = artifact.featureNames;
  const withV = names[names.length - 1] === 'V';
  const withP = withV || names[names.length - 1] === 'P';
  const memo = new Map<string, number>();
  return (slots: Color[][]): number => {
    const key = slots.map((s) => s.map((c) => c[0]).join('')).join('|');
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const board = slots.map((st) => st.map((c) => COLORS.indexOf(c)));
    const b = h0Turns(slots);
    const f = boardFeatures(board, m, L, K);
    const x = new Float64Array(names.length);
    x.set(f);
    x[f.length] = b / BACKBONE_SCALE;
    if (withP) x[f.length + 1] = P;
    if (withV) x[f.length + 2] = V / V_SCALE;
    const v = Math.max(1, b + predictResidual(artifact.model, x));
    if (memo.size >= MEMO_CAP) memo.clear();
    memo.set(key, v);
    return v;
  };
}

/**
 * 実分布ハイブリッド葉: `max(0, C2h0(盤面) + h0実レート(盤面,山札,捨札) − h0一様(盤面))`。
 * 一様 i.i.d. 学習の C2-h0 に「山札の偏りが G 到達速度へ与える補正」を閉形式で注入する
 * （全てプローブゼロ・O(盤面)。検証経緯は ai/CHANGELOG.md 2026-06-12）。
 */
export function createC2hHybridLeaf(
  artifact: C2hArtifact,
  P: number,
  V: number
): (slots: Color[][], deck: ColorCounts, discard: ColorCounts) => number {
  const raw = createC2hLeaf(artifact, P, V);
  return (slots, deck, discard) => Math.max(0, raw(slots) + h0TurnsReal(slots, deck, discard) - h0Turns(slots));
}
