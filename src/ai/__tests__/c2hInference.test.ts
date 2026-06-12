import { describe, it, expect } from 'vitest';
import { createC2hLeaf, createC2hHybridLeaf, type C2hArtifact } from '../c2hInference';
import { h0Turns } from '../grmAI';
import { normalizeCounts } from '../grmReachQ';
import artifactJson from '../models/c2-real-h0-pvgrid.json';
import golden from './fixtures/c2h-golden.json';
import type { Color } from '../../game/types';

const artifact = artifactJson as unknown as C2hArtifact;

describe('c2hInference: tstar createFitted（h0 バックボーン）の移植同値性', () => {
  it('golden fixture（tstar 実装で生成・160 件 × P/V 4 組）と 1e-9 一致', () => {
    const leaves = new Map<string, (slots: Color[][]) => number>();
    for (const c of golden.cases) {
      const key = `${c.P}/${c.V}`;
      if (!leaves.has(key)) leaves.set(key, createC2hLeaf(artifact, c.P, c.V));
      const got = leaves.get(key)!(c.slots as Color[][]);
      expect(Math.abs(got - c.expected), `P=${c.P} V=${c.V} slots=${c.slots.map((s) => s.join('')).join('|')}`).toBeLessThan(1e-9);
    }
  });

  it('値の健全性: 下限 1・空盤面は既知レンジ（T*≈11-14.5 と整合する 10-15）', () => {
    const leaf = createC2hLeaf(artifact, 0.45, 20);
    const empty: Color[][] = [[], [], [], [], []];
    const v = leaf(empty);
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThanOrEqual(15);
  });

  it('ハイブリッド葉: 一様山札では raw と一致し、必要色の枯渇で値が増える', () => {
    const raw = createC2hLeaf(artifact, 0.45, 20);
    const hyb = createC2hHybridLeaf(artifact, 0.45, 20);
    const board: Color[][] = [['green'], ['green'], [], [], []];
    const uniform = normalizeCounts({ red: 24, green: 24, purple: 24, yellow: 24, blue: 24 });
    const poorG = normalizeCounts({ red: 30, green: 1, purple: 30, yellow: 30, blue: 29 });
    const none = normalizeCounts({});
    expect(Math.abs(hyb(board, uniform, none) - raw(board))).toBeLessThan(1e-9);
    expect(hyb(board, poorG, none)).toBeGreaterThan(hyb(board, uniform, none));
    expect(h0Turns(board)).toBeGreaterThan(0); // 部品の健全性
  });
});
