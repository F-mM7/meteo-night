import { describe, it, expect } from 'vitest';
import { basePointsForSize, totalScoreForTurn } from '../scoring';
import type { ComboRecord } from '../types';

describe('basePointsForSize', () => {
  it('3枚で1点', () => {
    expect(basePointsForSize(3)).toBe(1);
  });
  it('4枚で3点', () => {
    expect(basePointsForSize(4)).toBe(3);
  });
  it('5枚で10点', () => {
    expect(basePointsForSize(5)).toBe(10);
  });
  it('2枚以下は0点', () => {
    expect(basePointsForSize(2)).toBe(0);
    expect(basePointsForSize(0)).toBe(0);
  });
});

describe('totalScoreForTurn', () => {
  it('単発3枚: 基礎1+ボーナス1=2点', () => {
    const combos: ComboRecord[] = [
      { color: 'red', cards: [], basePoints: 1 },
    ];
    expect(totalScoreForTurn(combos)).toEqual({ base: 1, bonus: 1, total: 2 });
  });
  it('4枚×3コンボ: 基礎9+ボーナス9=18点', () => {
    const combos: ComboRecord[] = [
      { color: 'red', cards: [], basePoints: 3 },
      { color: 'green', cards: [], basePoints: 3 },
      { color: 'blue', cards: [], basePoints: 3 },
    ];
    expect(totalScoreForTurn(combos)).toEqual({ base: 9, bonus: 9, total: 18 });
  });
});
