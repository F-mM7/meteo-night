import type { Action, GameState, GiftAssignment, GiftBatch, LogEntry, Player } from './types';
import { setupGame } from './setup';
import { totalScoreForTurn } from './scoring';
import { COLOR_LABEL } from './labels';
import {
  END_SCORE_THRESHOLD,
  computeWinner,
  drawFromDeck,
  getCurrentPlayer,
  hasNoMoreTurns,
  nextPlayerIndex,
  placeCardOnSlot,
  popTopFromSlot,
  refillField,
  resolveCombosAtBoard,
  shouldEndGame,
} from './engine';

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

/**
 * 全プレイヤー・全スロット・全スタックを走査して card.id の一覧を返す。
 * `NEW_GAME` / `CLEAR_BOARDS_FOR_RESET` で「旧ゲームのカードを discard 由来扱いで
 * 外側フェードアウトさせる」ためにマーク対象 ID を集める用途に使う。
 */
function collectAllBoardCardIds(state: GameState): string[] {
  const ids: string[] = [];
  for (const p of state.players) {
    for (const s of p.board.slots) {
      for (const c of s.stack) {
        ids.push(c.id);
      }
    }
  }
  return ids;
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
  // 連鎖発火後の追加アクションが両方とも実行不可なら、強制スキップして得点処理へ進む
  // （ルール上「引いて配置」も「取り除き」も成立しないケース＝山札も捨札もボードも空）
  const updatedPlayer = next.players[player.id];
  const canDraw = next.deck.length > 0 || next.discardPile.length > 0;
  const canDiscard = updatedPlayer.board.slots.some((s) => s.stack.length > 0);
  if (!canDraw && !canDiscard) {
    next = appendSystemLog(next, '追加アクション不可（山札・ボードともに空のため自動スキップ）', false);
    return finalizeTurnAfterCombos(next);
  }
  next = { ...next, phase: 'awaitingAdditionalActionChoice' };
  return next;
}

function tryTransitionAfterPlacement(state: GameState): GameState {
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
  let next = refillField(state);

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
      pendingGiftBatches: [],
      discardedCardIds: [],
    },
    phase: 'awaitingDraw',
  };

  const player = getCurrentPlayer(next);
  next = appendSystemLog(next, `${player.name} のターン開始`);
  return next;
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
  next = {
    ...next,
    turn: { ...next.turn, pendingDraw: remaining },
  };

  if (remaining.length > 0) {
    return next;
  }
  // 配置の視認時間を確保するため、ここでは resolveChainStep を呼ばない。
  // useGameLogic が遅延後に RESOLVE_COMBOS を dispatch して連鎖判定を行う。
  return { ...next, phase: 'resolvingCombos' };
}

function handleChooseAdditionalDraw(state: GameState): GameState {
  if (state.phase !== 'awaitingAdditionalActionChoice') return state;
  const r = drawFromDeck(state);
  if (!r.card) {
    // 山札・捨札ともに空でドローを成立させられない場合は state を返さない。
    // UI 側で「引いて配置」ボタンを無効化するため、通常はここに到達しない。
    return state;
  }
  let next: GameState = {
    ...r.state,
    turn: { ...r.state.turn, pendingAdditionalDraw: r.card },
    phase: 'awaitingPlaceAdditionalDraw',
  };
  next = appendLog(next, `追加アクション: ドロー→${COLOR_LABEL[r.card.color]}`);
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
  // 追加配置の視認時間を確保するため、ここでは resolveChainStep を呼ばない。
  return {
    ...next,
    turn: { ...next.turn, pendingAdditionalDraw: null },
    phase: 'resolvingCombos',
  };
}

function handleDiscardTop(state: GameState, slotIndex: number): GameState {
  if (state.phase !== 'awaitingAdditionalDiscard') return state;
  const player = getCurrentPlayer(state);
  const result = popTopFromSlot(player.board, slotIndex);
  if (!result.card) return state;
  const discardedCard = result.card;
  let next = updatePlayer(state, player.id, (p) => ({ ...p, board: result.board }));
  next = {
    ...next,
    discardPile: [...next.discardPile, discardedCard],
    turn: {
      ...next.turn,
      discardedCardIds: [...next.turn.discardedCardIds, discardedCard.id],
    },
  };
  next = appendLog(next, `スロット${slotIndex + 1}の ${COLOR_LABEL[discardedCard.color]} を捨札`);
  // 取り除きの視認時間を確保するため、ここでは resolveChainStep を呼ばない。
  return { ...next, phase: 'resolvingCombos' };
}

function handleResolveCombos(state: GameState): GameState {
  if (state.phase !== 'resolvingCombos') return state;
  return resolveChainStep(state);
}

function validateAssignments(
  state: GameState,
  assignments: GiftAssignment[]
): { valid: boolean; givenCardIds: Set<string> } {
  const queue = state.turn.giftQueue;
  const givenCardIds = new Set<string>();

  if (assignments.length !== queue.length) {
    return { valid: false, givenCardIds };
  }
  const seenCombos = new Set<number>();
  for (const a of assignments) {
    if (seenCombos.has(a.comboIndex)) return { valid: false, givenCardIds };
    seenCombos.add(a.comboIndex);
    const combo = queue[a.comboIndex];
    if (!combo) return { valid: false, givenCardIds };
    const card = combo.cards.find((c) => c.id === a.cardId);
    if (!card) return { valid: false, givenCardIds };
    if (a.targetPlayerId === state.currentPlayerIndex) return { valid: false, givenCardIds };
    if (!state.players[a.targetPlayerId]) return { valid: false, givenCardIds };
    givenCardIds.add(a.cardId);
  }
  return { valid: true, givenCardIds };
}

function handleConfirmGifts(state: GameState, assignments: GiftAssignment[]): GameState {
  if (state.phase !== 'awaitingGiftSelection') return state;
  const queue = state.turn.giftQueue;
  if (queue.length === 0) return endTurn(state);

  const { valid, givenCardIds } = validateAssignments(state, assignments);
  if (!valid) return state;

  const batchMap = new Map<number, GiftBatch>();
  for (const a of assignments) {
    const combo = queue[a.comboIndex];
    const card = combo.cards.find((c) => c.id === a.cardId)!;
    const existing = batchMap.get(a.targetPlayerId);
    if (existing) {
      existing.cards.push(card);
    } else {
      batchMap.set(a.targetPlayerId, { recipientId: a.targetPlayerId, cards: [card] });
    }
  }

  const allCards = queue.flatMap((c) => c.cards);
  const discardCards = allCards.filter((c) => !givenCardIds.has(c.id));
  const batches = Array.from(batchMap.values());

  // 最終ラウンドが確定していて、受領者がもう自分の手番を持たない場合は
  // 配置場所が勝敗に影響しないので、スロット1（index 0）へ自動配置する。
  const autoBatches: GiftBatch[] = [];
  const manualBatches: GiftBatch[] = [];
  for (const b of batches) {
    if (hasNoMoreTurns(state, b.recipientId)) {
      autoBatches.push(b);
    } else {
      manualBatches.push(b);
    }
  }

  let next: GameState = {
    ...state,
    discardPile: [...state.discardPile, ...discardCards],
    turn: { ...state.turn, giftQueue: [], pendingGiftBatches: manualBatches },
  };

  if (batches.length > 0) {
    const lines = ['配布 :'];
    for (const batch of batches) {
      const target = next.players[batch.recipientId];
      const colors = batch.cards.map((c) => COLOR_LABEL[c.color]).join(', ');
      lines.push(`${colors} → ${target.name}`);
    }
    next = appendLog(next, lines.join('\n'), true);
  }

  for (const batch of autoBatches) {
    for (const card of batch.cards) {
      next = updatePlayer(next, batch.recipientId, (p) => ({
        ...p,
        board: placeCardOnSlot(p.board, card, 0),
      }));
    }
  }

  if (manualBatches.length === 0) {
    return endTurn(next);
  }
  return { ...next, phase: 'awaitingGiftPlacement' };
}

function handlePlaceGift(state: GameState, cardId: string, slotIndex: number): GameState {
  if (state.phase !== 'awaitingGiftPlacement') return state;
  const batches = state.turn.pendingGiftBatches;
  if (batches.length === 0) return endTurn(state);

  const currentBatch = batches[0];
  const card = currentBatch.cards.find((c) => c.id === cardId);
  if (!card) return state;

  let next = updatePlayer(state, currentBatch.recipientId, (p) => ({
    ...p,
    board: placeCardOnSlot(p.board, card, slotIndex),
  }));

  const remainingCards = currentBatch.cards.filter((c) => c.id !== cardId);
  const newBatches: GiftBatch[] = [];
  if (remainingCards.length > 0) {
    newBatches.push({ ...currentBatch, cards: remainingCards });
  }
  newBatches.push(...batches.slice(1));

  next = {
    ...next,
    turn: { ...next.turn, pendingGiftBatches: newBatches },
  };

  if (newBatches.length === 0) {
    return endTurn(next);
  }
  return next;
}

export function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'NEW_GAME': {
      // 新規ゲーム開始時に旧ゲームの場札・スロット内カードを
      // 「discard 由来で消えた」とマークし、UI 側で外側へフェードアウトさせる。
      // （未マークだとデフォルトで「魔法発動 = 中央吸い込み」扱いになるため）
      const oldCardIds = collectAllBoardCardIds(state);
      const next = setupGame(action.options);
      return {
        ...next,
        turn: { ...next.turn, discardedCardIds: oldCardIds },
      };
    }
    case 'CLEAR_BOARDS_FOR_RESET': {
      // 新規ゲーム開始の前段として、全プレイヤーのスロットを空にして
      // 既存カードを外側フェードアウト（discard 由来扱い）させる中間状態。
      // 後段の NEW_GAME を待つ間、AI 思考が走らないよう phase を gameOver に固定する。
      const oldCardIds = collectAllBoardCardIds(state);
      return {
        ...state,
        players: state.players.map((p) => ({
          ...p,
          board: {
            ...p.board,
            slots: p.board.slots.map((s) => ({ ...s, stack: [] })),
          },
        })),
        phase: 'gameOver',
        turn: { ...state.turn, discardedCardIds: oldCardIds },
      };
    }
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
    case 'CONFIRM_GIFTS':
      return handleConfirmGifts(state, action.assignments);
    case 'PLACE_GIFT':
      return handlePlaceGift(state, action.cardId, action.slotIndex);
    case 'RESOLVE_COMBOS':
      return handleResolveCombos(state);
    default:
      return state;
  }
}

/**
 * 1 ターンの連鎖解決ループ（`resolvingCombos` → 新コンボ発火 → 再び `resolvingCombos` …）の
 * 安全上限。1 ターンに配置できるカードは最大スロット数（5）枚であり、
 * 各カードあたり最大 1 連鎖までしか起きないため、理論上は十分余裕がある。
 * これに到達した場合は連鎖解決ロジックのバグ（無限ループ）の可能性が高いため
 * `console.warn` で気付けるようにする。
 */
const MAX_CHAIN_RESOLVE_STEPS = 16;

/**
 * 配置/取り除き直後に `resolvingCombos` フェーズで一時停止する仕組みは UI 演出用。
 * AI シミュレーション・ベンチ・テストでは即時に連鎖まで解決したいので、
 * `reducer` 呼び出し後に `resolvingCombos` 状態に陥ったら自動で
 * `RESOLVE_COMBOS` を続けて適用する薄いラッパーを提供する。
 */
export function stepGame(state: GameState, action: Action): GameState {
  let s = reducer(state, action);
  let safety = 0;
  while (s.phase === 'resolvingCombos' && safety < MAX_CHAIN_RESOLVE_STEPS) {
    s = reducer(s, { type: 'RESOLVE_COMBOS' });
    safety++;
  }
  if (s.phase === 'resolvingCombos') {
    // 正常系では到達しないため、ここに来た場合は連鎖解決ロジックの不具合を疑う。
    console.warn(
      `[stepGame] resolvingCombos did not terminate within ${MAX_CHAIN_RESOLVE_STEPS} steps ` +
        `(turn=${s.turnNumber}, player=${s.currentPlayerIndex})`
    );
  }
  return s;
}
