import type { Color, GameState, Player } from '../game/types';
import { END_SCORE_THRESHOLD } from '../game/engine';
import { totalScoreForTurn } from '../game/scoring';

/**
 * 評価関数の重みパラメータ。CMA-ES / (1+1)-ES などで最適化対象とする。
 * 値域: 実数（正負可）。意味的にはコメント参照。
 */
export interface EvalWeights {
  /** 自分の現在累計スコアの係数 */
  selfScoreMult: number;
  /**
   * 自分が終了閾値-5に近づいたとき自己評価に加える追加加点（Gen-3-E で追加）。
   * 「終局を意識して攻め急ぐ」効果を狙う。
   */
  selfNearEnd: number;
  /** リーチ（最上段同色枚数）5以上に対するボーナス */
  reach5plus: number;
  /** リーチ 4 に対するボーナス */
  reach4: number;
  /** リーチ 3 に対するボーナス */
  reach3: number;
  /** リーチ 2 に対するボーナス */
  reach2: number;
  /** リーチ 1（その色が1スロットだけ）に対するボーナス */
  reach1: number;
  /** スタック上下2枚同色のときの連鎖種ボーナス */
  chainSeed: number;
  /** ボードの総カードがスロット数×3を超えた分のペナルティ係数 */
  overflowPenalty: number;
  /** 相手スコアの脅威換算係数 */
  threatScoreMult: number;
  /** 相手が終了閾値-5に近いときの追加脅威 */
  threatNearEnd: number;
  /** 相手のリーチ3以上に対する脅威 */
  threatReach3plus: number;
  /** 相手のリーチ2に対する脅威 */
  threatReach2: number;
  /** 相手の連鎖種に対する脅威 */
  threatChainSeed: number;
  /** 当該ターンに蓄積した combo 得点に対する加点係数 */
  pendingMult: number;
  /** 勝者になっている終局状態の加点 */
  winnerBonus: number;
  /** 自分以外が勝者の終局状態の減点 */
  loserPenalty: number;
}

/**
 * 評価関数のデフォルト重み。
 * Gen-3-F（warm-start 本格 ES, 18世代 × 100局, seed=3, sigma=0.15, init=Gen-3-B-2）。
 * Gen-3-E（selfNearEnd 追加）は holdout で過学習だったため、`selfNearEnd: 0` で無効化保持。
 * 過去の重みは `src/ai/tunedWeights.ts`（PRE_GEN_3B_WEIGHTS, GEN_3B_WEIGHTS, GEN_3B2_WEIGHTS, GEN_3F_WEIGHTS, GEN_3E_WEIGHTS）に保存。
 * 詳細は `ai/CHANGELOG.md` の Gen-3-* エントリ参照。
 */
export const DEFAULT_WEIGHTS: EvalWeights = {
  selfScoreMult: 123.74412520337883,
  selfNearEnd: 0,
  reach5plus: 222.70006942917246,
  reach4: 89.8947341180037,
  reach3: 58.05799904016309,
  reach2: 15.306691551949978,
  reach1: 0.8372739229581236,
  chainSeed: 9.289075324072758,
  overflowPenalty: 6.6330490901926815,
  threatScoreMult: 56.6243109358727,
  threatNearEnd: 46.77124514736809,
  threatReach3plus: 63.067681967688806,
  threatReach2: 19.312148930790322,
  threatChainSeed: 3.099849098892464,
  pendingMult: 106.5629775591632,
  winnerBonus: 5211.641039704553,
  loserPenalty: 3128.971983687204,
};

/**
 * モジュールレベルの可変重み。チューニング時に `setEvalWeights` で差し替える想定。
 * 単スレッド Node.js / ブラウザ環境を前提（並列実行で共有される点に注意）。
 */
let currentWeights: EvalWeights = { ...DEFAULT_WEIGHTS };

export function setEvalWeights(weights: Partial<EvalWeights>): void {
  currentWeights = { ...currentWeights, ...weights };
}

export function resetEvalWeights(): void {
  currentWeights = { ...DEFAULT_WEIGHTS };
}

export function getEvalWeights(): EvalWeights {
  return { ...currentWeights };
}

interface BoardSignal {
  reachByColor: Map<Color, number>;
  chainSeeds: number;
  totalCards: number;
}

function readBoardSignal(player: Player): BoardSignal {
  const reach = new Map<Color, number>();
  let chainSeeds = 0;
  let totalCards = 0;
  for (const slot of player.board.slots) {
    const stack = slot.stack;
    totalCards += stack.length;
    const top = stack[stack.length - 1];
    if (!top) continue;
    reach.set(top.color, (reach.get(top.color) ?? 0) + 1);
    const below = stack[stack.length - 2];
    if (below && below.color === top.color) chainSeeds += 1;
  }
  return { reachByColor: reach, chainSeeds, totalCards };
}

function selfScore(player: Player, w: EvalWeights): number {
  const sig = readBoardSignal(player);
  let score = player.score * w.selfScoreMult;
  if (player.score >= END_SCORE_THRESHOLD - 5) score += w.selfNearEnd;
  for (const count of sig.reachByColor.values()) {
    if (count >= 5) score += w.reach5plus;
    else if (count >= 4) score += w.reach4;
    else if (count >= 3) score += w.reach3;
    else if (count === 2) score += w.reach2;
    else score += w.reach1;
  }
  score += sig.chainSeeds * w.chainSeed;

  const slotCount = player.board.slots.length;
  if (sig.totalCards > slotCount * 3) {
    score -= (sig.totalCards - slotCount * 3) * w.overflowPenalty;
  }
  return score;
}

function threatScore(player: Player, w: EvalWeights): number {
  const sig = readBoardSignal(player);
  let score = player.score * w.threatScoreMult;
  if (player.score >= END_SCORE_THRESHOLD - 5) score += w.threatNearEnd;
  for (const count of sig.reachByColor.values()) {
    if (count >= 3) score += w.threatReach3plus;
    else if (count === 2) score += w.threatReach2;
  }
  score += sig.chainSeeds * w.threatChainSeed;
  return score;
}

/**
 * 状態を評価する。
 *
 * @param weights 省略時はモジュール global の `currentWeights`（`setEvalWeights` で書き換え可）を使う。
 *                明示すれば呼び出し単位で独立した重みを使えるため、
 *                「AI ごとに別の重みで動かす」用途や「学習中に対戦相手だけ default 重みで固定」用途に使う。
 */
export function evaluateState(
  state: GameState,
  playerId: number,
  weights?: EvalWeights
): number {
  const w = weights ?? currentWeights;
  const me = state.players[playerId];
  let value = selfScore(me, w);
  if (state.currentPlayerIndex === playerId) {
    const pending = totalScoreForTurn(state.turn.combosThisTurn);
    value += pending.total * w.pendingMult;
  }
  for (const p of state.players) {
    if (p.id === playerId) continue;
    value -= threatScore(p, w);
  }
  if (state.winnerId === playerId) value += w.winnerBonus;
  else if (state.winnerId !== null) value -= w.loserPenalty;
  return value;
}

export function topColorCounts(player: Player): Map<Color, number> {
  return readBoardSignal(player).reachByColor;
}
