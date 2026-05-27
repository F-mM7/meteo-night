import type { GameState } from '../game/types';
import { mulberry32, shuffle } from '../game/rng';

/**
 * 山札の順序をシャッフルした state を返す。
 * 山札は本来「観測できない情報」なので、IS-MCTS / PIMC の探索ループ先頭で
 * determinize するために使う想定。捨札はそのまま保持する（公開情報のため）。
 */
export function determinizeDeck(state: GameState, seed: number): GameState {
  if (state.deck.length <= 1) return state;
  const rand = mulberry32(seed >>> 0);
  return {
    ...state,
    deck: shuffle(state.deck, rand),
  };
}

/**
 * viewer 視点での観測情報集合のキー文字列を返す。
 * IS-MCTS の transposition / 統計集約に使うことを想定。
 * 山札・捨札は枚数/色別カウントのみで順序は含めない（順序は不可視扱い）。
 */
export function observationKey(state: GameState, viewerId: number): string {
  const parts: string[] = [
    `ph:${state.phase}`,
    `cp:${state.currentPlayerIndex}`,
    `tn:${state.turnNumber}`,
    `et:${state.endTriggered ? 1 : 0}`,
  ];

  for (let i = 0; i < state.players.length; i++) {
    const pid = (viewerId + i) % state.players.length;
    const p = state.players[pid];
    const boardStr = p.board.slots
      .map((s) => s.stack.map((c) => c.color[0]).join(''))
      .join('|');
    parts.push(`P${i}:${p.score}:${boardStr}`);
  }

  const fieldStr = state.field
    .map((pair) => (pair ? pair.map((c) => c.color[0]).join('') : '_'))
    .join(',');
  parts.push(`F:${fieldStr}`);

  parts.push(`D:${state.deck.length}`);

  const discardCounts = new Map<string, number>();
  for (const c of state.discardPile) {
    discardCounts.set(c.color, (discardCounts.get(c.color) ?? 0) + 1);
  }
  const sortedDiscard = Array.from(discardCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}${v}`)
    .join('');
  parts.push(`X:${sortedDiscard}`);

  if (state.phase === 'awaitingPlaceDrawn') {
    parts.push('pd:' + state.turn.pendingDraw.map((c) => c.color[0]).join(''));
  }
  if (state.phase === 'awaitingPlaceAdditionalDraw' && state.turn.pendingAdditionalDraw) {
    parts.push('pa:' + state.turn.pendingAdditionalDraw.color[0]);
  }
  if (
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches.length > 0
  ) {
    const b = state.turn.pendingGiftBatches[0];
    parts.push(
      `g:${(b.recipientId - viewerId + state.players.length) % state.players.length}:` +
        b.cards.map((c) => c.color[0]).join('')
    );
  }

  return parts.join('||');
}
