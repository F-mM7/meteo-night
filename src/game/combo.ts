import type { Card, Color, PlayerBoard } from './types';

export interface DetectedCombo {
  color: Color;
  slotIndices: number[];
  cards: Card[];
}

export function detectCombos(board: PlayerBoard): DetectedCombo[] {
  const byColor = new Map<Color, { slotIndex: number; card: Card }[]>();

  board.slots.forEach((slot, slotIndex) => {
    const top = slot.stack[slot.stack.length - 1];
    if (!top) return;
    const list = byColor.get(top.color) ?? [];
    list.push({ slotIndex, card: top });
    byColor.set(top.color, list);
  });

  const combos: DetectedCombo[] = [];
  for (const [color, list] of byColor.entries()) {
    if (list.length >= 3) {
      combos.push({
        color,
        slotIndices: list.map((x) => x.slotIndex),
        cards: list.map((x) => x.card),
      });
    }
  }
  return combos;
}

export function removeTopCardsFromSlots(
  board: PlayerBoard,
  slotIndices: number[]
): PlayerBoard {
  return {
    slots: board.slots.map((slot, idx) => {
      if (!slotIndices.includes(idx)) return slot;
      return { stack: slot.stack.slice(0, -1) };
    }),
  };
}
