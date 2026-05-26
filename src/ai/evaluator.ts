import type { Color, GameState, Player } from '../game/types';
import { END_SCORE_THRESHOLD } from '../game/engine';
import { totalScoreForTurn } from '../game/scoring';

interface BoardSignal {
  reachByColor: Map<Color, number>;
  chainSeeds: number;
  totalCards: number;
}

function readBoardSignal(player: Player): BoardSignal {
  const reach = new Map<Color, number>();
  let chainSeeds = 0;
  let totalCards = 0;
  for (const slot of player.board.slots) {
    const stack = slot.stack;
    totalCards += stack.length;
    const top = stack[stack.length - 1];
    if (!top) continue;
    reach.set(top.color, (reach.get(top.color) ?? 0) + 1);
    const below = stack[stack.length - 2];
    if (below && below.color === top.color) chainSeeds += 1;
  }
  return { reachByColor: reach, chainSeeds, totalCards };
}

function selfScore(player: Player): number {
  const sig = readBoardSignal(player);
  let score = player.score * 100;
  for (const count of sig.reachByColor.values()) {
    if (count >= 5) score += 240;
    else if (count >= 4) score += 110;
    else if (count >= 3) score += 60;
    else if (count === 2) score += 18;
    else score += 1;
  }
  score += sig.chainSeeds * 8;

  const slotCount = player.board.slots.length;
  if (sig.totalCards > slotCount * 3) {
    score -= (sig.totalCards - slotCount * 3) * 6;
  }
  return score;
}

function threatScore(player: Player): number {
  const sig = readBoardSignal(player);
  let score = player.score * 70;
  if (player.score >= END_SCORE_THRESHOLD - 5) score += 50;
  for (const count of sig.reachByColor.values()) {
    if (count >= 3) score += 50;
    else if (count === 2) score += 12;
  }
  score += sig.chainSeeds * 4;
  score += player.pendingGifts.length * -2;
  return score;
}

export function evaluateState(state: GameState, playerId: number): number {
  const me = state.players[playerId];
  let value = selfScore(me);
  if (state.currentPlayerIndex === playerId) {
    const pending = totalScoreForTurn(state.turn.combosThisTurn);
    value += pending.total * 120;
  }
  for (const p of state.players) {
    if (p.id === playerId) continue;
    value -= threatScore(p);
  }
  if (state.winnerId === playerId) value += 4000;
  else if (state.winnerId !== null) value -= 3000;
  return value;
}

export function topColorCounts(player: Player): Map<Color, number> {
  return readBoardSignal(player).reachByColor;
}
