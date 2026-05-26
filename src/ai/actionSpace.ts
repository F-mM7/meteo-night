import type { Action, GameState } from '../game/types';

/**
 * 行動 ID 空間（NN 方策のための離散 ID 化）。
 *
 *  ID | 行動
 * ----+------------------------------------------------------------
 *  0  | DRAW_FROM_FIELD pair=0
 *  1  | DRAW_FROM_FIELD pair=1
 *  2  | DRAW_FROM_DECK
 *  3  | CHOOSE_ADDITIONAL_DRAW
 *  4  | CHOOSE_ADDITIONAL_DISCARD
 *  5..9   | PLACE_DRAWN pendingDraw[0] を slot 0..4 に
 *  10..14 | PLACE_DRAWN pendingDraw[1] を slot 0..4 に
 *  15..19 | PLACE_ADDITIONAL_DRAW slot 0..4
 *  20..24 | DISCARD_TOP slot 0..4
 *  25..29 | PLACE_GIFT 現在バッチの cards[0] を slot 0..4 に
 *
 * 計 30。
 *
 * CONFIRM_GIFTS（プレゼント割り当て）は離散 ID 化が難しいため
 * このヘッドでは扱わず、別系統（ヒューリスティック or 専用ヘッド）に委ねる。
 */
export const ACTION_SPACE_SIZE = 30;

const NUM_SLOTS = 5;

const ID_DRAW_FROM_FIELD_0 = 0;
const ID_DRAW_FROM_FIELD_1 = 1;
const ID_DRAW_FROM_DECK = 2;
const ID_CHOOSE_ADD_DRAW = 3;
const ID_CHOOSE_ADD_DISCARD = 4;
const ID_PLACE_DRAWN_0_BASE = 5;
const ID_PLACE_DRAWN_1_BASE = 10;
const ID_PLACE_ADDITIONAL_DRAW_BASE = 15;
const ID_DISCARD_TOP_BASE = 20;
const ID_PLACE_GIFT_BASE = 25;

export function actionIdToAction(
  state: GameState,
  actorId: number,
  id: number
): Action | null {
  if (id < 0 || id >= ACTION_SPACE_SIZE) return null;

  if (state.phase === 'awaitingGiftPlacement') {
    if (id < ID_PLACE_GIFT_BASE || id >= ID_PLACE_GIFT_BASE + NUM_SLOTS) return null;
    const slot = id - ID_PLACE_GIFT_BASE;
    const batch = state.turn.pendingGiftBatches[0];
    if (!batch || batch.recipientId !== actorId) return null;
    const card = batch.cards[0];
    if (!card) return null;
    if (slot < 0 || slot >= state.players[actorId].board.slots.length) return null;
    return { type: 'PLACE_GIFT', cardId: card.id, slotIndex: slot };
  }

  if (state.currentPlayerIndex !== actorId) return null;

  switch (id) {
    case ID_DRAW_FROM_FIELD_0:
      if (state.phase !== 'awaitingDraw' || !state.field[0]) return null;
      return { type: 'DRAW_FROM_FIELD', pairIndex: 0 };
    case ID_DRAW_FROM_FIELD_1:
      if (state.phase !== 'awaitingDraw' || !state.field[1]) return null;
      return { type: 'DRAW_FROM_FIELD', pairIndex: 1 };
    case ID_DRAW_FROM_DECK:
      if (state.phase !== 'awaitingDraw') return null;
      if (state.deck.length === 0 && state.discardPile.length === 0) return null;
      return { type: 'DRAW_FROM_DECK' };
    case ID_CHOOSE_ADD_DRAW:
      if (state.phase !== 'awaitingAdditionalActionChoice') return null;
      if (state.deck.length === 0 && state.discardPile.length === 0) return null;
      return { type: 'CHOOSE_ADDITIONAL_DRAW' };
    case ID_CHOOSE_ADD_DISCARD: {
      if (state.phase !== 'awaitingAdditionalActionChoice') return null;
      const me = state.players[actorId];
      if (!me || !me.board.slots.some((s) => s.stack.length > 0)) return null;
      return { type: 'CHOOSE_ADDITIONAL_DISCARD' };
    }
    default:
      break;
  }

  if (id >= ID_PLACE_DRAWN_0_BASE && id < ID_PLACE_DRAWN_0_BASE + NUM_SLOTS) {
    if (state.phase !== 'awaitingPlaceDrawn') return null;
    const card = state.turn.pendingDraw[0];
    if (!card) return null;
    return { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: id - ID_PLACE_DRAWN_0_BASE };
  }
  if (id >= ID_PLACE_DRAWN_1_BASE && id < ID_PLACE_DRAWN_1_BASE + NUM_SLOTS) {
    if (state.phase !== 'awaitingPlaceDrawn') return null;
    const card = state.turn.pendingDraw[1];
    if (!card) return null;
    return { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: id - ID_PLACE_DRAWN_1_BASE };
  }
  if (id >= ID_PLACE_ADDITIONAL_DRAW_BASE && id < ID_PLACE_ADDITIONAL_DRAW_BASE + NUM_SLOTS) {
    if (state.phase !== 'awaitingPlaceAdditionalDraw') return null;
    return {
      type: 'PLACE_ADDITIONAL_DRAW',
      slotIndex: id - ID_PLACE_ADDITIONAL_DRAW_BASE,
    };
  }
  if (id >= ID_DISCARD_TOP_BASE && id < ID_DISCARD_TOP_BASE + NUM_SLOTS) {
    if (state.phase !== 'awaitingAdditionalDiscard') return null;
    const slotIndex = id - ID_DISCARD_TOP_BASE;
    const slot = state.players[actorId]?.board.slots[slotIndex];
    if (!slot || slot.stack.length === 0) return null;
    return { type: 'DISCARD_TOP', slotIndex };
  }

  return null;
}

export function legalActionMask(state: GameState, actorId: number): boolean[] {
  const mask = new Array<boolean>(ACTION_SPACE_SIZE).fill(false);
  for (let i = 0; i < ACTION_SPACE_SIZE; i++) {
    if (actionIdToAction(state, actorId, i)) mask[i] = true;
  }
  return mask;
}

export function legalActionIds(state: GameState, actorId: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < ACTION_SPACE_SIZE; i++) {
    if (actionIdToAction(state, actorId, i)) ids.push(i);
  }
  return ids;
}

/**
 * Action から ID への逆引き（学習データ生成・統計取得用）。
 * 一致する ID がなければ null（CONFIRM_GIFTS や NEW_GAME など）。
 */
export function actionToActionId(action: Action, state: GameState): number | null {
  switch (action.type) {
    case 'DRAW_FROM_FIELD':
      return action.pairIndex === 0 ? ID_DRAW_FROM_FIELD_0 : ID_DRAW_FROM_FIELD_1;
    case 'DRAW_FROM_DECK':
      return ID_DRAW_FROM_DECK;
    case 'CHOOSE_ADDITIONAL_DRAW':
      return ID_CHOOSE_ADD_DRAW;
    case 'CHOOSE_ADDITIONAL_DISCARD':
      return ID_CHOOSE_ADD_DISCARD;
    case 'PLACE_DRAWN': {
      const card0 = state.turn.pendingDraw[0];
      const card1 = state.turn.pendingDraw[1];
      if (card0 && card0.id === action.cardId) {
        return ID_PLACE_DRAWN_0_BASE + action.slotIndex;
      }
      if (card1 && card1.id === action.cardId) {
        return ID_PLACE_DRAWN_1_BASE + action.slotIndex;
      }
      return null;
    }
    case 'PLACE_ADDITIONAL_DRAW':
      return ID_PLACE_ADDITIONAL_DRAW_BASE + action.slotIndex;
    case 'DISCARD_TOP':
      return ID_DISCARD_TOP_BASE + action.slotIndex;
    case 'PLACE_GIFT':
      return ID_PLACE_GIFT_BASE + action.slotIndex;
    default:
      return null;
  }
}
