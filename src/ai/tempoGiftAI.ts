/**
 * tempoGiftAI ― 仮説(Gen-9)「ギフトの能動的妨害」。
 *
 * 現状: ギフト選択(awaitingGiftSelection)を smartAI の色カウント proxy（リーダーが最も持たない色を渡す）に委譲。
 * 本変種: 各コンボの (渡すカード, 相手) を全探索し、**実際に贈与配置までシミュレートした後の評価関数
 * （相手脅威・overflow 込み）が自分にとって最良＝相手の利得が最小**になる配り方を選ぶ。
 * それ以外の局面は現状最強 tempoFast にそのまま委譲（tempoFast は非編集）。
 *
 * 過去「ギフト最適化=null」は readiness 最小化 proxy で測ったもの。 葉で「贈与後の相手盤面」 を評価する角度は未検証。
 */
import type { Action, GameState, GiftAssignment, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { evaluateState, type EvalWeights } from './evaluator';
import { decideAction as decideSmart } from './smartAI';
import { decideAction as decideTempoFast, type TempoFastOptions } from './tempoFastAI';

/** 贈与配置（recipient が PLACE_GIFT を smart で置く）を最後まで進めた状態を返す。 */
function simulateGiftPlacement(state: GameState, maxSteps = 24): GameState {
  let s = state;
  for (let i = 0; i < maxSteps && s.phase === 'awaitingGiftPlacement'; i++) {
    const r = s.turn.pendingGiftBatches[0]?.recipientId;
    if (r == null) break;
    const a = decideSmart(s, r);
    if (!a) break;
    const before = s;
    s = stepGame(s, a);
    if (s === before) break;
  }
  return s;
}

function defaultAssign(combo: GameState['turn']['giftQueue'][number], comboIndex: number, opponents: Player[]): GiftAssignment {
  // 暫定: 先頭カードを最高得点の相手へ（greedy 中の未確定コンボ用）。
  const leader = opponents.reduce((m, c) => (c.score > m.score ? c : m), opponents[0]);
  return { comboIndex, cardId: combo.cards[0].id, targetPlayerId: leader.id };
}

/** 各コンボの (カード, 相手) を greedy に全探索し、贈与後の evaluateState(me) を最大化する割当を返す。 */
function chooseGiftAssignments(state: GameState, me: number, weights: EvalWeights | undefined): GiftAssignment[] {
  const queue = state.turn.giftQueue;
  const opponents = state.players.filter((p) => p.id !== me);
  if (queue.length === 0 || opponents.length === 0) return [];
  const chosen: GiftAssignment[] = [];
  for (let ci = 0; ci < queue.length; ci++) {
    const combo = queue[ci];
    let best: GiftAssignment | null = null;
    let bestScore = -Infinity;
    // 同一カードは色が同じなら等価なので色で重複排除（探索削減）
    const seenColors = new Set<string>();
    for (const card of combo.cards) {
      if (seenColors.has(card.color)) continue;
      seenColors.add(card.color);
      for (const opp of opponents) {
        const trial: GiftAssignment[] = [...chosen, { comboIndex: ci, cardId: card.id, targetPlayerId: opp.id }];
        for (let cj = ci + 1; cj < queue.length; cj++) trial.push(defaultAssign(queue[cj], cj, opponents));
        let score: number;
        try {
          const afterConfirm = stepGame(state, { type: 'CONFIRM_GIFTS', assignments: trial });
          const afterPlace = simulateGiftPlacement(afterConfirm);
          score = evaluateState(afterPlace, me, weights);
        } catch {
          continue;
        }
        if (score > bestScore) {
          bestScore = score;
          best = { comboIndex: ci, cardId: card.id, targetPlayerId: opp.id };
        }
      }
    }
    chosen.push(best ?? defaultAssign(combo, ci, opponents));
  }
  return chosen;
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoFastOptions = {}
): Action | null {
  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    const assignments = chooseGiftAssignments(state, playerId, options.weights);
    return { type: 'CONFIRM_GIFTS', assignments };
  }
  return decideTempoFast(state, playerId, seed, options);
}
