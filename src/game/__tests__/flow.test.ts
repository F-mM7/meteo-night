import { describe, it, expect } from 'vitest';
import { reducer } from '../reducer';
import { setupGame } from '../setup';
import { COLORS } from '../types';

describe('ゲーム基本フロー', () => {
  it('セットアップでフィールドに2組のペアが並ぶ', () => {
    const state = setupGame({ seed: 42 });
    expect(state.field[0]).not.toBeNull();
    expect(state.field[1]).not.toBeNull();
    expect(state.phase).toBe('awaitingDraw');
    expect(state.players).toHaveLength(4);
  });

  it('初期配置で全スロットに5色が1枚ずつ並ぶ', () => {
    const state = setupGame({ seed: 42 });
    for (const player of state.players) {
      const colors = player.board.slots.map((s) => s.stack[s.stack.length - 1]?.color);
      expect(colors).toHaveLength(5);
      const colorSet = new Set(colors);
      expect(colorSet.size).toBe(COLORS.length);
      for (const c of COLORS) expect(colorSet.has(c)).toBe(true);
    }
  });

  it('場から取ったらawaitingPlaceDrawnになる', () => {
    const state = setupGame({ seed: 42 });
    const next = reducer(state, { type: 'DRAW_FROM_FIELD', pairIndex: 0 });
    expect(next.phase).toBe('awaitingPlaceDrawn');
    expect(next.turn.pendingDraw).toHaveLength(2);
    expect(next.turn.hasDrawn).toBe(true);
  });

  it('引いた2枚を配置するとフェーズが進む', () => {
    let s = setupGame({ seed: 42 });
    s = reducer(s, { type: 'DRAW_FROM_FIELD', pairIndex: 0 });
    const c0 = s.turn.pendingDraw[0];
    const c1 = s.turn.pendingDraw[1];
    s = reducer(s, { type: 'PLACE_DRAWN', cardId: c0.id, slotIndex: 0 });
    s = reducer(s, { type: 'PLACE_DRAWN', cardId: c1.id, slotIndex: 1 });
    // 配置完了直後はコンボ解決待機（UI 側の演出時間を確保するため）
    expect(s.phase).toBe('resolvingCombos');
    // RESOLVE_COMBOS で連鎖判定を起動して次フェーズへ
    s = reducer(s, { type: 'RESOLVE_COMBOS' });
    expect(['awaitingDraw', 'awaitingAdditionalActionChoice', 'awaitingGiftSelection']).toContain(
      s.phase
    );
  });
});
