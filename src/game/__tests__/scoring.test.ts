import { describe, it, expect } from 'vitest';
import {
  basePointsForSize,
  comboCountBonus,
  totalScoreForTurn,
} from '../scoring';
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

describe('comboCountBonus', () => {
  it('連鎖回数に応じたボーナス: 1:0, 2:1, 3:3, 4:6, 5:10', () => {
    expect(comboCountBonus(1)).toBe(0);
    expect(comboCountBonus(2)).toBe(1);
    expect(comboCountBonus(3)).toBe(3);
    expect(comboCountBonus(4)).toBe(6);
    expect(comboCountBonus(5)).toBe(10);
  });
  it('0回・負値は0点', () => {
    expect(comboCountBonus(0)).toBe(0);
  });
});

describe('totalScoreForTurn', () => {
  it('単発3枚: 基礎1+ボーナス0=1点', () => {
    const combos: ComboRecord[] = [
      { color: 'red', cards: [], basePoints: 1 },
    ];
    expect(totalScoreForTurn(combos)).toEqual({ base: 1, bonus: 0, total: 1 });
  });
  it('単発5枚: 基礎10+ボーナス0=10点', () => {
    const combos: ComboRecord[] = [
      { color: 'red', cards: [], basePoints: 10 },
    ];
    expect(totalScoreForTurn(combos)).toEqual({ base: 10, bonus: 0, total: 10 });
  });
  it('4枚×3コンボ: 基礎9+ボーナス3=12点', () => {
    const combos: ComboRecord[] = [
      { color: 'red', cards: [], basePoints: 3 },
      { color: 'green', cards: [], basePoints: 3 },
      { color: 'blue', cards: [], basePoints: 3 },
    ];
    expect(totalScoreForTurn(combos)).toEqual({ base: 9, bonus: 3, total: 12 });
  });
  it('3枚×3+4枚×1の4連鎖: 基礎6+ボーナス6=12点', () => {
    const combos: ComboRecord[] = [
      { color: 'red', cards: [], basePoints: 1 },
      { color: 'green', cards: [], basePoints: 1 },
      { color: 'blue', cards: [], basePoints: 1 },
      { color: 'yellow', cards: [], basePoints: 3 },
    ];
    expect(totalScoreForTurn(combos)).toEqual({ base: 6, bonus: 6, total: 12 });
  });
});
