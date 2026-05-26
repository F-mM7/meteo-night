import type { Action, GameState, LogEntry, Player } from './types';
import { setupGame } from './setup';
import { totalScoreForTurn } from './scoring';
import {
  END_SCORE_THRESHOLD,
  computeWinner,
  drawFromDeck,
  getCurrentPlayer,
  nextPlayerIndex,
  placeCardOnSlot,
  popTopFromSlot,
  refillField,
  resolveCombosAtBoard,
  shouldEndGame,
} from './engine';

const COLOR_LABEL: Record<string, string> = {
  red: '赤',
  green: '緑',
  yellow: '黄',
  purple: '紫',
  blue: '青',
};

function appendLog(state: GameState, message: string, emphasize = false): GameState {
  const entry: LogEntry = {
    turn: state.turnNumber,
    playerName: getCurrentPlayer(state).name,
    message,
    emphasize,
  };
  return { ...state, log: [...state.log, entry].slice(-80) };
}

function appendSystemLog(state: GameState, message: string, emphasize = false): GameState {
  const entry: LogEntry = {
    turn: state.turnNumber,
    playerName: 'システム',
    message,
    emphasize,
  };
  return { ...state, log: [...state.log, entry].slice(-80) };
}

function updatePlayer(state: GameState, playerId: number, fn: (p: Player) => Player): GameState {
  return {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? fn(p) : p)),
  };
}

function resolveChainStep(state: GameState): GameState {
  const player = getCurrentPlayer(state);
  const { newBoard, combos } = resolveCombosAtBoard(player.board);
  if (combos.length === 0) {
    return tryTransitionAfterPlacement(state);
  }
  let next = updatePlayer(state, player.id, (p) => ({ ...p, board: newBoard }));
  next = {
    ...next,
    turn: {
      ...next.turn,
      combosThisTurn: [...next.turn.combosThisTurn, ...combos],
    },
  };
  for (const c of combos) {
    next = appendLog(
      next,
      `流星魔法 ${COLOR_LABEL[c.color]} ${c.cards.length}枚 (${c.basePoints}点)`,
      true
    );
  }
  next = { ...next, phase: 'awaitingAdditionalActionChoice' };
  return next;
}

function tryTransitionAfterPlacement(state: GameState): GameState {
  const player = getCurrentPlayer(state);

  if (player.pendingGifts.length > 0) {
    return { ...state, phase: 'awaitingPlacePendingGifts' };
  }

  if (state.turn.pendingDraw.length > 0) {
    return { ...state, phase: 'awaitingPlaceDrawn' };
  }

  if (state.turn.combosThisTurn.length > 0) {
    return finalizeTurnAfterCombos(state);
  }

  if (state.turn.hasDrawn) {
    return endTurn(state);
  }

  return { ...state, phase: 'awaitingDraw' };
}

function finalizeTurnAfterCombos(state: GameState): GameState {
  const player = getCurrentPlayer(state);
  const combos = state.turn.combosThisTurn;
  if (combos.length === 0) {
    return endTurn(state);
  }

  const { base, bonus, total } = totalScoreForTurn(combos);
  const newScore = player.score + total;
  let next = updatePlayer(state, player.id, (p) => ({ ...p, score: newScore }));
  next = appendLog(
    next,
    `得点: 基礎 ${base}点 + ボーナス ${bonus}点 = ${total}点 (累計 ${newScore}点)`,
    true
  );

  if (newScore >= END_SCORE_THRESHOLD && !next.endTriggered) {
    next = {
      ...next,
      endTriggered: true,
      endTriggerPlayerId: player.id,
    };
    next = appendSystemLog(next, `${player.name} が${END_SCORE_THRESHOLD}点に到達。最終ラウンドへ突入！`, true);
  }

  next = {
    ...next,
    turn: { ...next.turn, giftQueue: combos.slice() },
    phase: 'awaitingGiftSelection',
  };
  return next;
}

function endTurn(state: GameState): GameState {
  let next = state;

  if (shouldEndGame(next)) {
    const winnerId = computeWinner(next);
    next = appendSystemLog(
      { ...next, winnerId, phase: 'gameOver' },
      `ゲーム終了！ 勝者: ${next.players.find((p) => p.id === winnerId)?.name ?? '不明'}`,
      true
    );
    return next;
  }

  const nextIdx = nextPlayerIndex(next);
  next = {
    ...next,
    currentPlayerIndex: nextIdx,
    turnNumber: next.turnNumber + 1,
    turn: {
      pendingDraw: [],
      pendingAdditionalDraw: null,
      combosThisTurn: [],
      giftQueue: [],
      hasDrawn: false,
    },
  };

  const player = getCurrentPlayer(next);
  next = appendSystemLog(next, `${player.name} のターン開始`);

  if (player.pendingGifts.length > 0) {
    next = { ...next, phase: 'awaitingPlacePendingGifts' };
  } else {
    next = { ...next, phase: 'awaitingDraw' };
  }
  return next;
}

function handlePlacePendingGift(
  state: GameState,
  cardId: string,
  slotIndex: number
): GameState {
  if (state.phase !== 'awaitingPlacePendingGifts') return state;
  const player = getCurrentPlayer(state);
  const card = player.pendingGifts.find((c) => c.id === cardId);
  if (!card) return state;
  const remaining = player.pendingGifts.filter((c) => c.id !== cardId);
  let next = updatePlayer(state, player.id, (p) => ({
    ...p,
    pendingGifts: remaining,
    board: placeCardOnSlot(p.board, card, slotIndex),
  }));
  next = appendLog(next, `贈られた ${COLOR_LABEL[card.color]} をスロット${slotIndex + 1}に配置`);

  next = { ...next, phase: 'resolvingCombos' };
  return resolveChainStep(next);
}

function handleDrawFromField(state: GameState, pairIndex: 0 | 1): GameState {
  if (state.phase !== 'awaitingDraw') return state;
  const pair = state.field[pairIndex];
  if (!pair) return state;
  const newField: typeof state.field = [state.field[0], state.field[1]];
  newField[pairIndex] = null;
  let next: GameState = {
    ...state,
    field: newField,
    turn: { ...state.turn, pendingDraw: [pair[0], pair[1]], hasDrawn: true },
  };
  next = refillField(next);
  next = appendLog(
    next,
    `場から ${COLOR_LABEL[pair[0].color]}/${COLOR_LABEL[pair[1].color]} を取得`
  );
  next = { ...next, phase: 'awaitingPlaceDrawn' };
  return next;
}

function handleDrawFromDeck(state: GameState): GameState {
  if (state.phase !== 'awaitingDraw') return state;
  const r1 = drawFromDeck(state);
  if (!r1.card) {
    return appendSystemLog(state, '山札が空です', true);
  }
  const r2 = drawFromDeck(r1.state);
  const drawn = r2.card ? [r1.card, r2.card] : [r1.card];
  let next: GameState = {
    ...r2.state,
    turn: { ...r2.state.turn, pendingDraw: drawn, hasDrawn: true },
  };
  next = appendLog(next, `山札から ${drawn.length} 枚引いた`);
  next = { ...next, phase: 'awaitingPlaceDrawn' };
  return next;
}

function handlePlaceDrawn(state: GameState, cardId: string, slotIndex: number): GameState {
  if (state.phase !== 'awaitingPlaceDrawn') return state;
  const card = state.turn.pendingDraw.find((c) => c.id === cardId);
  if (!card) return state;
  const player = getCurrentPlayer(state);
  const remaining = state.turn.pendingDraw.filter((c) => c.id !== cardId);
  let next = updatePlayer(state, player.id, (p) => ({
    ...p,
    board: placeCardOnSlot(p.board, card, slotIndex),
  }));
  next = appendLog(next, `${COLOR_LABEL[card.color]} をスロット${slotIndex + 1}に配置`);
  next = {
    ...next,
    turn: { ...next.turn, pendingDraw: remaining },
  };

  if (remaining.length > 0) {
    return next;
  }
  next = { ...next, phase: 'resolvingCombos' };
  return resolveChainStep(next);
}

function handleChooseAdditionalDraw(state: GameState): GameState {
  if (state.phase !== 'awaitingAdditionalActionChoice') return state;
  const r = drawFromDeck(state);
  if (!r.card) {
    return appendSystemLog(state, '山札が空のため追加ドロー不可', true);
  }
  let next: GameState = {
    ...r.state,
    turn: { ...r.state.turn, pendingAdditionalDraw: r.card },
    phase: 'awaitingPlaceAdditionalDraw',
  };
  next = appendLog(next, `追加アクション: 山札から ${COLOR_LABEL[r.card.color]} を引いた`);
  return next;
}

function handleChooseAdditionalDiscard(state: GameState): GameState {
  if (state.phase !== 'awaitingAdditionalActionChoice') return state;
  let next: GameState = { ...state, phase: 'awaitingAdditionalDiscard' };
  next = appendLog(next, '追加アクション: 取り除きを選択');
  return next;
}

function handlePlaceAdditionalDraw(state: GameState, slotIndex: number): GameState {
  if (state.phase !== 'awaitingPlaceAdditionalDraw') return state;
  const card = state.turn.pendingAdditionalDraw;
  if (!card) return state;
  const player = getCurrentPlayer(state);
  let next = updatePlayer(state, player.id, (p) => ({
    ...p,
    board: placeCardOnSlot(p.board, card, slotIndex),
  }));
  next = appendLog(next, `引いた ${COLOR_LABEL[card.color]} をスロット${slotIndex + 1}に配置`);
  next = {
    ...next,
    turn: { ...next.turn, pendingAdditionalDraw: null },
    phase: 'resolvingCombos',
  };
  return resolveChainStep(next);
}

function handleDiscardTop(state: GameState, slotIndex: number): GameState {
  if (state.phase !== 'awaitingAdditionalDiscard') return state;
  const player = getCurrentPlayer(state);
  const result = popTopFromSlot(player.board, slotIndex);
  if (!result.card) return state;
  let next = updatePlayer(state, player.id, (p) => ({ ...p, board: result.board }));
  next = {
    ...next,
    discardPile: [...next.discardPile, result.card],
  };
  next = appendLog(next, `スロット${slotIndex + 1}の ${COLOR_LABEL[result.card.color]} を捨札`);
  next = { ...next, phase: 'resolvingCombos' };
  return resolveChainStep(next);
}

function handleGiveCard(
  state: GameState,
  comboIndex: number,
  cardId: string,
  targetPlayerId: number
): GameState {
  if (state.phase !== 'awaitingGiftSelection') return state;
  const queue = state.turn.giftQueue;
  if (comboIndex < 0 || comboIndex >= queue.length) return state;
  const combo = queue[comboIndex];
  const card = combo.cards.find((c) => c.id === cardId);
  if (!card) return state;
  if (targetPlayerId === state.currentPlayerIndex) return state;

  const remainingOfCombo = combo.cards.filter((c) => c.id !== cardId);
  const newQueue = queue.filter((_, i) => i !== comboIndex);

  let next = updatePlayer(state, targetPlayerId, (p) => ({
    ...p,
    pendingGifts: [...p.pendingGifts, card],
  }));
  next = appendLog(
    next,
    `コンボ${comboIndex + 1} の ${COLOR_LABEL[card.color]} を ${next.players[targetPlayerId].name} へ`
  );

  next = {
    ...next,
    discardPile: [...next.discardPile, ...remainingOfCombo],
    turn: { ...next.turn, giftQueue: newQueue },
  };

  if (newQueue.length === 0) {
    return endTurn(next);
  }
  return next;
}

export function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'NEW_GAME':
      return setupGame(action.options);
    case 'PLACE_PENDING_GIFT':
      return handlePlacePendingGift(state, action.cardId, action.slotIndex);
    case 'DRAW_FROM_FIELD':
      return handleDrawFromField(state, action.pairIndex);
    case 'DRAW_FROM_DECK':
      return handleDrawFromDeck(state);
    case 'PLACE_DRAWN':
      return handlePlaceDrawn(state, action.cardId, action.slotIndex);
    case 'CHOOSE_ADDITIONAL_DRAW':
      return handleChooseAdditionalDraw(state);
    case 'CHOOSE_ADDITIONAL_DISCARD':
      return handleChooseAdditionalDiscard(state);
    case 'PLACE_ADDITIONAL_DRAW':
      return handlePlaceAdditionalDraw(state, action.slotIndex);
    case 'DISCARD_TOP':
      return handleDiscardTop(state, action.slotIndex);
    case 'GIVE_CARD':
      return handleGiveCard(state, action.comboIndex, action.cardId, action.targetPlayerId);
    default:
      return state;
  }
}

export function endTurnForSkip(state: GameState): GameState {
  return endTurn(state);
}
