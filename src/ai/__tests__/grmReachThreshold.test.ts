/**
 * reachesAtLeast（閾値付き branch-and-bound）と厳密 resolveValue の完全一致を検証する。
 *
 * 速度最適化（GRM の G 判定の早期打ち切り）は「結果不変」が前提条件。本テストは
 *  1. ランダム盤面のファズで `reachesAtLeast(...P) === (resolveValue(...) >= P)` を、
 *     境界 P = 厳密値そのもの・その近傍を含む P 格子で確認する。
 *  2. 同一ソルバで閾値判定→厳密値の順に呼んでも、厳密値が新規ソルバの値とビット一致する
 *     （閾値探索の memo 共有が厳密値を汚染しない）ことを確認する。
 */
import { describe, it, expect } from 'vitest';
import type { Color } from '../../game/types';
import { COLORS } from '../../game/types';
import { mulberry32 } from '../../game/rng';
import { createChainSolver, colorCountsFromColors, fireSlots } from '../grmReachQ';

const [R, G, B, Y] = COLORS as [Color, Color, Color, Color, Color];

interface Case {
  slots: Color[][];
  deck: Color[];
  discard: Color[];
}

function checkCase(c: Case, V: number, K: number): void {
  const deck = colorCountsFromColors(c.deck);
  const discard = colorCountsFromColors(c.discard);

  // 厳密値（基準）: 新規ソルバで計算
  const exact = createChainSolver(V, K).resolveValue(c.slots, 0, 0, deck, discard);

  // P 格子: 通常値 + 境界（厳密値そのもの・その近傍）
  const grid = [0, 0.1, 0.25, 0.5, 0.65, 0.8, 0.9, 1, exact, exact - 1e-9, exact + 1e-9].filter(
    (p) => p >= 0 && p <= 1
  );
  for (const p of grid) {
    // 閾値判定は専用ソルバ（汚染なしの素の状態）でも、厳密値と混在でも一致すべき
    const solver = createChainSolver(V, K);
    const got = solver.reachesAtLeast(c.slots, 0, 0, deck, discard, p);
    expect(got, `reachesAtLeast(P=${p}) vs exact=${exact}`).toBe(exact >= p);

    // 閾値判定後に同じソルバで厳密値を取ってもビット一致（memo 汚染なし）
    const exactAfter = solver.resolveValue(c.slots, 0, 0, deck, discard);
    expect(exactAfter, `threshold(P=${p}) 後の厳密値`).toBe(exact);
  }
}

describe('reachesAtLeast は厳密 resolveValue ≥ P と完全一致する', () => {
  it('決定的シナリオ（既存テストと同型）', () => {
    const cases: Case[] = [
      { slots: [[G, R], [G, R], [G, R], [B], []], deck: [], discard: [] },
      { slots: [[R], [R], [R], [G], [G]], deck: [G, B, B, B], discard: [] },
      { slots: [[R], [R], [R], [G], [G]], deck: [], discard: [G, B, B, B] },
      { slots: [[B, G, R], [B, G, R], [B, G, R], [], []], deck: [B, B], discard: [] },
      { slots: [[Y, R], [R], [R], [G], [G]], deck: [G, Y, B], discard: [Y] },
    ];
    for (const c of cases) {
      for (const V of [1, 2, 3, 4, 5, 8]) checkCase(c, V, 99);
    }
  });

  it('ランダム盤面ファズ（境界 P 含む）', () => {
    const rng = mulberry32(0x7e57);
    const randColor = (): Color => COLORS[Math.floor(rng() * COLORS.length)];
    const shuffle5 = (): number[] => {
      const a = [0, 1, 2, 3, 4];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    for (let t = 0; t < 60; t++) {
      const fireColor = randColor();
      const fireIdx = new Set(shuffle5().slice(0, 3));
      const slots: Color[][] = [[], [], [], [], []];
      for (let i = 0; i < 5; i++) {
        if (fireIdx.has(i)) {
          if (rng() < 0.5) slots[i].push(randColor());
          slots[i].push(fireColor);
        } else if (rng() < 0.6) {
          if (rng() < 0.4) slots[i].push(randColor());
          slots[i].push(randColor());
        }
      }
      expect(fireSlots(slots)).toBe(true);
      const deck = Array.from({ length: Math.floor(rng() * 4) }, randColor);
      const discard = Array.from({ length: Math.floor(rng() * 3) }, randColor);
      for (const V of [1, 2, 3, 5]) checkCase({ slots, deck, discard }, V, 99);
    }
  });

  it('K 切り詰めありでも一致（実運用 K=6 相当）', () => {
    const rng = mulberry32(0xfeed);
    const randColor = (): Color => COLORS[Math.floor(rng() * COLORS.length)];
    for (let t = 0; t < 25; t++) {
      const fireColor = randColor();
      const slots: Color[][] = [[], [], [], [], []];
      for (let i = 0; i < 5; i++) {
        const depth = Math.floor(rng() * 3);
        for (let d = 0; d < depth; d++) slots[i].push(randColor());
      }
      for (const i of [0, 2, 4]) slots[i].push(fireColor);
      expect(fireSlots(slots)).toBe(true);
      const deck = Array.from({ length: Math.floor(rng() * 5) }, randColor);
      for (const V of [2, 3, 6]) checkCase({ slots, deck, discard: [] }, V, 6);
    }
  });
});
