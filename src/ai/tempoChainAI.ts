/**
 * tempoChainAI ― 戦略スペクトルを genome に統合したパラメータ化 AI。
 * 最適化（ai/scripts/optimize-tempochain.ts）の対象。
 *
 * 特殊点で既存戦略を再現:
 *   - fireTarget=5, lateThreshold=∞, fullThreshold=∞, buildTempoBlend=0 ＝ 純 fiveChain（溜めて5連鎖）
 *   - fireTarget=1, buildTempoBlend=1 ≈ tempoFast 的（手堅く稼ぐ・小連鎖も撃つ）
 *   - 中間 ＝ ハイブリッド（適応 fireTarget ＋ build/tempo 混合）
 *
 * 各ターン: 点火可能(bestChainMove >= 実効fireTarget)なら点火、無理なら build/tempo 混合で配置。
 * 連鎖の評価は cascade.ts の実カスケード（段違い対応）に委ねる。
 */
import type { Action, Color, GameState, PlayerBoard } from '../game/types';
import { COLORS } from '../game/types';
import { stepGame } from '../game/reducer';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { evaluateState } from './evaluator';
import { bestChainMove } from './cascade';

export type DistanceMode = 'expected' | 'worstcase';

export interface TempoChainGenome {
  /** 撃つ最小連鎖（基本）。 */
  fireTarget: number;
  /** late 相（誰かのスコアが lateThreshold 以上）での撃つ最小連鎖。 */
  fireTargetLate: number;
  /** いずれかのスコアがこの値以上で late 相（∞=無効）。 */
  lateThreshold: number;
  /** 自盤面のカードがこの値以上なら最善連鎖で発火（詰み防止, ∞=無効）。 */
  fullThreshold: number;
  /** 構築時の配置スコア: blend*tempo評価 − (1-blend)*W*距離（0=純構築, 1=純tempo）。 */
  buildTempoBlend: number;
  /** 距離の取り方（expected=総不足, worstcase=最悪色を重視）。 */
  distanceMode: DistanceMode;
  /** cascade 探索のノード上限。 */
  nodeLimit: number;
}

export const DEFAULT_GENOME: TempoChainGenome = {
  fireTarget: 5,
  fireTargetLate: 5,
  lateThreshold: Infinity,
  fullThreshold: Infinity,
  buildTempoBlend: 0,
  distanceMode: 'expected',
  nodeLimit: 60000,
};

const DIST_W = 50;

function distinctSlots(board: PlayerBoard, color: Color): number {
  let n = 0;
  for (const slot of board.slots) if (slot.stack.some((c) => c.color === color)) n++;
  return n;
}

/** 5連鎖ゴールまでの距離（小さいほど近い）。distanceMode で総不足／最悪色重視を切替。 */
function distanceToGoal(board: PlayerBoard, mode: DistanceMode): number {
  let total = 0;
  let worst = 0;
  for (const color of COLORS) {
    const deficit = Math.max(0, 3 - Math.min(3, distinctSlots(board, color)));
    total += deficit;
    if (deficit > worst) worst = deficit;
  }
  return mode === 'worstcase' ? worst * 4 + total * 0.1 : total;
}

function boardCards(board: PlayerBoard): number {
  let n = 0;
  for (const slot of board.slots) n += slot.stack.length;
  return n;
}

function firstLegal(state: GameState, me: number): Action | null {
  for (const id of legalActionIds(state, me)) {
    const a = actionIdToAction(state, me, id);
    if (a) return a;
  }
  return null;
}

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
  if (bestPair >= 0 && bestUseful > 0) return { type: 'DRAW_FROM_FIELD', pairIndex: bestPair as 0 | 1 };
  return { type: 'DRAW_FROM_DECK' };
}

/** 実効 fireTarget（late で下げ、盤面詰まりで最善発火）。 */
function effectiveFireTarget(state: GameState, me: number, g: TempoChainGenome): number {
  let ft = g.fireTarget;
  if (g.lateThreshold !== Infinity) {
    let maxScore = 0;
    for (const p of state.players) if (p.score > maxScore) maxScore = p.score;
    if (maxScore >= g.lateThreshold) ft = Math.min(ft, g.fireTargetLate);
  }
  if (g.fullThreshold !== Infinity && boardCards(state.players[me].board) >= g.fullThreshold) ft = 1;
  return ft;
}

/** 構築フェーズの配置: 発火させず、blend で「距離最小化」と「tempo評価」を混合した最善手。 */
function buildPlacement(state: GameState, me: number, g: TempoChainGenome): Action | null {
  const pending = state.turn.pendingDraw;
  const nSlots = state.players[me].board.slots.length;
  let best: Action | null = null;
  let bestScore = -Infinity;
  let fallback: { action: Action; chain: number } | null = null;

  for (const card of pending) {
    for (let s = 0; s < nSlots; s++) {
      const action: Action = { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: s };
      const next = stepGame(state, action);
      if (next === state) continue;
      if (next.turn.combosThisTurn.length >= 1) {
        const fired = next.turn.combosThisTurn.length;
        if (!fallback || fired > fallback.chain) fallback = { action, chain: fired };
        continue;
      }
      const board = next.players[me].board;
      const tempo = g.buildTempoBlend > 0 ? evaluateState(next, me) : 0;
      const dist = distanceToGoal(board, g.distanceMode);
      const score = g.buildTempoBlend * tempo - (1 - g.buildTempoBlend) * DIST_W * dist;
      if (score > bestScore) {
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
  genome: Partial<TempoChainGenome> = {}
): Action | null {
  const g: TempoChainGenome = { ...DEFAULT_GENOME, ...genome };
  const seedForSmart = seed ?? 0;

  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    return decideSmart(state, playerId, seedForSmart);
  }
  const isGiftPlace =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlace && state.currentPlayerIndex !== playerId) return null;
  if (isGiftPlace) return decideSmart(state, playerId, seedForSmart);

  if (state.phase === 'awaitingDraw') return chooseDraw(state, playerId);

  if (
    state.phase === 'awaitingAdditionalActionChoice' ||
    state.phase === 'awaitingAdditionalDiscard' ||
    state.phase === 'awaitingPlaceAdditionalDraw'
  ) {
    const bm = bestChainMove(state, playerId, { nodeLimit: g.nodeLimit });
    return bm.action ?? firstLegal(state, playerId);
  }

  if (state.phase === 'awaitingPlaceDrawn') {
    const ft = effectiveFireTarget(state, playerId, g);
    const bm = bestChainMove(state, playerId, { nodeLimit: g.nodeLimit });
    if (bm.chain >= ft && bm.action) return bm.action;
    return buildPlacement(state, playerId, g);
  }

  return firstLegal(state, playerId);
}
