import type { Action, GameState, GiftAssignment, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { evaluateState, topColorCounts, type EvalWeights } from './evaluator';

export interface SmartOptions {
  /** 評価関数の重み。省略時は evaluator のモジュール global を使う。 */
  weights?: EvalWeights;
}

interface ScoredAction {
  action: Action;
  score: number;
}

/**
 * 状態とプレイヤー ID から決定論的に seed を生成する。
 * 同じ状態に再到達した場合でも常に同じ seed が出るが、
 * 通常の進行では log.length / turnNumber が変わるため挙動は変動する。
 */
function stateBaseSeed(state: GameState, playerId: number): number {
  const a = state.rngSeed >>> 0;
  const b = Math.imul(state.turnNumber + 1, 0x9e3779b1);
  const c = Math.imul(playerId + 1, 0x85ebca6b);
  const d = Math.imul(state.log.length + 1, 0xc2b2ae35);
  return (a ^ b ^ c ^ d) | 0;
}

function enumerateActions(state: GameState, playerId: number): Action[] {
  const player = state.players[playerId];
  const slotIdxs = player.board.slots.map((_, i) => i);

  if (state.phase === 'awaitingGiftPlacement') {
    const batch = state.turn.pendingGiftBatches[0];
    if (!batch || batch.recipientId !== playerId) return [];
    const acts: Action[] = [];
    for (const card of batch.cards) {
      for (const slotIndex of slotIdxs) {
        acts.push({ type: 'PLACE_GIFT', cardId: card.id, slotIndex });
      }
    }
    return acts;
  }

  if (state.currentPlayerIndex !== playerId) return [];

  switch (state.phase) {
    case 'awaitingDraw': {
      const acts: Action[] = [];
      if (state.field[0]) acts.push({ type: 'DRAW_FROM_FIELD', pairIndex: 0 });
      if (state.field[1]) acts.push({ type: 'DRAW_FROM_FIELD', pairIndex: 1 });
      if (state.deck.length > 0 || state.discardPile.length > 0) {
        acts.push({ type: 'DRAW_FROM_DECK' });
      }
      return acts;
    }
    case 'awaitingPlaceDrawn': {
      const card = state.turn.pendingDraw[0];
      if (!card) return [];
      return slotIdxs.map((slotIndex) => ({
        type: 'PLACE_DRAWN' as const,
        cardId: card.id,
        slotIndex,
      }));
    }
    case 'awaitingAdditionalActionChoice': {
      const acts: Action[] = [];
      const canDraw = state.deck.length > 0 || state.discardPile.length > 0;
      const canDiscard = player.board.slots.some((s) => s.stack.length > 0);
      if (canDraw) acts.push({ type: 'CHOOSE_ADDITIONAL_DRAW' });
      if (canDiscard) acts.push({ type: 'CHOOSE_ADDITIONAL_DISCARD' });
      return acts;
    }
    case 'awaitingPlaceAdditionalDraw':
      return slotIdxs.map((slotIndex) => ({
        type: 'PLACE_ADDITIONAL_DRAW' as const,
        slotIndex,
      }));
    case 'awaitingAdditionalDiscard':
      return slotIdxs
        .filter((i) => player.board.slots[i].stack.length > 0)
        .map((slotIndex) => ({
          type: 'DISCARD_TOP' as const,
          slotIndex,
        }));
    default:
      return [];
  }
}

function buildGiftAssignmentsHeuristic(state: GameState, playerId: number): GiftAssignment[] {
  const queue = state.turn.giftQueue;
  const opponents = state.players.filter((p) => p.id !== playerId);
  return queue.map((combo, comboIndex) => {
    const opponentTopThreat = opponents.reduce<Player>(
      (max, cur) => (cur.score > max.score ? cur : max),
      opponents[0]
    );
    let chosenCard = combo.cards[0];
    for (const c of combo.cards) {
      const cnt = topColorCounts(opponentTopThreat).get(c.color) ?? 0;
      const bestCnt = topColorCounts(opponentTopThreat).get(chosenCard.color) ?? 0;
      if (cnt < bestCnt) chosenCard = c;
    }
    let targetId = opponentTopThreat.id;
    for (const op of opponents) {
      const counts = topColorCounts(op);
      if ((counts.get(chosenCard.color) ?? 0) === 0 && op.score < opponentTopThreat.score) {
        targetId = op.id;
      }
    }
    return { comboIndex, cardId: chosenCard.id, targetPlayerId: targetId };
  });
}

function evaluateUnknownDraw(
  state: GameState,
  action: Action,
  playerId: number,
  baseSeed: number,
  weights: EvalWeights | undefined
): number {
  const samples = 4;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const rand = mulberry32((baseSeed + Math.imul(i + 1, 0x9e3779b1)) | 0);
    const shuffled = shuffle(state.deck, rand);
    const reshuffled: GameState = { ...state, deck: shuffled };
    const next = stepGame(reshuffled, action);
    total += evaluateState(next, playerId, weights);
  }
  return total / samples;
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: SmartOptions = {}
): Action | null {
  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;
  const weights = options.weights;

  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    const assignments = buildGiftAssignmentsHeuristic(state, playerId);
    return { type: 'CONFIRM_GIFTS', assignments };
  }

  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) return null;

  const actions = enumerateActions(state, playerId);
  if (actions.length === 0) return null;

  const scored: ScoredAction[] = actions.map((action) => {
    let score = -Infinity;
    try {
      if (action.type === 'DRAW_FROM_DECK' || action.type === 'CHOOSE_ADDITIONAL_DRAW') {
        score = evaluateUnknownDraw(state, action, playerId, baseSeed, weights);
      } else {
        const nextState = stepGame(state, action);
        score = evaluateState(nextState, playerId, weights);
      }
    } catch {
      score = -Infinity;
    }
    return { action, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];

  const topScore = top.score;
  const tied = scored.filter((s) => s.score >= topScore - 0.5);
  const tieRand = mulberry32((baseSeed ^ 0x9e3779b9) | 0);
  const picked = tied[Math.floor(tieRand() * tied.length)] ?? top;
  return picked.action;
}
