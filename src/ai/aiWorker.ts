/// <reference lib="webworker" />
/**
 * CPU AI を Web Worker（メインスレッド外）で実行するためのワーカー。
 *
 * 採用 AI（tempoChainAI, Gen-15）は連鎖局面で重くなりうるため、メインスレッドで
 * 同期実行すると UI が固まる。本ワーカーで decideAction を実行し、結果だけを postMessage で
 * 返すことで、思考中も UI が応答し続ける。
 *
 * - 受信: { reqId, state, actorId }（GameState は純データなので structuredClone 可能）
 * - 返信: { reqId, action }（action は null の場合あり＝合法手なし/例外）
 * reqId は呼び出し側の世代カウンタ。古い応答（state が進んだ後に届くもの）を破棄するために使う。
 */
import type { Action, GameState } from '../game/types';
import { decideAction } from './index';

export interface AiWorkerRequest {
  reqId: number;
  state: GameState;
  actorId: number;
}
export interface AiWorkerResponse {
  reqId: number;
  action: Action | null;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<AiWorkerRequest>) => {
  const { reqId, state, actorId } = e.data;
  let action: Action | null = null;
  try {
    action = decideAction(state, actorId);
  } catch {
    action = null; // ワーカー内例外は null として返し、呼び出し側でフォールバックさせる
  }
  const res: AiWorkerResponse = { reqId, action };
  ctx.postMessage(res);
};
