import type { ComboRecord } from './types';

export function basePointsForSize(size: number): number {
  if (size <= 2) return 0;
  if (size === 3) return 1;
  if (size === 4) return 3;
  if (size === 5) return 10;
  return 10 + (size - 5) * 5;
}

export function comboBonus(combos: ComboRecord[]): number {
  const baseSum = combos.reduce((s, c) => s + c.basePoints, 0);
  return baseSum;
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
