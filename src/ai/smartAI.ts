import type { Action, GameState, Player } from '../game/types';
import { reducer } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { evaluateState, topColorCounts } from './evaluator';

interface ScoredAction {
  action: Action;
  score: number;
}

function enumerateActions(state: GameState, playerId: number): Action[] {
  const player = state.players[playerId];
  const slotIdxs = player.board.slots.map((_, i) => i);

  switch (state.phase) {
    case 'awaitingPlacePendingGifts': {
      const card = player.pendingGifts[0];
      if (!card) return [];
      return slotIdxs.map((slotIndex) => ({
        type: 'PLACE_PENDING_GIFT' as const,
        cardId: card.id,
        slotIndex,
      }));
    }
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
    case 'awaitingAdditionalActionChoice':
      return [
        { type: 'CHOOSE_ADDITIONAL_DRAW' },
        { type: 'CHOOSE_ADDITIONAL_DISCARD' },
      ];
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
    case 'awaitingGiftSelection': {
      const combo = state.turn.giftQueue[0];
      if (!combo) return [];
      const acts: Action[] = [];
      for (const c of combo.cards) {
        for (const p of state.players) {
          if (p.id === playerId) continue;
          acts.push({
            type: 'GIVE_CARD',
            comboIndex: 0,
            cardId: c.id,
            targetPlayerId: p.id,
          });
        }
      }
      return acts;
    }
    default:
      return [];
  }
}

function pickGiftTargetHeuristic(state: GameState, playerId: number): Action | null {
  const combo = state.turn.giftQueue[0];
  if (!combo) return null;
  const opponents = state.players.filter((p) => p.id !== playerId);
  const opponentMostThreat = opponents.reduce<Player>((max, cur) =>
    cur.score > max.score ? cur : max
  , opponents[0]);

  let chosenCard = combo.cards[0];
  for (const c of combo.cards) {
    const counts = topColorCounts(opponentMostThreat);
    const cnt = counts.get(c.color) ?? 0;
    const bestCounts = topColorCounts(opponentMostThreat);
    const bestCnt = bestCounts.get(chosenCard.color) ?? 0;
    if (cnt < bestCnt) chosenCard = c;
  }

  let targetId = opponentMostThreat.id;
  for (const op of opponents) {
    const counts = topColorCounts(op);
    if ((counts.get(chosenCard.color) ?? 0) === 0 && op.score < opponentMostThreat.score) {
      targetId = op.id;
    }
  }
  return {
    type: 'GIVE_CARD',
    comboIndex: 0,
    cardId: chosenCard.id,
    targetPlayerId: targetId,
  };
}

function evaluateUnknownDraw(
  state: GameState,
  action: Action,
  playerId: number
): number {
  const samples = 4;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const rand = mulberry32((Date.now() + i) | 0);
    const shuffled = shuffle(state.deck, rand);
    const reshuffled: GameState = { ...state, deck: shuffled };
    const next = reducer(reshuffled, action);
    total += evaluateState(next, playerId);
  }
  return total / samples;
}

export function decideAction(state: GameState, playerId: number): Action | null {
  if (state.currentPlayerIndex !== playerId) return null;

  if (state.phase === 'awaitingGiftSelection') {
    const heuristic = pickGiftTargetHeuristic(state, playerId);
    if (heuristic) return heuristic;
  }

  const actions = enumerateActions(state, playerId);
  if (actions.length === 0) return null;

  const scored: ScoredAction[] = actions.map((action) => {
    let score = -Infinity;
    try {
      if (action.type === 'DRAW_FROM_DECK' || action.type === 'CHOOSE_ADDITIONAL_DRAW') {
        score = evaluateUnknownDraw(state, action, playerId);
      } else {
        const nextState = reducer(state, action);
        score = evaluateState(nextState, playerId);
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
  const picked = tied[Math.floor(Math.random() * tied.length)] ?? top;
  return picked.action;
}
