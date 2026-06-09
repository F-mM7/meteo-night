import { useCallback, useRef, useState } from 'react';
import type { Action, GameState } from '../game/types';
import {
  CURRENT_RECORD_VERSION,
  extractResult,
  humanSeatsOf,
  isDecisionAction,
  stripStateForRecording,
  type GameRecord,
} from '../game/recording';

const STORAGE_KEY = 'meteo-night:human-games:v1';

function loadGames(): GameRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[recorder] 保存データが配列でないため無視します');
      return [];
    }
    return parsed as GameRecord[];
  } catch (e) {
    console.warn('[recorder] 保存データの読み込みに失敗しました', e);
    return [];
  }
}

function saveGames(games: GameRecord[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
    return true;
  } catch (e) {
    // 容量超過（QuotaExceededError）やプライベートモードでの失敗。黙殺せず警告する。
    console.warn('[recorder] 保存に失敗しました（容量超過の可能性）', e);
    return false;
  }
}

/**
 * 人間プレイ対局をブラウザに記録するフック。
 *
 * `useGameLogic` の全 dispatch を `onAction` でフックし、state 変化を `onState` で監視する。
 * - 対局開始（初回マウント / NEW_GAME 後の初期状態）を検出して記録を開始
 * - 意思決定アクションを順に蓄積（連鎖解決などの内部遷移・リセットは `isDecisionAction` で除外）
 * - gameOver 到達時に、人間席を含む対局だけを localStorage へ確定保存
 *
 * StrictMode の effect 二重実行に耐えるよう、開始・保存は ref ガードで冪等にしている。
 */
export function useGameRecorder() {
  const [enabled, setEnabled] = useState(true);
  const [gameCount, setGameCount] = useState<number>(() => loadGames().length);

  // 進行中の対局（初期状態が確定するまでは null）。
  const recordRef = useRef<{ initialState: GameState; actions: Action[] } | null>(null);
  // 現対局を保存済みか（gameOver で複数回 onState が走っても二重保存しない）。
  const savedRef = useRef(false);
  // useCallback を安定させたまま最新の enabled を参照するための鏡。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const onAction = useCallback((action: Action) => {
    if (!enabledRef.current) return;
    // リセット系は進行中記録を破棄（途中放棄の対局は保存しない）。次の初期状態で再開する。
    if (action.type === 'NEW_GAME' || action.type === 'CLEAR_BOARDS_FOR_RESET') {
      recordRef.current = null;
      savedRef.current = false;
      return;
    }
    if (!isDecisionAction(action)) return;
    recordRef.current?.actions.push(action);
  }, []);

  const onState = useCallback((state: GameState) => {
    if (!enabledRef.current) return;

    // 対局開始の初期状態（ターン1・ドロー前）を初めて見たら記録を開始する。
    const isOpening =
      state.turnNumber === 1 && state.phase === 'awaitingDraw' && !state.turn.hasDrawn;
    if (isOpening && !recordRef.current) {
      recordRef.current = { initialState: stripStateForRecording(state), actions: [] };
      savedRef.current = false;
    }

    // 終局したら、人間席を含む対局のみ確定保存する。
    if (state.phase === 'gameOver' && recordRef.current && !savedRef.current) {
      savedRef.current = true;
      const humanSeats = humanSeatsOf(state);
      const rec = recordRef.current;
      recordRef.current = null;
      if (humanSeats.length === 0 || rec.actions.length === 0) return;

      const record: GameRecord = {
        version: CURRENT_RECORD_VERSION,
        initialState: rec.initialState,
        actions: rec.actions,
        result: extractResult(state),
        humanSeats,
        recordedAt: new Date().toISOString(),
      };
      const games = loadGames();
      games.push(record);
      if (saveGames(games)) setGameCount(games.length);
    }
  }, []);

  const exportGames = useCallback(() => {
    const games = loadGames();
    if (games.length === 0) return;
    const blob = new Blob([JSON.stringify(games)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    // ファイル名のタイムスタンプは月日時分（ローカル時刻）。複数回の書き出しを区別する。
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `meteo-night-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const clearGames = useCallback(() => {
    if (saveGames([])) setGameCount(0);
  }, []);

  return { enabled, setEnabled, gameCount, onAction, onState, exportGames, clearGames };
}

export type GameRecorder = ReturnType<typeof useGameRecorder>;
