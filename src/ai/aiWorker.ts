/// <reference lib="webworker" />
/**
 * CPU AI を Web Worker（メインスレッド外）で実行するためのワーカー。
 *
 * 採用 AI（tempoChainAI, Gen-15）は連鎖局面で重くなりうるため、メインスレッドで
 * 同期実行すると UI が固まる。本ワーカーで decideAction を実行し、結果だけを postMessage で
 * 返すことで、思考中も UI が応答し続ける。
 *
 * - 受信: { reqId, state, actorId }（GameState は純データなので structuredClone 可能）
 * - 返信: { reqId, action }（action は null の場合あり＝合法手なし）
 * reqId は呼び出し側の世代カウンタ。古い応答（state が進んだ後に届くもの）を破棄するために使う。
 *
 * 例外は握りつぶさない（ユーザー方針 2026-06-11: 例外を隠すフォールバック禁止）: decideAction が
 * 投げたらワーカーの未捕捉エラー＝Worker の error イベントとして呼び出し側に表面化し、呼び出し側は
 * 同期 decideAction で同一計算を再実行する（そこで同じ例外が console に出る＝問題を隠さない）。
 */
import type { Action, GameState } from '../game/types';
import { decideAction } from './index';

export interface AiWorkerRequest {
  reqId: number;
  state: GameState;
  actorId: number;
  /** CPU の目標確率 P の上書き（UI の CPU 強さ切替。省略＝配信既定 P*）。 */
  p?: number;
}
export interface AiWorkerResponse {
  reqId: number;
  action: Action | null;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<AiWorkerRequest>) => {
  const { reqId, state, actorId, p } = e.data;
  const res: AiWorkerResponse = { reqId, action: decideAction(state, actorId, undefined, p) };
  ctx.postMessage(res);
};
