import { describe, it, expect } from 'vitest';
import { h0Turns, h0TurnsReal, expectedRaceTurns, estimateTHat } from '../grmAI';
import { normalizeCounts } from '../grmReachQ';
import type { Color } from '../../game/types';

// 盤面は Color[][]（スロットごとの下→上スタック）。
const r: Color = 'red';
const g: Color = 'green';
const b: Color = 'blue';

const U = 1 / 5; // 一様レート（全 5 色 p_c = 1/5・無駄引き 0）
const empty: Color[][] = [[], [], [], [], []];

describe('h0Turns: 探査不要・盤面のみの最終 tier 推定器', () => {
  it('発火形不足枚数 needed_c = max(0, 3 − topCount_c) の手計算ケースと一致する', () => {
    // 空盤面: 全色 topCount=0 → needed = (3,3,3,3,3)
    expect(h0Turns(empty)).toBeCloseTo(
      expectedRaceTurns(
        [3, 3, 3, 3, 3].map((needed) => ({ p: U, needed })),
        0
      ),
      12
    );
    // tops = g,g,r → needed: g=1, r=2, 残り 3 色は 3
    const board: Color[][] = [[g], [g], [r], [], []];
    expect(h0Turns(board)).toBeCloseTo(
      expectedRaceTurns(
        [1, 2, 3, 3, 3].map((needed) => ({ p: U, needed })),
        0
      ),
      12
    );
  });

  it('埋まったカードは数えない（最上段のみが発火形に寄与する）', () => {
    // r は g の下に埋まっている → topCount_r=0 ＝ r を露出スロットに置いた盤面と同値
    const buried: Color[][] = [[r, g], [], [], [], []];
    const exposedG: Color[][] = [[g], [], [], [], []];
    expect(h0Turns(buried)).toBeCloseTo(h0Turns(exposedG), 12);
  });

  it('発火形（同色 top 3 つ）は不足 0 → h0 = 0', () => {
    expect(h0Turns([[g], [g], [g], [], []])).toBe(0);
  });

  it('発火形に近いほど小さい（単調）・非発火盤面では 1 ターン以上', () => {
    const one: Color[][] = [[g], [], [], [], []];
    const two: Color[][] = [[g], [g], [], [], []];
    expect(h0Turns(two)).toBeLessThan(h0Turns(one));
    expect(h0Turns(one)).toBeLessThan(h0Turns(empty));
    expect(h0Turns(two)).toBeGreaterThanOrEqual(1);
  });

  it('一様山札の非発火盤面で h0 ≤ 解析推定（楽観下界・代表ケース）', { timeout: 60_000 }, () => {
    // 一様山札（各色 24 枚＝実ゲームの初期構成）では解析推定のレートが h0 と同じ 1/5 になり、
    // 不足枚数は「発火形まで」≤「G（発火 ∧ q≥P）まで」なので h0 が下から押さえる。
    // 解析推定値は estimateTHat 経由で取る（精緻化ゲート 0 の現構成では T̂ ＝解析推定そのもの）。
    const deck = normalizeCounts({ red: 24, green: 24, purple: 24, yellow: 24, blue: 24 });
    const discard = normalizeCounts({});
    const opts = { V: 20, P: 0.5, K: 6 }; // 配信構成と同じ目線
    const boards: Color[][][] = [
      empty,
      [[g], [g], [], [], []],
      [[r], [r], [g], [g], []],
      [[g, r], [r], [b], [], []],
    ];
    for (const board of boards) {
      expect(
        h0Turns(board),
        `board=${board.map((s) => s.join('') || '·').join('|')} で h0 が解析推定を上回った`
      ).toBeLessThanOrEqual(estimateTHat(board, deck, discard, opts) + 1e-9);
    }
  });
});

describe('h0TurnsReal: 実レート版 h0（実分布ハイブリッドの部品）', () => {
  it('一様山札では h0Turns と一致する', () => {
    const deck = normalizeCounts({ red: 24, green: 24, purple: 24, yellow: 24, blue: 24 });
    const none = normalizeCounts({});
    const boards: Color[][][] = [empty, [[g], [g], [], [], []], [[r], [r], [g], [g], []]];
    for (const board of boards) {
      expect(Math.abs(h0TurnsReal(board, deck, none) - h0Turns(board))).toBeLessThan(1e-9);
    }
  });

  it('必要色が枯渇するほど遅く・豊富なほど速い（実分布の注入方向）', () => {
    const board: Color[][] = [[g], [g], [], [], []]; // 緑あと1枚で発火形
    const richG = normalizeCounts({ green: 24, red: 24, purple: 24, yellow: 24, blue: 24 });
    const poorG = normalizeCounts({ green: 1, red: 30, purple: 30, yellow: 30, blue: 29 });
    const none = normalizeCounts({});
    expect(h0TurnsReal(board, richG, none)).toBeLessThan(h0TurnsReal(board, poorG, none));
  });
});
