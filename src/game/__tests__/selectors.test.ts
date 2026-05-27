import { describe, it, expect } from 'vitest';
import {
  placeableCards,
  interactiveSlotsForActor,
  makePlacementAction,
} from '../selectors';
import type { Card, GameState } from '../types';
import { setupGame } from '../setup';

function makeCard(id: string, color: Card['color'] = 'red'): Card {
  return { id, color };
}

describe('selectors.placeableCards', () => {
  it('awaitingDraw など配置不要のフェーズでは空配列', () => {
    const s = setupGame({ seed: 42 });
    expect(placeableCards(s)).toEqual([]);
  });

  it('awaitingPlaceDrawn では pendingDraw を返す', () => {
    const base = setupGame({ seed: 42 });
    const c0 = makeCard('a', 'red');
    const c1 = makeCard('b', 'green');
    const s: GameState = {
      ...base,
      phase: 'awaitingPlaceDrawn',
      turn: { ...base.turn, pendingDraw: [c0, c1] },
    };
    expect(placeableCards(s)).toEqual([c0, c1]);
  });

  it('awaitingPlaceAdditionalDraw では pendingAdditionalDraw を 1 要素配列で返す', () => {
    const base = setupGame({ seed: 42 });
    const c = makeCard('x', 'blue');
    const s: GameState = {
      ...base,
      phase: 'awaitingPlaceAdditionalDraw',
      turn: { ...base.turn, pendingAdditionalDraw: c },
    };
    expect(placeableCards(s)).toEqual([c]);
  });

  it('awaitingAdditionalDiscard では空配列（カード選択不要）', () => {
    const base = setupGame({ seed: 42 });
    const s: GameState = { ...base, phase: 'awaitingAdditionalDiscard' };
    expect(placeableCards(s)).toEqual([]);
  });

  it('awaitingGiftPlacement では先頭バッチの cards を返す', () => {
    const base = setupGame({ seed: 42 });
    const cards = [makeCard('g1'), makeCard('g2', 'yellow')];
    const s: GameState = {
      ...base,
      phase: 'awaitingGiftPlacement',
      turn: {
        ...base.turn,
        pendingGiftBatches: [{ recipientId: 1, cards }],
      },
    };
    expect(placeableCards(s)).toEqual(cards);
  });
});

describe('selectors.interactiveSlotsForActor', () => {
  it('awaitingPlaceDrawn では全スロットが操作対象', () => {
    const base = setupGame({ seed: 42 });
    const s: GameState = { ...base, phase: 'awaitingPlaceDrawn' };
    expect(interactiveSlotsForActor(s, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it('awaitingAdditionalDiscard では stack>0 のスロットのみ', () => {
    const base = setupGame({ seed: 42 });
    const player = base.players[0];
    const slots = player.board.slots.map((s, i) =>
      i === 2 ? { stack: [] } : s
    );
    const s: GameState = {
      ...base,
      phase: 'awaitingAdditionalDiscard',
      players: base.players.map((p, i) =>
        i === 0 ? { ...p, board: { slots } } : p
      ),
    };
    expect(interactiveSlotsForActor(s, 0)).toEqual([0, 1, 3, 4]);
  });

  it('配置不要のフェーズでは空配列', () => {
    const s = setupGame({ seed: 42 });
    expect(interactiveSlotsForActor(s, 0)).toEqual([]);
  });
});

describe('selectors.makePlacementAction', () => {
  it('awaitingPlaceDrawn は PLACE_DRAWN を返し、selected が無ければ先頭を採用する', () => {
    const base = setupGame({ seed: 42 });
    const c0 = makeCard('a');
    const c1 = makeCard('b');
    const s: GameState = {
      ...base,
      phase: 'awaitingPlaceDrawn',
      turn: { ...base.turn, pendingDraw: [c0, c1] },
    };
    expect(makePlacementAction(s, 3, null)).toEqual({
      type: 'PLACE_DRAWN',
      cardId: 'a',
      slotIndex: 3,
    });
    expect(makePlacementAction(s, 3, 'b')).toEqual({
      type: 'PLACE_DRAWN',
      cardId: 'b',
      slotIndex: 3,
    });
  });

  it('awaitingPlaceAdditionalDraw は PLACE_ADDITIONAL_DRAW を返す', () => {
    const base = setupGame({ seed: 42 });
    const s: GameState = {
      ...base,
      phase: 'awaitingPlaceAdditionalDraw',
      turn: { ...base.turn, pendingAdditionalDraw: makeCard('x') },
    };
    expect(makePlacementAction(s, 2, null)).toEqual({
      type: 'PLACE_ADDITIONAL_DRAW',
      slotIndex: 2,
    });
  });

  it('awaitingAdditionalDiscard は DISCARD_TOP を返す', () => {
    const base = setupGame({ seed: 42 });
    const s: GameState = { ...base, phase: 'awaitingAdditionalDiscard' };
    expect(makePlacementAction(s, 1, null)).toEqual({
      type: 'DISCARD_TOP',
      slotIndex: 1,
    });
  });

  it('awaitingGiftPlacement は PLACE_GIFT を返す', () => {
    const base = setupGame({ seed: 42 });
    const cards = [makeCard('g1'), makeCard('g2')];
    const s: GameState = {
      ...base,
      phase: 'awaitingGiftPlacement',
      turn: {
        ...base.turn,
        pendingGiftBatches: [{ recipientId: 1, cards }],
      },
    };
    expect(makePlacementAction(s, 0, 'g2')).toEqual({
      type: 'PLACE_GIFT',
      cardId: 'g2',
      slotIndex: 0,
    });
  });

  it('配置不要のフェーズでは null を返す', () => {
    const s = setupGame({ seed: 42 });
    expect(makePlacementAction(s, 0, null)).toBeNull();
  });

  it('候補カードが空のときは null を返す', () => {
    const base = setupGame({ seed: 42 });
    const s: GameState = {
      ...base,
      phase: 'awaitingPlaceDrawn',
      turn: { ...base.turn, pendingDraw: [] },
    };
    expect(makePlacementAction(s, 0, null)).toBeNull();
  });
});
