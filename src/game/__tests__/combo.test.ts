import { describe, it, expect } from 'vitest';
import { detectCombos, removeTopCardsFromSlots } from '../combo';
import type { Card, PlayerBoard } from '../types';

const c = (color: Card['color'], n: number): Card => ({ id: `${color}-${n}`, color });

function makeBoard(stacks: Card[][]): PlayerBoard {
  return { slots: stacks.map((stack) => ({ stack })) };
}

describe('detectCombos', () => {
  it('最上段に赤3枚: 赤コンボ検出', () => {
    const board = makeBoard([
      [c('red', 1)],
      [c('red', 2)],
      [c('red', 3)],
      [c('green', 1)],
      [c('blue', 1)],
    ]);
    const combos = detectCombos(board);
    expect(combos).toHaveLength(1);
    expect(combos[0].color).toBe('red');
    expect(combos[0].slotIndices.sort()).toEqual([0, 1, 2]);
  });

  it('下に同色があっても最上段でしか判定しない', () => {
    const board = makeBoard([
      [c('red', 1), c('green', 1)],
      [c('red', 2), c('green', 2)],
      [c('red', 3), c('green', 3)],
      [c('green', 4)],
      [c('blue', 1)],
    ]);
    const combos = detectCombos(board);
    expect(combos).toHaveLength(1);
    expect(combos[0].color).toBe('green');
  });

  it('2色同時発火', () => {
    const board = makeBoard([
      [c('red', 1)],
      [c('red', 2)],
      [c('red', 3)],
      [c('green', 1)],
      [c('green', 2)],
    ]);
    const combos = detectCombos(board);
    expect(combos).toHaveLength(1);
    expect(combos[0].color).toBe('red');
  });

  it('5枚全部同色なら1コンボ5枚', () => {
    const board = makeBoard([
      [c('blue', 1)],
      [c('blue', 2)],
      [c('blue', 3)],
      [c('blue', 4)],
      [c('blue', 5)],
    ]);
    const combos = detectCombos(board);
    expect(combos).toHaveLength(1);
    expect(combos[0].cards).toHaveLength(5);
  });
});

describe('removeTopCardsFromSlots', () => {
  it('指定スロットの最上段だけ取り除く', () => {
    const board = makeBoard([
      [c('red', 1), c('green', 1)],
      [c('red', 2)],
    ]);
    const after = removeTopCardsFromSlots(board, [0]);
    expect(after.slots[0].stack).toHaveLength(1);
    expect(after.slots[0].stack[0].color).toBe('red');
    expect(after.slots[1].stack).toHaveLength(1);
  });
});
