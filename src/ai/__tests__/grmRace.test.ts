/**
 * expectedRaceTurns（多色レース期待ターン数の厳密閉形式・非一様レート版。tstar v1 の一般化移植）を、
 * 独立した素朴な分布 DP（1 枚ずつ畳み込み）と突き合わせる。tstar 側の一様版テスト
 * （src/__tests__/race.test.ts）と同じ検証構造で、こちらは色ごとに異なる確率 p_c を扱う。
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../game/rng';
import { expectedRaceTurns } from '../grmAI';

/** 素朴な参照実装: 候補色の所持枚数分布を 1 枚ずつ進め、E[τ] = Σ_t P(2t 枚で未達)。 */
function bruteRaceTurns(cands: { p: number; needed: number }[], qWaste: number): number {
  const k = cands.length;
  let dist = new Map<string, number>([[Array(k).fill(0).join(','), 1]]);
  let E = 0;
  const drawOnce = (d: Map<string, number>): Map<string, number> => {
    const nd = new Map<string, number>();
    const add = (key: string, p: number) => nd.set(key, (nd.get(key) ?? 0) + p);
    for (const [key, mass] of d) {
      const counts = key.split(',').map(Number);
      if (qWaste > 0) add(key, mass * qWaste); // 無駄引き: 進まない
      for (let c = 0; c < k; c++) {
        const nc = counts.slice();
        nc[c]++;
        if (nc[c] >= cands[c].needed) continue; // 達成 = 吸収（「未達」質量から除外）
        add(nc.join(','), mass * cands[c].p);
      }
    }
    return nd;
  };
  for (let t = 0; t <= 300; t++) {
    let mass = 0;
    for (const p of dist.values()) mass += p;
    E += mass;
    if (mass < 1e-12) break;
    dist = drawOnce(drawOnce(dist)); // 1 ターン = 2 枚
  }
  return E;
}

describe('expectedRaceTurns は素朴な分布 DP と一致する（非一様レート）', () => {
  it('決定的ケース', () => {
    const cases: { cands: { p: number; needed: number }[]; q: number }[] = [
      { cands: [{ p: 1, needed: 3 }], q: 0 }, // 単色・無駄なし: ⌈3/2⌉=2 ターンで必ず達成
      { cands: [{ p: 0.5, needed: 2 }], q: 0.5 },
      { cands: [{ p: 0.4, needed: 3 }, { p: 0.4, needed: 2 }], q: 0.2 },
      { cands: [{ p: 0.3, needed: 4 }, { p: 0.3, needed: 4 }, { p: 0.4, needed: 1 }], q: 0 },
      {
        cands: [
          { p: 0.25, needed: 5 },
          { p: 0.2, needed: 3 },
          { p: 0.15, needed: 2 },
          { p: 0.1, needed: 6 },
        ],
        q: 0.3,
      },
    ];
    for (const c of cases) {
      const got = expectedRaceTurns(c.cands, c.q);
      const want = bruteRaceTurns(c.cands, c.q);
      expect(Math.abs(got - want), JSON.stringify(c)).toBeLessThan(1e-9);
    }
  });

  it('needed=0 の色があれば 0（達成済み）', () => {
    expect(expectedRaceTurns([{ p: 0.5, needed: 0 }, { p: 0.5, needed: 3 }], 0)).toBe(0);
  });

  it('ランダムケース fuzz', () => {
    const rng = mulberry32(0xace1);
    for (let t = 0; t < 40; t++) {
      const k = 1 + Math.floor(rng() * 4); // 1..4 色
      const raw = Array.from({ length: k + 1 }, () => 0.05 + rng()); // +1 = 無駄色の重み
      const total = raw.reduce((a, b) => a + b, 0);
      const cands = raw.slice(0, k).map((w) => ({
        p: w / total,
        needed: 1 + Math.floor(rng() * 6), // 1..6 枚
      }));
      const q = raw[k] / total;
      const got = expectedRaceTurns(cands, q);
      const want = bruteRaceTurns(cands, q);
      expect(Math.abs(got - want), `case ${t}: ${JSON.stringify({ cands, q })}`).toBeLessThan(1e-9);
    }
  });
});
