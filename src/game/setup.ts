import type {
  Card,
  FieldPair,
  GameState,
  Player,
  PlayerBoard,
  SetupOptions,
} from './types';
import { COLORS } from './types';
import { mulberry32, shuffle } from './rng';

const DEFAULT_SLOTS = 5;
const DEFAULT_CARDS_PER_COLOR = 20;

function makeBoard(slots: number): PlayerBoard {
  return {
    slots: Array.from({ length: slots }, () => ({ stack: [] })),
  };
}

function makePlayer(id: number, name: string, isCPU: boolean, slots: number): Player {
  return {
    id,
    name,
    isCPU,
    board: makeBoard(slots),
    score: 0,
  };
}

export function createDeck(cardsPerColor: number): Card[] {
  const deck: Card[] = [];
  for (const color of COLORS) {
    for (let i = 0; i < cardsPerColor; i++) {
      deck.push({ id: `${color}-${i}`, color });
    }
  }
  return deck;
}

function placeInitialCards(deck: Card[], players: Player[]): { deck: Card[]; players: Player[] } {
  let remaining = deck;
  const updated = players.map((p) => {
    const slots = p.board.slots.map((_, idx) => {
      const color = COLORS[idx % COLORS.length];
      const cardIdx = remaining.findIndex((c) => c.color === color);
      if (cardIdx < 0) return { stack: [] };
      const card = remaining[cardIdx];
      remaining = [
        ...remaining.slice(0, cardIdx),
        ...remaining.slice(cardIdx + 1),
      ];
      return { stack: [card] };
    });
    return { ...p, board: { slots } };
  });
  return { deck: remaining, players: updated };
}

function drawPair(deck: Card[]): { pair: FieldPair; remaining: Card[] } {
  if (deck.length < 2) {
    return { pair: null, remaining: deck };
  }
  const pair: FieldPair = [deck[0], deck[1]];
  return { pair, remaining: deck.slice(2) };
}

export function setupGame(options: SetupOptions = {}): GameState {
  const playerNames = options.playerNames ?? ['PLAYER', 'CPU-1', 'CPU-2', 'CPU-3'];
  const cpuFlags = options.cpuFlags ?? [false, true, true, true];
  const slots = options.slotsPerPlayer ?? DEFAULT_SLOTS;
  const cardsPerColor = options.cardsPerColor ?? DEFAULT_CARDS_PER_COLOR;
  const seed = options.seed ?? (Math.random() * 2 ** 31) | 0;

  const rand = mulberry32(seed);
  const baseDeck = createDeck(cardsPerColor);
  let deck = shuffle(baseDeck, rand);

  const basePlayers: Player[] = playerNames.map((name, i) =>
    makePlayer(i, name, cpuFlags[i] ?? true, slots)
  );

  const initial = placeInitialCards(deck, basePlayers);
  deck = initial.deck;
  const players = initial.players;

  const { pair: pair0, remaining: r1 } = drawPair(deck);
  const { pair: pair1, remaining: r2 } = drawPair(r1);
  deck = r2;

  const startPlayerIndex = Math.floor(rand() * players.length);

  return {
    players,
    currentPlayerIndex: startPlayerIndex,
    startPlayerIndex,
    deck,
    discardPile: [],
    field: [pair0, pair1],
    phase: 'awaitingDraw',
    turn: {
      pendingDraw: [],
      pendingAdditionalDraw: null,
      combosThisTurn: [],
      giftQueue: [],
      hasDrawn: false,
      pendingGiftBatches: [],
      discardedCardIds: [],
    },
    turnNumber: 1,
    endTriggered: false,
    endTriggerPlayerId: null,
    winnerId: null,
    log: [
      {
        turn: 0,
        playerName: 'システム',
        message: 'ゲーム開始',
        emphasize: true,
      },
      {
        turn: 0,
        playerName: 'システム',
        message: `スタートプレイヤー: ${players[startPlayerIndex].name}`,
        emphasize: true,
      },
    ],
    rngSeed: seed,
  };
}
