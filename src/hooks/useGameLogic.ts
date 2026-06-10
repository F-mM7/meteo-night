import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { reducer } from '../game/reducer';
import { setupGame } from '../game/setup';
import type { Action, GameState, SetupOptions } from '../game/types';
import { decideAction } from '../ai';
import { useTimeout } from './useTimeout';
import { useGameRecorder } from './useGameRecorder';
import { CARD_FADE_DURATION_MS } from './boardLayout';
import type { AiWorkerRequest, AiWorkerResponse } from '../ai/aiWorker';

// 各手番に挟む演出の遅延（ミリ秒）。CPU の思考速度ではなく表示テンポの調整で、
// UI からユーザーが直接指定する。
export type EffectDelay = number;

export const DEFAULT_EFFECT_DELAY_MS = 500;

function normalizeDelay(delay: EffectDelay): number {
  if (!Number.isFinite(delay) || delay < 0) return 0;
  return delay;
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
  const recorder = useGameRecorder();
  // 全 dispatch を記録フックに通してから本来の dispatch を行うラッパー。
  // 人間操作・AI 着手・連鎖解決・リセットのすべてをここに集約して記録漏れを防ぐ。
  const recordingDispatch = useCallback(
    (action: Action) => {
      recorder.onAction(action);
      dispatch(action);
    },
    [recorder.onAction]
  );
  const [autoPilot, setAutoPilot] = useState(false);
  const [effectDelay, setEffectDelay] = useState<EffectDelay>(DEFAULT_EFFECT_DELAY_MS);
  const [logVisible, setLogVisible] = useState(false);
  const timer = useTimeout();
  const resetTimer = useTimeout();

  // CPU AI（tempoChainAI, Gen-15。連鎖局面で重くなりうる）をメインスレッド外で実行するワーカー。
  // 思考中も UI を応答させるのが目的。生成不可/失敗時は同期 decideAction にフォールバックする。
  const workerRef = useRef<Worker | null>(null);
  const workerFailedRef = useRef(false);
  const genRef = useRef(0);
  const ensureWorker = useCallback((): Worker | null => {
    if (workerRef.current) return workerRef.current;
    if (workerFailedRef.current || typeof Worker === 'undefined') return null;
    try {
      workerRef.current = new Worker(new URL('../ai/aiWorker.ts', import.meta.url), {
        type: 'module',
      });
      return workerRef.current;
    } catch {
      workerFailedRef.current = true;
      return null;
    }
  }, []);
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state.phase === 'gameOver') {
      timer.clear();
      return;
    }

    // 配置/取り除きで `resolvingCombos` に入った場合、UI 側の演出が見えるよう
    // 少し待ってから自動で連鎖判定を起動する。AI/操作主体に関わらず常に走らせる。
    if (state.phase === 'resolvingCombos') {
      timer.set(() => recordingDispatch({ type: 'RESOLVE_COMBOS' }), normalizeDelay(effectDelay));
      return timer.clear;
    }

    if (!isAIDriven(state, autoPilot)) {
      timer.clear();
      return;
    }

    const actorId = currentActorId(state);
    const myGen = ++genRef.current;
    const startedAt = Date.now();
    // 思考完了後、effectDelay の「余り時間」だけ待って着手を反映する（思考が effectDelay より
    // 長ければ即時）。思考時間と演出ディレイを二重に足さないため。
    const schedule = (action: Action | null) => {
      if (genRef.current !== myGen) return; // 古い世代（state が進んだ）→破棄
      if (!action) {
        timer.clear();
        return;
      }
      const remaining = Math.max(0, normalizeDelay(effectDelay) - (Date.now() - startedAt));
      timer.set(() => recordingDispatch(action), remaining);
    };

    const worker = ensureWorker();
    if (worker) {
      const onMessage = (e: MessageEvent<AiWorkerResponse>) => {
        if (e.data?.reqId !== myGen) return; // このリクエストの応答のみ採用
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        schedule(e.data.action);
      };
      const onError = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        workerFailedRef.current = true; // 以後は同期にフォールバック
        if (genRef.current === myGen) schedule(decideAction(state, actorId));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      const req: AiWorkerRequest = { reqId: myGen, state, actorId };
      worker.postMessage(req);
      return () => {
        genRef.current++; // 進行中リクエストを無効化
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        timer.clear();
      };
    }

    // フォールバック: ワーカー不可なら同期実行（メインスレッドをブロックしうる）。
    schedule(decideAction(state, actorId));
    return timer.clear;
  }, [state, autoPilot, effectDelay, timer, ensureWorker, recordingDispatch]);

  // 各 dispatch 適用後の状態を記録フックへ通知する（対局開始の検出・終局時の保存）。
  useEffect(() => {
    recorder.onState(state);
  }, [state, recorder.onState]);

  const startNewGame = (opts?: SetupOptions) => {
    // 2 段階で発火：(1) 全スロットを空にして外側フェードアウト、
    // (2) フェード完了後に実際の初期化を行い、新規カードが外側からフェードイン。
    recordingDispatch({ type: 'CLEAR_BOARDS_FOR_RESET' });
    resetTimer.set(() => {
      recordingDispatch({ type: 'NEW_GAME', options: opts });
    }, CARD_FADE_DURATION_MS);
  };

  const userDispatch = (action: Action) => {
    if (action.type !== 'NEW_GAME' && isAIDriven(state, autoPilot)) return;
    recordingDispatch(action);
  };

  return {
    state,
    dispatch: userDispatch,
    startNewGame,
    autoPilot,
    setAutoPilot,
    effectDelay,
    setEffectDelay,
    logVisible,
    setLogVisible,
    recording: recorder,
  };
}
