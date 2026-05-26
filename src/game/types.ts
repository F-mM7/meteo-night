export const COLORS = ['red', 'green', 'yellow', 'purple', 'blue'] as const;
export type Color = (typeof COLORS)[number];

export interface Card {
  id: string;
  color: Color;
}

export interface Slot {
  stack: Card[];
}

export interface PlayerBoard {
  slots: Slot[];
}

export interface Player {
  id: number;
  name: string;
  isCPU: boolean;
  board: PlayerBoard;
  score: number;
}

export type FieldPair = [Card, Card] | null;

export type Phase =
  | 'awaitingDraw'
  | 'awaitingPlaceDrawn'
  | 'resolvingCombos'
  | 'awaitingAdditionalActionChoice'
  | 'awaitingPlaceAdditionalDraw'
  | 'awaitingAdditionalDiscard'
  | 'awaitingGiftSelection'
  | 'awaitingGiftPlacement'
  | 'turnEnd'
  | 'gameOver';

export interface ComboRecord {
  color: Color;
  cards: Card[];
  basePoints: number;
}

export interface GiftBatch {
  recipientId: number;
  cards: Card[];
}

export interface GiftAssignment {
  comboIndex: number;
  cardId: string;
  targetPlayerId: number;
}

export interface TurnState {
  pendingDraw: Card[];
  pendingAdditionalDraw: Card | null;
  combosThisTurn: ComboRecord[];
  giftQueue: ComboRecord[];
  hasDrawn: boolean;
  pendingGiftBatches: GiftBatch[];
}

export interface LogEntry {
  turn: number;
  playerName: string;
  message: string;
  emphasize?: boolean;
}

export interface GameState {
  players: Player[];
  currentPlayerIndex: number;
  startPlayerIndex: number;
  deck: Card[];
  discardPile: Card[];
  field: [FieldPair, FieldPair];
  phase: Phase;
  turn: TurnState;
  turnNumber: number;
  endTriggered: boolean;
  endTriggerPlayerId: number | null;
  winnerId: number | null;
  log: LogEntry[];
  rngSeed: number;
}

export interface SetupOptions {
  playerNames?: string[];
  cpuFlags?: boolean[];
  slotsPerPlayer?: number;
  cardsPerColor?: number;
  initialHandRounds?: number;
  seed?: number;
}

export type Action =
  | { type: 'NEW_GAME'; options?: SetupOptions }
  | { type: 'DRAW_FROM_FIELD'; pairIndex: 0 | 1 }
  | { type: 'DRAW_FROM_DECK' }
  | { type: 'PLACE_DRAWN'; cardId: string; slotIndex: number }
  | { type: 'CHOOSE_ADDITIONAL_DRAW' }
  | { type: 'CHOOSE_ADDITIONAL_DISCARD' }
  | { type: 'PLACE_ADDITIONAL_DRAW'; slotIndex: number }
  | { type: 'DISCARD_TOP'; slotIndex: number }
  | { type: 'CONFIRM_GIFTS'; assignments: GiftAssignment[] }
  | { type: 'PLACE_GIFT'; cardId: string; slotIndex: number };
