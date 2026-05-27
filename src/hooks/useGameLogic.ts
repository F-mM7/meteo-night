import { useEffect, useReducer, useRef, useState } from 'react';
import { reducer } from '../game/reducer';
import { setupGame } from '../game/setup';
import type { Action, GameState, SetupOptions } from '../game/types';
import { decideAction } from '../ai';

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

export function useGameLogic(initOptions?: SetupOptions) {
  const [state, dispatch] = useReducer(
    reducer,
    initOptions,
    (opts) => setupGame(opts)
  );
  const [autoPilot, setAutoPilot] = useState(false);
  const [cpuSpeed, setCpuSpeed] = useState<CpuSpeed>('normal');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (state.phase === 'gameOver') return;

    // 配置/取り除きで `resolvingCombos` に入った場合、UI 側の演出が見えるよう
    // 少し待ってから自動で連鎖判定を起動する。AI/操作主体に関わらず常に走らせる。
    if (state.phase === 'resolvingCombos') {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        dispatch({ type: 'RESOLVE_COMBOS' });
      }, COMBO_RESOLVE_DELAY[cpuSpeed]);
      return () => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }

    const actorId = currentActorId(state);
    const actor = state.players[actorId];
    if (!actor) return;
    const shouldAIDrive = actor.isCPU || autoPilot;
    if (!shouldAIDrive) return;
    const action = decideAction(state, actorId);
    if (!action) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dispatch(action);
    }, delayFor(state, cpuSpeed));
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state, autoPilot, cpuSpeed]);

  const startNewGame = (opts?: SetupOptions) => {
    dispatch({ type: 'NEW_GAME', options: opts });
  };

  const userDispatch = (action: Action) => {
    const actorId = currentActorId(state);
    const actor = state.players[actorId];
    if ((actor?.isCPU || autoPilot) && action.type !== 'NEW_GAME') return;
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
