import { useEffect, useReducer, useState } from 'react';
import { reducer } from '../game/reducer';
import { setupGame } from '../game/setup';
import type { Action, GameState, SetupOptions } from '../game/types';
import { decideAction } from '../ai';
import { useTimeout } from './useTimeout';

export type CpuSpeed = 'fast' | 'normal' | 'slow' | 'verySlow';

interface DelayProfile {
  base: number;
  think: number;
}

const SPEED_PROFILES: Record<CpuSpeed, DelayProfile> = {
  fast: { base: 200, think: 320 },
  normal: { base: 550, think: 800 },
  slow: { base: 1100, think: 1500 },
  verySlow: { base: 2000, think: 2800 },
};

// 配置/取り除きの直後に魔法発動を即時実行すると演出が見えないため、
// `resolvingCombos` フェーズに入ったら少し待ってから連鎖判定を起動する。
const COMBO_RESOLVE_DELAY: Record<CpuSpeed, number> = {
  fast: 250,
  normal: 500,
  slow: 850,
  verySlow: 1300,
};

function delayFor(state: GameState, speed: CpuSpeed): number {
  const profile = SPEED_PROFILES[speed];
  if (state.phase === 'awaitingAdditionalActionChoice' || state.phase === 'awaitingGiftSelection') {
    return profile.think;
  }
  return profile.base;
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
  const [cpuSpeed, setCpuSpeed] = useState<CpuSpeed>('normal');
  const timer = useTimeout();

  useEffect(() => {
    if (state.phase === 'gameOver') {
      timer.clear();
      return;
    }

    // 配置/取り除きで `resolvingCombos` に入った場合、UI 側の演出が見えるよう
    // 少し待ってから自動で連鎖判定を起動する。AI/操作主体に関わらず常に走らせる。
    if (state.phase === 'resolvingCombos') {
      timer.set(() => dispatch({ type: 'RESOLVE_COMBOS' }), COMBO_RESOLVE_DELAY[cpuSpeed]);
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
    timer.set(() => dispatch(action), delayFor(state, cpuSpeed));
    return timer.clear;
  }, [state, autoPilot, cpuSpeed, timer]);

  const startNewGame = (opts?: SetupOptions) => {
    dispatch({ type: 'NEW_GAME', options: opts });
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
  };
}
