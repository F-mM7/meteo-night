// 近似改良用ベンチ: 小盤面で厳密な真値 T*（i.i.d. 2枚モデルの最適期待到達ターン数, §6.1）を値反復で解き、
// 現行 U ヒューリスティック estimateTurnsToG の誤差を測る。
// インスタンス: 2色(red/green)・K=2・5スロット・V=3・P=1・定常 50/50 ドロー（→ 状態数 7^5=16807 で厳密に解ける）。
import type { Color } from '../../src/game/types';
import { createChainSolver, fireSlots, normalizeCounts } from '../../src/ai/grmReachF';
import { estimateTurnsToG } from '../../src/ai/grmAI';

const R: Color = 'red';
const G: Color = 'green';
const COLS: Color[] = [R, G];
const K = 2;
const V = 3;
const P = 1;
const DECK = normalizeCounts({ red: 50, green: 50 }); // 定常 50/50 を近似する大きめ等量
const DISC = normalizeCounts({});
const BIG = 1e9;

// --- 全盤面（各スロット長さ0..K の2色列, 5スロット）を列挙 ---
function genStacks(): Color[][] {
  const out: Color[][] = [[]];
  let frontier: Color[][] = [[]];
  for (let len = 1; len <= K; len++) {
    const next: Color[][] = [];
    for (const s of frontier) for (const c of COLS) next.push([...s, c]);
    out.push(...next);
    frontier = next;
  }
  return out;
}
const STACKS = genStacks(); // 7 通り (K=2)
const BOARDS: Color[][][] = [];
for (const a of STACKS)
  for (const b of STACKS)
    for (const c of STACKS)
      for (const d of STACKS)
        for (const e of STACKS) BOARDS.push([a, b, c, d, e]);
const N = BOARDS.length;
const keyOf = (bd: Color[][]) => bd.map((s) => s.map((x) => x[0]).join('')).join('|');
const idx = new Map<string, number>();
BOARDS.forEach((bd, i) => idx.set(keyOf(bd), i));

function place(bd: Color[][], slot: number, c: Color): Color[][] {
  return bd.map((s, j) => {
    if (j !== slot) return s;
    const ns = [...s, c];
    return ns.length > K ? ns.slice(ns.length - K) : ns;
  });
}

// --- 各盤面の発火/G 判定と配置遷移を前計算 ---
const solver = createChainSolver(V, K);
const isFire = new Uint8Array(N);
const isG = new Uint8Array(N);
// placeIdx[i*10 + slot*2 + color] = 置いた後の盤面 index
const placeIdx = new Int32Array(N * 5 * 2);
for (let i = 0; i < N; i++) {
  const bd = BOARDS[i];
  isFire[i] = fireSlots(bd) ? 1 : 0;
  isG[i] = isFire[i] && solver.resolveValue(bd, 0, 0, DECK, DISC) >= P ? 1 : 0;
  for (let s = 0; s < 5; s++) {
    for (let c = 0; c < 2; c++) {
      placeIdx[i * 10 + s * 2 + c] = idx.get(keyOf(place(bd, s, COLS[c])))!;
    }
  }
}
const nG = isG.reduce((a, b) => a + b, 0);
const nFireNonG = BOARDS.reduce((a, _, i) => a + (isFire[i] && !isG[i] ? 1 : 0), 0);
console.log(`状態数 N=${N}, G=${nG}, 発火だが非G(小発火)=${nFireNonG}, 非発火=${N - nG - nFireNonG}`);

// --- 値反復で T*(s)=最適期待 G 到達ターン数 を解く ---
// T[s]=0 (s∈G) / 1 + Σ_ω P(ω) min_配置 cost  （cost: G→0, 非発火→T[s'], 小発火→不採用）
const OMEGA: { cards: [number, number]; p: number }[] = [
  { cards: [0, 0], p: 0.25 },
  { cards: [0, 1], p: 0.5 },
  { cards: [1, 1], p: 0.25 },
];
const T = new Float64Array(N); // init 0
let iter = 0;
for (; iter < 5000; iter++) {
  let maxDelta = 0;
  for (let i = 0; i < N; i++) {
    if (isG[i]) continue; // 吸収
    let exp = 0;
    for (const { cards, p } of OMEGA) {
      // c0,c1 を最適配置（同スロット時の順序差も拾うため両順序）
      let best = BIG;
      for (const [x, y] of cards[0] === cards[1] ? [cards] : [cards, [cards[1], cards[0]] as [number, number]]) {
        for (let a = 0; a < 5; a++) {
          const i1 = placeIdx[i * 10 + a * 2 + x];
          for (let b = 0; b < 5; b++) {
            const i2 = placeIdx[i1 * 10 + b * 2 + y];
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
console.log(`値反復 収束 iter=${iter}`);

// --- 非発火・非G 盤面で 厳密T* vs ヒューリスティック を比較 ---
let n = 0;
let sumExact = 0;
let sumHeur = 0;
let sumSigned = 0;
let sumAbs = 0;
let sxx = 0;
let syy = 0;
let sxy = 0;
const samples: { exact: number; heur: number; key: string }[] = [];
for (let i = 0; i < N; i++) {
  if (isFire[i] || isG[i]) continue; // 非発火・非G の積み増し局面のみ
  if (T[i] >= BIG) continue; // 到達不能（理論上ここでは無いはず）
  const exact = T[i];
  const heur = estimateTurnsToG(BOARDS[i], DECK, DISC, { V, P, K });
  n++;
  sumExact += exact;
  sumHeur += heur;
  sumSigned += heur - exact;
  sumAbs += Math.abs(heur - exact);
  samples.push({ exact, heur, key: keyOf(BOARDS[i]) });
}
const mExact = sumExact / n;
const mHeur = sumHeur / n;
for (const s of samples) {
  sxx += (s.exact - mExact) ** 2;
  syy += (s.heur - mHeur) ** 2;
  sxy += (s.exact - mExact) * (s.heur - mHeur);
}
const corr = sxy / Math.sqrt(sxx * syy);
console.log(`\n比較対象(非発火非G) n=${n}`);
console.log(`  平均 厳密T*=${mExact.toFixed(3)}  ヒューリスティック=${mHeur.toFixed(3)}`);
console.log(`  平均符号付き誤差(heur-exact)=${(sumSigned / n).toFixed(3)}  平均絶対誤差=${(sumAbs / n).toFixed(3)}`);
console.log(`  相関 corr=${corr.toFixed(4)}`);

samples.sort((a, b) => b.heur - b.exact - (a.heur - a.exact));
console.log('\n  最大の過大評価(heur≫exact) 上位5:');
for (const s of samples.slice(0, 5)) console.log(`    [${s.key}] 厳密=${s.exact.toFixed(2)} heur=${s.heur.toFixed(2)} 差=${(s.heur - s.exact).toFixed(2)}`);
console.log('  最大の過小評価(heur≪exact) 上位5:');
for (const s of samples.slice(-5).reverse()) console.log(`    [${s.key}] 厳密=${s.exact.toFixed(2)} heur=${s.heur.toFixed(2)} 差=${(s.heur - s.exact).toFixed(2)}`);
console.log('DONE');
