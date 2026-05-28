import type { Action, GameState, GiftAssignment } from '../game/types';
import { mulberry32 } from '../game/rng';

function stateBaseSeed(state: GameState, playerId: number): number {
  const a = state.rngSeed >>> 0;
  const b = Math.imul(state.turnNumber + 1, 0x9e3779b1);
  const c = Math.imul(playerId + 1, 0x85ebca6b);
  const d = Math.imul(state.log.length + 1, 0xc2b2ae35);
  return (a ^ b ^ c ^ d) | 0;
}

function pickRand<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number
): Action | null {
  const player = state.players[playerId];
  if (!player) return null;

  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;
  const rand = mulberry32(baseSeed);

  if (state.phase === 'awaitingGiftPlacement') {
    const batch = state.turn.pendingGiftBatches[0];
    if (!batch || batch.recipientId !== playerId) return null;
    const card = pickRand(batch.cards, rand);
    const slotIndex = Math.floor(rand() * player.board.slots.length);
    return { type: 'PLACE_GIFT', cardId: card.id, slotIndex };
  }

  if (state.currentPlayerIndex !== playerId) return null;

  switch (state.phase) {
    case 'awaitingDraw': {
      const fieldOpts: Array<0 | 1> = [];
      if (state.field[0]) fieldOpts.push(0);
      if (state.field[1]) fieldOpts.push(1);
      // 山札・捨札が両方空のときは DECK ドローが state 不変を返してしまうため、
      // 場ペアがあれば確実に場ドロー、無ければ null を返す（actionSpace のガードと同条件）。
      const canDeck = state.deck.length > 0 || state.discardPile.length > 0;
      if (fieldOpts.length > 0 && (rand() < 0.6 || !canDeck)) {
        return { type: 'DRAW_FROM_FIELD', pairIndex: pickRand(fieldOpts, rand) };
      }
      if (canDeck) return { type: 'DRAW_FROM_DECK' };
      return null;
    }
    case 'awaitingPlaceDrawn': {
      const card = state.turn.pendingDraw[0];
      if (!card) return null;
      const slotIndex = Math.floor(rand() * player.board.slots.length);
      return { type: 'PLACE_DRAWN', cardId: card.id, slotIndex };
    }
    case 'awaitingAdditionalActionChoice': {
      const canDraw = state.deck.length > 0 || state.discardPile.length > 0;
      const canDiscard = player.board.slots.some((s) => s.stack.length > 0);
      if (canDraw && canDiscard) {
        return rand() < 0.7
          ? { type: 'CHOOSE_ADDITIONAL_DRAW' }
          : { type: 'CHOOSE_ADDITIONAL_DISCARD' };
      }
      if (canDraw) return { type: 'CHOOSE_ADDITIONAL_DRAW' };
      if (canDiscard) return { type: 'CHOOSE_ADDITIONAL_DISCARD' };
      return null;
    }
    case 'awaitingPlaceAdditionalDraw': {
      const slotIndex = Math.floor(rand() * player.board.slots.length);
      return { type: 'PLACE_ADDITIONAL_DRAW', slotIndex };
    }
    case 'awaitingAdditionalDiscard': {
      const slots = player.board.slots
        .map((s, i) => (s.stack.length > 0 ? i : -1))
        .filter((i) => i >= 0);
      if (slots.length === 0) return null;
      return { type: 'DISCARD_TOP', slotIndex: pickRand(slots, rand) };
    }
    case 'awaitingGiftSelection': {
      const queue = state.turn.giftQueue;
      if (queue.length === 0) return null;
      const otherIds = state.players.filter((p) => p.id !== playerId).map((p) => p.id);
      const assignments: GiftAssignment[] = queue.map((combo, comboIndex) => ({
        comboIndex,
        cardId: pickRand(combo.cards, rand).id,
        targetPlayerId: pickRand(otherIds, rand),
      }));
      return { type: 'CONFIRM_GIFTS', assignments };
    }
    default:
      return null;
  }
}
