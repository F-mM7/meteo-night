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

  // === Gen-3-L 追加候補 ===
  /**
   * `state.endTriggered === true` （誰かが終了閾値を踏み、 最終ラウンドに突入した）状態で、
   * 自分の reach が 1 または 2 のみ（残り 1-2 turn では完成しない見込み）の color 1 個あたり減点。
   * 「もう間に合わない」 reach は価値が無いことを表現。
   */
  endRoundLowReachPenalty: number;
  /**
   * endTriggered = true で reach 3+ がある color 1 個あたり加点（今 turn で完成可能）。
   * 「今すぐ仕上げる」 を急がせる。
   */
  endRoundHighReachBonus: number;
  /**
   * スロット高さの偏り（max - min）係数。 偏ってるほどジャム（overflow）に近い構造で配置自由度が低い。
   * overflowPenalty は総量のみ見るのに対し、 これは分布の偏りを見る補完。
   */
  slotEvennessPenalty: number;
  /**
   * 自分の手番中、 場 (field) の公開 4 枚に「自分の reach 2-4 と同色」 のカードがある時の機会ボーナス。
   * 「次手で完成できる pair が見えている」 状態を高評価する。
   * pair の 2 枚中 1 枚でも一致すれば 1 加算。
   */
  fieldOpportunityMatch: number;

  /**
   * 連鎖準備度（ある 1 色が複数スロットの最上段付近に並んでいる度合い）への加点係数。
   * Gen-3-W: 大連鎖を仕込む盤面を高評価し、 AI に連鎖構築を志向させる狙い。0 で従来挙動。
   */
  chainReadyMult: number;

  /**
   * 自己得点項の非線形（凸/凹）係数。
   * 自己得点項を `score * selfScoreMult * (1 + selfScoreConvex * score / END_SCORE_THRESHOLD)` とする。
   *   - 0（デフォルト）: 従来の線形（`score * selfScoreMult`）と完全一致
   *   - 正値: 高得点ほど 1 点の価値が逓増（凸）
   *   - 負値: 高得点ほど 1 点の価値が逓減（凹、 saturating）
   *
   * Gen-3-U で凸・凹の両方向を grid 検証（vs smart 100 局）したが、 **0（線形）が両方向のピーク**で、
   * 正にしても負にしても勝率が下がった（凹 -0.5 は avgScore 最高だが勝率は最低）。
   * 現状の評価は「得点差（self − threat）を tanh 飽和」 する形で既に勝利位置を表現できており、
   * 得点項の形状変更では改善しないと判明。 0 のまま保持（将来の構造変更時の再検証用）。
   */
  selfScoreConvex: number;
}

/**
 * 評価関数のデフォルト重み。
 * Gen-3-F（warm-start 本格 ES, 18世代 × 100局, seed=3, sigma=0.15, init=Gen-3-B-2）。
 * Gen-3-E（selfNearEnd 追加）は holdout で過学習だったため、`selfNearEnd: 0` で無効化保持。
 * 過去の重みは `src/ai/tunedWeights.ts` の `GEN_3B_WEIGHTS` に保存。
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
  // Gen-3-L 候補（ES tune 前は 0 = 既存挙動と互換）
  endRoundLowReachPenalty: 0,
  endRoundHighReachBonus: 0,
  slotEvennessPenalty: 0,
  fieldOpportunityMatch: 0,
  // Gen-3-U 候補（0 = 従来の線形得点項と完全一致）
  selfScoreConvex: 0,
  // Gen-3-X 採用: 連鎖準備度の加点。 smart 非依存ベンチ（mcts候補 vs mcts baseline, 150局）で
  // chainReadyMult=10 が勝率 33.3% (CI 26.3-41.2%) > 公平基準 25% と有意に強いことを確認して採用。
  // vs smart では盲点共有で検出できなかった改善。 30 は過剰（競走で遅くなり不利）、 10 が好適。
  chainReadyMult: 10,
};

/**
 * モジュールレベルの可変重み。チューニング時に `setEvalWeights` で差し替える想定。
 * 単スレッド Node.js / ブラウザ環境を前提（並列実行で共有される点に注意）。
 */
let currentWeights: EvalWeights = { ...DEFAULT_WEIGHTS };

export function setEvalWeights(weights: Partial<EvalWeights>): void {
  currentWeights = { ...currentWeights, ...weights };
}

interface BoardSignal {
  reachByColor: Map<Color, number>;
  chainSeeds: number;
  totalCards: number;
  /** 各スロットの stack 長 (Gen-3-L: 偏り評価用) */
  maxStackHeight: number;
  minStackHeight: number;
}

function readBoardSignal(player: Player): BoardSignal {
  const reach = new Map<Color, number>();
  let chainSeeds = 0;
  let totalCards = 0;
  let maxStackHeight = 0;
  let minStackHeight = Infinity;
  for (const slot of player.board.slots) {
    const stack = slot.stack;
    const h = stack.length;
    totalCards += h;
    if (h > maxStackHeight) maxStackHeight = h;
    if (h < minStackHeight) minStackHeight = h;
    const top = stack[stack.length - 1];
    if (!top) continue;
    reach.set(top.color, (reach.get(top.color) ?? 0) + 1);
    const below = stack[stack.length - 2];
    if (below && below.color === top.color) chainSeeds += 1;
  }
  return {
    reachByColor: reach,
    chainSeeds,
    totalCards,
    maxStackHeight,
    minStackHeight: minStackHeight === Infinity ? 0 : minStackHeight,
  };
}

/**
 * 連鎖準備度: ある 1 色が「複数スロットの最上段付近（上 2 枚以内）」 に並んでいるほど高い。
 * 3 スロット以上に並べば大連鎖を起こせるため、 それを近似する（chainRushAI と同設計）。
 */
function chainReadinessScore(player: Player): number {
  const topCount = new Map<Color, number>();
  const nearTopCount = new Map<Color, number>();
  for (const slot of player.board.slots) {
    const n = slot.stack.length;
    if (n === 0) continue;
    const top = slot.stack[n - 1];
    topCount.set(top.color, (topCount.get(top.color) ?? 0) + 1);
    const near = new Set<Color>();
    near.add(top.color);
    if (n >= 2) near.add(slot.stack[n - 2].color);
    for (const c of near) nearTopCount.set(c, (nearTopCount.get(c) ?? 0) + 1);
  }
  let best = 0;
  for (const [color, near] of nearTopCount) {
    const r = near * 3 + (topCount.get(color) ?? 0);
    if (r > best) best = r;
  }
  return best;
}

function selfScore(player: Player, state: GameState, w: EvalWeights): number {
  const sig = readBoardSignal(player);
  // Gen-3-U: 得点項を終了閾値への近さで逓増（凸）。selfScoreConvex=0 で従来の線形と一致。
  const convexFactor = 1 + w.selfScoreConvex * (player.score / END_SCORE_THRESHOLD);
  let score = player.score * w.selfScoreMult * convexFactor;
  if (player.score >= END_SCORE_THRESHOLD - 5) score += w.selfNearEnd;
  // Gen-3-W: 連鎖準備度の加点（chainReadyMult=0 なら無効＝従来挙動）。
  if (w.chainReadyMult !== 0) score += w.chainReadyMult * chainReadinessScore(player);
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

  // Gen-3-L: 終局突入後の reach 期待値補正
  // endTriggered = true ということは最終 round 中。 reach 1-2 は完成見込み低い、
  // reach 3+ は今 turn で完成可能 → 急ぐ
  if (state.endTriggered) {
    for (const count of sig.reachByColor.values()) {
      if (count >= 3) score += w.endRoundHighReachBonus;
      else if (count >= 1) score -= w.endRoundLowReachPenalty;
    }
  }

  // Gen-3-L: スロット高さの偏りペナルティ
  // overflowPenalty は総量だけ見るが、 偏りも問題（1 slot だけ高いと配置自由度が落ちる）
  score -= (sig.maxStackHeight - sig.minStackHeight) * w.slotEvennessPenalty;

  // Gen-3-L: 場の機会マッチ
  // 自分の手番中、 公開 field に「自分の reach 2-4 と同色」 のカードがあれば次手で完成 / 進捗可
  if (state.currentPlayerIndex === player.id) {
    for (const pair of state.field) {
      if (!pair) continue;
      for (const card of pair) {
        const r = sig.reachByColor.get(card.color) ?? 0;
        if (r >= 2 && r <= 4) score += w.fieldOpportunityMatch;
      }
    }
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
  let value = selfScore(me, state, w);
  if (state.currentPlayerIndex === playerId) {
    const pending = totalScoreForTurn(state.turn.combosThisTurn);
    value += pending.total * w.pendingMult;
  }
  for (const p of state.players) {
    if (p.id === playerId) continue;
    value -= threatScore(p, w);
  }
  // 終局加点は smartAI 専用。mctsAI / neuralMcts は終局をランキング経由で leaf 価値に
  // 直接マップしてから evaluateState を呼ぶため、それらの経路では `winnerId` が常に null で
  // ここには到達しない。終局価値のランキング一本化は smartAI の意思決定を変えてしまうため、
  // 別バッチ（REFACTORING.md 項目 7 案 a）で扱う。
  if (state.winnerId === playerId) value += w.winnerBonus;
  else if (state.winnerId !== null) value -= w.loserPenalty;
  return value;
}

export function topColorCounts(player: Player): Map<Color, number> {
  return readBoardSignal(player).reachByColor;
}
