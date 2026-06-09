/**
 * fiveChainAI ― 人間戦略「size3 の1ターン5連鎖を最速で組み、それ以外では発火させない」を
 * 直接ルール化した目的志向の方策 AI（葉 shaping ではない）。
 *
 *  - 点火: 引いた2枚で maxChainFrom >= fireTarget(=5) なら、その最大連鎖を実行する。
 *  - 構築: 届かないターンは「5連鎖ゴールまでの距離」を最小化する配置を選ぶ（小連鎖では発火しない）。
 *    距離 = 5色それぞれが「3つの異なるスロット」に乗っているか（段違い前提の必要条件）。
 *  - 連鎖中の強制アクション: 最大連鎖を伸ばす手を選ぶ。
 *  - ギフトは smartAI に委譲。
 *
 * 段違い(staggered)構造の評価は cascade.ts（実カスケード）に委ねるので、一様な列を作る必要はない。
 */
import type { Action, Color, GameState, PlayerBoard } from '../game/types';
import { COLORS } from '../game/types';
import { stepGame } from '../game/reducer';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { maxChainFrom, bestChainMove } from './cascade';

export interface FiveChainOptions {
  /** 点火する最小連鎖数。既定5（5連鎖のみ発火）。 */
  fireTarget?: number;
  /** maxChainFrom / bestChainMove の探索ノード上限。 */
  nodeLimit?: number;
}

const DEFAULT_FIRE_TARGET = 5;
const DEFAULT_NODE_LIMIT = 60000;

/** color を含む（=最上段に出しうる）スロット数。 */
function distinctSlots(board: PlayerBoard, color: Color): number {
  let n = 0;
  for (const slot of board.slots) {
    if (slot.stack.some((c) => c.color === color)) n++;
  }
  return n;
}

/** 5連鎖ゴールまでの距離（小さいほど近い）。各色が3つの異なるスロットに乗るのが目標。 */
function distanceToGoal(board: PlayerBoard): number {
  let dist = 0;
  for (const color of COLORS) {
    const n = distinctSlots(board, color);
    dist += Math.max(0, 3 - Math.min(3, n));
  }
  return dist;
}

function maxStackHeight(board: PlayerBoard): number {
  let m = 0;
  for (const slot of board.slots) if (slot.stack.length > m) m = slot.stack.length;
  return m;
}

function firstLegal(state: GameState, me: number): Action | null {
  for (const id of legalActionIds(state, me)) {
    const a = actionIdToAction(state, me, id);
    if (a) return a;
  }
  return null;
}

/** ドロー選択: 必要な色（distinctSlots<3）を多く含む場 pair を優先、無ければ山札。 */
function chooseDraw(state: GameState, me: number): Action {
  const board = state.players[me].board;
  let bestPair = -1;
  let bestUseful = 0;
  state.field.forEach((pair, i) => {
    if (!pair) return;
    let useful = 0;
    for (const c of pair) if (distinctSlots(board, c.color) < 3) useful++;
    if (useful > bestUseful) {
      bestUseful = useful;
      bestPair = i;
    }
  });
  if (bestPair >= 0 && bestUseful > 0) {
    return { type: 'DRAW_FROM_FIELD', pairIndex: bestPair as 0 | 1 };
  }
  return { type: 'DRAW_FROM_DECK' };
}

/** 構築フェーズの配置: 発火させずに距離を最小化する1手。やむを得ない時のみ最大連鎖へ。 */
function buildPlacement(state: GameState, me: number): Action | null {
  const pending = state.turn.pendingDraw;
  const nSlots = state.players[me].board.slots.length;
  let best: Action | null = null;
  let bestScore = Infinity;
  let fallback: { action: Action; chain: number } | null = null;

  for (const card of pending) {
    for (let s = 0; s < nSlots; s++) {
      const action: Action = { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: s };
      const next = stepGame(state, action);
      if (next === state) continue;
      const fired = next.turn.combosThisTurn.length;
      if (fired >= 1) {
        // 構築中の発火＝小連鎖。原則避ける。全配置が発火する場合のみ最大連鎖を採る。
        if (!fallback || fired > fallback.chain) fallback = { action, chain: fired };
        continue;
      }
      const board = next.players[me].board;
      const score = distanceToGoal(board) * 100 + maxStackHeight(board);
      if (score < bestScore) {
        bestScore = score;
        best = action;
      }
    }
  }
  return best ?? fallback?.action ?? firstLegal(state, me);
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: FiveChainOptions = {}
): Action | null {
  const fireTarget = options.fireTarget ?? DEFAULT_FIRE_TARGET;
  const nodeLimit = options.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const seedForSmart = seed ?? 0;

  // ギフト
  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    return decideSmart(state, playerId, seedForSmart);
  }
  const isGiftPlace =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlace && state.currentPlayerIndex !== playerId) return null;
  if (isGiftPlace) return decideSmart(state, playerId, seedForSmart);

  // ドロー
  if (state.phase === 'awaitingDraw') {
    return chooseDraw(state, playerId);
  }

  // 連鎖中の強制アクション: 最大連鎖を伸ばす
  if (
    state.phase === 'awaitingAdditionalActionChoice' ||
    state.phase === 'awaitingAdditionalDiscard' ||
    state.phase === 'awaitingPlaceAdditionalDraw'
  ) {
    const bm = bestChainMove(state, playerId, { nodeLimit });
    return bm.action ?? firstLegal(state, playerId);
  }

  // 配置: 点火可能なら点火、無理なら構築
  if (state.phase === 'awaitingPlaceDrawn') {
    const bm = bestChainMove(state, playerId, { nodeLimit });
    if (bm.chain >= fireTarget && bm.action) return bm.action;
    return buildPlacement(state, playerId);
  }

  return firstLegal(state, playerId);
}

// maxChainFrom を re-export（テスト/ベンチ用）。
export { maxChainFrom };
