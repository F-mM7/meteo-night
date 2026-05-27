import type { Card, ComboRecord, GameState, PlayerBoard } from './types';
import { detectCombos, removeTopCardsFromSlots } from './combo';
import { basePointsForSize } from './scoring';
import { mulberry32, shuffle } from './rng';

export const END_SCORE_THRESHOLD = 20;

export function placeCardOnSlot(board: PlayerBoard, card: Card, slotIndex: number): PlayerBoard {
  return {
    slots: board.slots.map((s, idx) =>
      idx === slotIndex ? { stack: [...s.stack, card] } : s
    ),
  };
}

export function popTopFromSlot(board: PlayerBoard, slotIndex: number): {
  board: PlayerBoard;
  card: Card | null;
} {
  const slot = board.slots[slotIndex];
  if (!slot || slot.stack.length === 0) return { board, card: null };
  const card = slot.stack[slot.stack.length - 1];
  const newBoard: PlayerBoard = {
    slots: board.slots.map((s, idx) =>
      idx === slotIndex ? { stack: s.stack.slice(0, -1) } : s
    ),
  };
  return { board: newBoard, card };
}

export function reshuffleDiscardIntoDeck(state: GameState): GameState {
  if (state.discardPile.length === 0) return state;
  const rand = mulberry32((state.rngSeed + state.turnNumber + state.deck.length) | 0);
  const shuffled = shuffle(state.discardPile, rand);
  return {
    ...state,
    deck: [...state.deck, ...shuffled],
    discardPile: [],
  };
}

export function drawFromDeck(state: GameState): { state: GameState; card: Card | null } {
  let s = state;
  if (s.deck.length === 0) {
    s = reshuffleDiscardIntoDeck(s);
  }
  if (s.deck.length === 0) {
    return { state: s, card: null };
  }
  const card = s.deck[0];
  return {
    state: { ...s, deck: s.deck.slice(1) },
    card,
  };
}

export function refillField(state: GameState): GameState {
  const newField: typeof state.field = [state.field[0], state.field[1]];
  let working = state;
  for (let i = 0; i < 2; i++) {
    if (newField[i] === null) {
      const r1 = drawFromDeck(working);
      working = r1.state;
      if (!r1.card) break;
      const r2 = drawFromDeck(working);
      working = r2.state;
      if (!r2.card) {
        newField[i] = null;
        working = { ...working, deck: [r1.card, ...working.deck] };
        break;
      }
      newField[i] = [r1.card, r2.card];
    }
  }
  return { ...working, field: newField };
}

export function resolveCombosAtBoard(
  board: PlayerBoard
): { newBoard: PlayerBoard; combos: ComboRecord[] } {
  const combos: ComboRecord[] = [];
  const detected = detectCombos(board);
  if (detected.length === 0) {
    return { newBoard: board, combos };
  }
  let newBoard = board;
  for (const d of detected) {
    combos.push({
      color: d.color,
      cards: d.cards,
      basePoints: basePointsForSize(d.cards.length),
    });
    newBoard = removeTopCardsFromSlots(newBoard, d.slotIndices);
  }
  return { newBoard, combos };
}

export function getCurrentPlayer(state: GameState) {
  return state.players[state.currentPlayerIndex];
}

export function nextPlayerIndex(state: GameState): number {
  return (state.currentPlayerIndex + 1) % state.players.length;
}

export function shouldEndGame(state: GameState): boolean {
  if (!state.endTriggered) return false;
  return nextPlayerIndex(state) === state.startPlayerIndex;
}

/**
 * 最終ラウンドが確定している前提で、対象プレイヤーがこのゲームでもう自分の手番を持たないか判定する。
 *
 * 最終ラウンドは `endTriggerPlayerId` から `startPlayerIndex` の手前まで時計回りに1周分。
 * - そのターン順序の外にいるプレイヤーは元々ターンが来ないので「終えた」扱い
 * - そのターン順序の内にいて、現在進行中のプレイヤーより手前にいるプレイヤーは既にターンを終えている
 * - 現在進行中のプレイヤー自身、および現在より後にいるプレイヤーは「まだ」
 *
 * `endTriggered` が立っていない通常進行中は常に false。
 */
export function hasNoMoreTurns(state: GameState, playerId: number): boolean {
  if (!state.endTriggered || state.endTriggerPlayerId === null) return false;
  const n = state.players.length;
  if (n === 0) return false;
  const start = state.endTriggerPlayerId;
  const playerOffset = (playerId - start + n) % n;
  const currentOffset = (state.currentPlayerIndex - start + n) % n;
  const rawEnd = (state.startPlayerIndex - start + n) % n;
  // endTrigger と startPlayer が同一プレイヤーの場合、最終ラウンドは完全な1周。
  const endOffset = rawEnd === 0 ? n : rawEnd;
  if (playerOffset >= endOffset) return true;
  return playerOffset < currentOffset;
}

export function computeWinner(state: GameState): number | null {
  if (state.players.length === 0) return null;
  const sorted = [...state.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = (a.id - state.startPlayerIndex + state.players.length) % state.players.length;
    const distB = (b.id - state.startPlayerIndex + state.players.length) % state.players.length;
    return distA - distB;
  });
  return sorted[0].id;
}
