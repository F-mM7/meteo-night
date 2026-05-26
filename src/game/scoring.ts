import type { ComboRecord } from './types';

export function basePointsForSize(size: number): number {
  if (size <= 2) return 0;
  if (size === 3) return 1;
  if (size === 4) return 3;
  if (size === 5) return 10;
  return 10 + (size - 5) * 5;
}

// 連鎖回数 n に対するボーナス: 1:0, 2:1, 3:3, 4:6, 5:10, ... = n*(n-1)/2
export function comboCountBonus(comboCount: number): number {
  if (comboCount <= 1) return 0;
  return (comboCount * (comboCount - 1)) / 2;
}

export function comboBonus(combos: ComboRecord[]): number {
  return comboCountBonus(combos.length);
}

export function totalScoreForTurn(combos: ComboRecord[]): {
  base: number;
  bonus: number;
  total: number;
} {
  const base = combos.reduce((s, c) => s + c.basePoints, 0);
  const bonus = comboBonus(combos);
  return { base, bonus, total: base + bonus };
}
