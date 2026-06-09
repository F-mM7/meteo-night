import type { Action, GameState } from './types';
import { stepGame } from './reducer';

/**
 * 人間プレイ棋譜の記録形式。
 *
 * このゲームは「初期状態」と「適用された意思決定アクションの列」だけで対局を完全再現できる
 * （盤面シャッフル・ドローはすべて初期状態の `rngSeed` から決定論的に決まる。`engine.ts` の
 *  山札再シャッフルも `rngSeed + turnNumber + deck.length` から導出され追加の乱数状態を持たない）。
 * そのため盤面スナップショットは保存せず、初期状態＋手順のみを残す軽量形式とする。
 *
 * 再生は Node 側の既存対局ループと同じ `stepGame` で行うため、連鎖解決の内部遷移
 * （`RESOLVE_COMBOS`）やリセット用の `CLEAR_BOARDS_FOR_RESET` / `NEW_GAME` は記録しない。
 * `stepGame` が `resolvingCombos` を自動で解決するので、意思決定アクションだけで足りる。
 */
export const CURRENT_RECORD_VERSION = 1 as const;

export interface RecordedResult {
  winnerId: number | null;
  scores: number[];
  turns: number;
  /** gameOver まで到達したか（途中放棄・打ち切りなら false） */
  finished: boolean;
}

export interface GameRecord {
  version: typeof CURRENT_RECORD_VERSION;
  /** 対局開始時の状態（`log` は再現に不要なため空にして保存する）。`rngSeed` を内包する。 */
  initialState: GameState;
  /** 適用順の意思決定アクション列（内部遷移・リセットは含まない）。 */
  actions: Action[];
  /** 終局時の集計（フィルタ・分析の入口用。`initialState`+`actions` から再現可能）。 */
  result: RecordedResult;
  /** 人間が操作した席（`isCPU === false` の playerId）。AI 同士の観戦対局を除外する判定に使う。 */
  humanSeats: number[];
  /** 記録確定時刻（ISO 8601）。分析時のメタ情報。 */
  recordedAt: string;
}

/** 記録対象（意思決定アクション）か。リセット・内部遷移は除外する。 */
export function isDecisionAction(action: Action): boolean {
  switch (action.type) {
    case 'NEW_GAME':
    case 'CLEAR_BOARDS_FOR_RESET':
    case 'RESOLVE_COMBOS':
      return false;
    default:
      return true;
  }
}

/** 再現に不要な UI 用テキストログを落とした状態を返す（保存サイズ削減のため）。 */
export function stripStateForRecording(state: GameState): GameState {
  return { ...state, log: [] };
}

/** 終局状態から集計結果を取り出す。 */
export function extractResult(state: GameState): RecordedResult {
  return {
    winnerId: state.winnerId,
    scores: state.players.map((p) => p.score),
    turns: state.turnNumber,
    finished: state.phase === 'gameOver',
  };
}

/** 人間が操作した席（playerId）の一覧。 */
export function humanSeatsOf(state: GameState): number[] {
  return state.players.filter((p) => !p.isCPU).map((p) => p.id);
}

/**
 * 記録を初期状態から再生し、終局状態と no-op アクション数を返す。
 * 各アクションは `stepGame`（連鎖の自動解決込み）で適用する。
 * no-op（状態が変化しなかった手）は記録の不整合を示すため件数を返す。
 */
export function replayRecord(record: GameRecord): { state: GameState; noopCount: number } {
  let state = record.initialState;
  let noopCount = 0;
  for (const action of record.actions) {
    const before = state;
    state = stepGame(state, action);
    // reducer は phase 不一致などの no-op 時に同一参照を返すため、参照比較で検出できる。
    if (state === before) noopCount++;
  }
  return { state, noopCount };
}
