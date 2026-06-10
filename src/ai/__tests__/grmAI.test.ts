import { describe, it, expect } from 'vitest';
import { setupGame } from '../../game/setup';
import { stepGame } from '../../game/reducer';
import { decideAction as decideGrm, type GrmOptions } from '../grmAI';
import type { Card, Color, GameState, PlayerBoard } from '../../game/types';

function actorOf(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

/**
 * 全席を GRM にして 1 ゲーム進める（相手由来の停止を排除し、GRM が全フェーズで停滞しないことだけを見る）。
 * K を小さくして f を浅くし高速化（強さでなく堅牢性の確認が目的）。GRM が手番で null や no-op
 * （reducer に拒否される非合法手）を返したら stuck を加算。返り値は {steps, stuck}。
 */
function runAllGrm(seed: number, maxSteps: number): { steps: number; stuck: number } {
  const opts: GrmOptions = { V: 20, P: 0.5, K: 3 };
  let state = setupGame({ seed, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
  let steps = 0;
  let stuck = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = actorOf(state);
    const action = decideGrm(state, actor, undefined, opts);
    if (!action) {
      stuck++;
      break;
    }
    const before = state;
    state = stepGame(state, action);
    if (state === before) {
      stuck++; // reducer に拒否された＝非合法手
      break;
    }
    steps++;
  }
  return { steps, stuck };
}

describe('grmAI 堅牢性: 全フェーズで合法手を返し停滞しない', () => {
  // 全席 GRM でフレッシュ局面から数手進め、GRM が手番で null や no-op（非合法手）を一切出さないことを確認。
  // 1 手の思考が重いので手数は少なめに制限（強さでなく停滞バグが無いことの確認が目的）。
  it('GRM が連続して合法手を返し手番が進む', { timeout: 90_000 }, () => {
    for (const seed of [1, 2]) {
      const r = runAllGrm(seed, 8);
      expect(r.stuck, `seed=${seed} で GRM が停滞（非合法手/null）`).toBe(0);
      expect(r.steps, `seed=${seed} で進行していない`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('grmAI 配置の順序完全性: 取得2枚をどちらから置くか（同一スロット積みの上下順）も考慮する', () => {
  it('4スロット赤+空き1で[赤,緑]取得 → 緑を空きへ置いてから赤を重ね5スロット赤top(size5=G)を作る', () => {
    // 赤先だと空きに赤を置いても、緑がどこかの赤topを潰して5枚揃わない。緑→赤の逆順を選べて初めて
    // [緑,赤]（赤が上）で5スロット赤top → size5=10点 → G(V=10,P=1)。実着手で緑カードを先に置けるか。
    const R: Color = 'red';
    const G: Color = 'green';
    const base = setupGame({ seed: 5, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
    let uid = 0;
    const mk = (c: Color): Card => ({ id: `b${uid++}-${c}`, color: c });
    const board: PlayerBoard = { slots: [[R], [R], [R], [R], []].map((st) => ({ stack: st.map(mk) })) };
    const empty = (): PlayerBoard => ({ slots: [0, 1, 2, 3, 4].map(() => ({ stack: [] as Card[] })) });
    const redCard: Card = { id: 'pend-red', color: R };
    const greenCard: Card = { id: 'pend-green', color: G };
    const state: GameState = {
      ...base,
      currentPlayerIndex: 0,
      startPlayerIndex: 0,
      players: base.players.map((p, i) => (i === 0 ? { ...p, board, score: 0 } : { ...p, board: empty(), score: 0 })),
      deck: [],
      discardPile: [],
      field: [null, null],
      phase: 'awaitingPlaceDrawn',
      turn: { ...base.turn, pendingDraw: [redCard, greenCard], hasDrawn: true },
    };
    const action = decideGrm(state, 0, undefined, { V: 10, P: 1, K: 6 });
    expect(action?.type).toBe('PLACE_DRAWN');
    if (action && action.type === 'PLACE_DRAWN') {
      // 緑カードを先に空きスロット(#4)へ置く＝逆順を選べている。赤先なら 5 枚揃わず別の手になる。
      expect(action.cardId, '同一スロット逆順（緑→赤）を考慮できていない').toBe('pend-green');
      expect(action.slotIndex).toBe(4);
    }
  });
});
