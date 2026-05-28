import { useEffect, useReducer, useState } from 'react';
import { reducer } from '../game/reducer';
import { setupGame } from '../game/setup';
import type { Action, GameState, SetupOptions } from '../game/types';
import { decideAction } from '../ai';
import { useTimeout } from './useTimeout';
import { CARD_FADE_DURATION_MS } from './boardLayout';

// CPU の思考演出に挟む遅延（ミリ秒）。UI からユーザーが直接指定する。
export type CpuSpeed = number;

export const DEFAULT_CPU_SPEED_MS = 550;

function normalizeDelay(speed: CpuSpeed): number {
  if (!Number.isFinite(speed) || speed < 0) return 0;
  return speed;
}

export function currentActorId(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

/**
 * 現在の操作主体（actor）が AI 駆動かどうかを判定する。
 * - actor が CPU の場合は常に AI 駆動。
 * - 観戦モード（autoPilot=true）の場合、人間席の手番も AI 駆動として扱う。
 * - actor が見つからない場合は false。
 */
export function isAIDriven(state: GameState, autoPilot: boolean): boolean {
  const actor = state.players[currentActorId(state)];
  if (!actor) return false;
  return actor.isCPU || autoPilot;
}

/**
 * 人間プレイヤー（id=`you`）が現在 UI から操作できる状態にあるかを判定する。
 * - `kind: 'turn'`: 自分の手番か（場からのドロー等、手番開始時の判定に使う）
 * - `kind: 'actor'`: 自分が現在の操作主体か（贈与配置の受領者になる場合も含む）
 *
 * いずれも gameOver 中・観戦モード中は常に false。
 */
export function isHumanInteractive(
  state: GameState,
  you: number,
  autoPilot: boolean,
  kind: 'turn' | 'actor'
): boolean {
  if (state.phase === 'gameOver' || autoPilot) return false;
  const targetId = kind === 'turn' ? state.currentPlayerIndex : currentActorId(state);
  return targetId === you;
}

export function useGameLogic(initOptions?: SetupOptions) {
  const [state, dispatch] = useReducer(
    reducer,
    initOptions,
    (opts) => setupGame(opts)
  );
  const [autoPilot, setAutoPilot] = useState(false);
  const [cpuSpeed, setCpuSpeed] = useState<CpuSpeed>(DEFAULT_CPU_SPEED_MS);
  const [logVisible, setLogVisible] = useState(false);
  const timer = useTimeout();
  const resetTimer = useTimeout();

  useEffect(() => {
    if (state.phase === 'gameOver') {
      timer.clear();
      return;
    }

    // 配置/取り除きで `resolvingCombos` に入った場合、UI 側の演出が見えるよう
    // 少し待ってから自動で連鎖判定を起動する。AI/操作主体に関わらず常に走らせる。
    if (state.phase === 'resolvingCombos') {
      timer.set(() => dispatch({ type: 'RESOLVE_COMBOS' }), normalizeDelay(cpuSpeed));
      return timer.clear;
    }

    if (!isAIDriven(state, autoPilot)) {
      timer.clear();
      return;
    }
    const actorId = currentActorId(state);
    const action = decideAction(state, actorId);
    if (!action) {
      timer.clear();
      return;
    }
    timer.set(() => dispatch(action), normalizeDelay(cpuSpeed));
    return timer.clear;
  }, [state, autoPilot, cpuSpeed, timer]);

  const startNewGame = (opts?: SetupOptions) => {
    // 2 段階で発火：(1) 全スロットを空にして外側フェードアウト、
    // (2) フェード完了後に実際の初期化を行い、新規カードが外側からフェードイン。
    dispatch({ type: 'CLEAR_BOARDS_FOR_RESET' });
    resetTimer.set(() => {
      dispatch({ type: 'NEW_GAME', options: opts });
    }, CARD_FADE_DURATION_MS);
  };

  const userDispatch = (action: Action) => {
    if (action.type !== 'NEW_GAME' && isAIDriven(state, autoPilot)) return;
    dispatch(action);
  };

  return {
    state,
    dispatch: userDispatch,
    startNewGame,
    autoPilot,
    setAutoPilot,
    cpuSpeed,
    setCpuSpeed,
    logVisible,
    setLogVisible,
  };
}
