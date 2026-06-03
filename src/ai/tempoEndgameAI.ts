/**
 * tempoEndgameAI ― 仮説 A「終盤だけ先読みを深める」の実験用ラッパー。
 *
 * 動機: Gen-4-C(lookahead=1) のエッジは「点を稼ぐ」のでなく「レースに勝つ」着手にある
 * （平均点は低いのに勝率が高い＝終盤のレース計時が本質）。一律 lookahead=2 は予算を食って
 * 失敗(20%)したが、その2大失敗要因は **終盤では消える**:
 *   (1) コスト: 終盤は終端に近く局面が浅い＝深掘りが安い。
 *   (2) 相手モデル誤差: 終盤は相手の手も限定的＝smart モデルの誤差が小さい。
 * よって「終盤（誰かが閾値近く）でのみ lookahead を上げる」のは未踏かつ理に適う。
 *
 * 実装は薄いラッパー: 現状最強 tempoFastAI.decideAction にそのまま委譲し、root 局面の
 * 最大スコアが endgameScoreThreshold 以上なら lookaheadTurns を endgameLookahead に差し替える
 * だけ（tempoFastAI/evaluator は一切編集しない）。
 */
import type { Action, GameState } from '../game/types';
import { decideAction as decideTempoFast, type TempoFastOptions } from './tempoFastAI';

export interface TempoEndgameOptions extends TempoFastOptions {
  /** 最大スコアがこの値以上なら「終盤」とみなし endgameLookahead を使う。 */
  endgameScoreThreshold?: number;
  /** 終盤で使う先読みターン数（通常の lookaheadTurns を上書き）。 */
  endgameLookahead?: number;
}

/** 終盤判定の既定閾値（END_SCORE_THRESHOLD=20 に対し残り 5 点）。 */
const DEFAULT_ENDGAME_THRESHOLD = 15;
/** 終盤の既定先読み（通常 LA=1 → 終盤 LA=2）。 */
const DEFAULT_ENDGAME_LOOKAHEAD = 2;

function maxScore(state: GameState): number {
  let m = 0;
  for (const p of state.players) if (p.score > m) m = p.score;
  return m;
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoEndgameOptions = {}
): Action | null {
  const threshold = options.endgameScoreThreshold ?? DEFAULT_ENDGAME_THRESHOLD;
  const endgameLA = options.endgameLookahead ?? DEFAULT_ENDGAME_LOOKAHEAD;
  const baseLA = options.lookaheadTurns ?? 1;
  const lookaheadTurns = maxScore(state) >= threshold ? endgameLA : baseLA;
  // endgame* オプションは tempoFast には不要なので渡さない（型は通るが意図を明示）。
  const { endgameScoreThreshold: _t, endgameLookahead: _l, ...rest } = options;
  return decideTempoFast(state, playerId, seed, { ...rest, lookaheadTurns });
}
