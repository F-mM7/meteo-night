import type { Action, GameState } from '../game/types';

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function decideAction(state: GameState, playerId: number): Action | null {
  if (state.currentPlayerIndex !== playerId) return null;
  const player = state.players[playerId];

  switch (state.phase) {
    case 'awaitingPlacePendingGifts': {
      const card = player.pendingGifts[0];
      if (!card) return null;
      const slotIndex = Math.floor(Math.random() * player.board.slots.length);
      return { type: 'PLACE_PENDING_GIFT', cardId: card.id, slotIndex };
    }
    case 'awaitingDraw': {
      const opts: Array<0 | 1> = [];
      if (state.field[0]) opts.push(0);
      if (state.field[1]) opts.push(1);
      if (opts.length > 0 && Math.random() < 0.6) {
        return { type: 'DRAW_FROM_FIELD', pairIndex: pick(opts) };
      }
      return { type: 'DRAW_FROM_DECK' };
    }
    case 'awaitingPlaceDrawn': {
      const card = state.turn.pendingDraw[0];
      if (!card) return null;
      const slotIndex = Math.floor(Math.random() * player.board.slots.length);
      return { type: 'PLACE_DRAWN', cardId: card.id, slotIndex };
    }
    case 'awaitingAdditionalActionChoice':
      return Math.random() < 0.7
        ? { type: 'CHOOSE_ADDITIONAL_DRAW' }
        : { type: 'CHOOSE_ADDITIONAL_DISCARD' };
    case 'awaitingPlaceAdditionalDraw': {
      const slotIndex = Math.floor(Math.random() * player.board.slots.length);
      return { type: 'PLACE_ADDITIONAL_DRAW', slotIndex };
    }
    case 'awaitingAdditionalDiscard': {
      const slots = player.board.slots
        .map((s, i) => (s.stack.length > 0 ? i : -1))
        .filter((i) => i >= 0);
      if (slots.length === 0) return null;
      return { type: 'DISCARD_TOP', slotIndex: pick(slots) };
    }
    case 'awaitingGiftSelection': {
      const queue = state.turn.giftQueue;
      if (queue.length === 0) return null;
      const combo = queue[0];
      const card = combo.cards[0];
      const targets = state.players.filter((p) => p.id !== playerId).map((p) => p.id);
      const target = pick(targets);
      return { type: 'GIVE_CARD', comboIndex: 0, cardId: card.id, targetPlayerId: target };
    }
    default:
      return null;
  }
}
