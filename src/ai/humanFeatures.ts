/**
 * 人間プライア（E2: 人間棋譜の模倣）用の共有特徴抽出。
 *
 * 27 局の人間棋譜から「人間が選んだ配置後の局面」を正例とする条件付きロジットを学習し
 * （`ai/scripts/learn-human-prior.ts`）、その効用 w·φ(局面) を tempoFast の葉評価に
 * 「人間らしさ加点」として注入する（`src/ai/tempoHumanAI.ts`）。
 *
 * **学習と推論で φ が完全に一致している必要がある**ため、特徴抽出はこの 1 箇所に集約する。
 * 特徴は NN 用の高次元 encodeState（185 次元）ではなく、小データ（配置決定 ~数百件）で
 * 過学習しにくいコンパクトな手作り次元にする。人間優位の核が race-timing（いつ仕掛けて
 * 20 点レースに先着するか）と判明しているため、得点位置・レース圧・コンボ準備・素材・テンポを
 * 解釈可能な形で並べる。
 */
import type { Color, GameState, Player } from '../game/types';
import { END_SCORE_THRESHOLD } from '../game/engine';
import { totalScoreForTurn } from '../game/scoring';

/** 学習済み条件付きロジットモデル（標準化 + 線形効用）。 */
export interface HumanPriorModel {
  /** 特徴名（順序は humanFeatures の出力と一致）。 */
  featureNames: string[];
  /** 標準化の平均（学習データ由来）。 */
  mean: number[];
  /** 標準化の標準偏差（学習データ由来、0 は 1 に置換済み）。 */
  std: number[];
  /** 標準化済み特徴に対する線形効用の重み。 */
  weights: number[];
}

export const HUMAN_FEATURE_NAMES = [
  'selfScore', // 自分の得点 / 20
  'scoreLead', // (自分 - 最強相手) / 20  … レース上の位置
  'maxOppScore', // 最強相手の得点 / 20    … レース圧（誰かが 20 に近いか）
  'selfMaxReach', // 自分の最大同色リーチ / 5
  'selfReach2', // リーチ2の色数 / 5
  'selfReach3plus', // リーチ3+の色数 / 5
  'selfReach4plus', // リーチ4+の色数 / 5
  'selfTotalCards', // 盤面総カード / 15（slots*3）… 素材
  'selfChainSeeds', // 上下同色（縦積み種）数 / 5
  'selfCascade2plus', // 2層目同色>=2 の色数 / 5 … 縦積みカスケード仕込み
  'selfSlotSpread', // (最大-最小スタック高) / 5 … 偏り
  'pendingThisTurn', // 当ターン未確定コンボ総得点 / 10（自分の手番のみ）
  'turnNumber', // turnNumber / 30 … 局の進行
  'endTriggered', // 最終ラウンド突入フラグ
] as const;

interface BoardSig {
  maxReach: number;
  reach2: number;
  reach3plus: number;
  reach4plus: number;
  totalCards: number;
  chainSeeds: number;
  cascade2plus: number;
  maxH: number;
  minH: number;
}

function boardSignal(player: Player): BoardSig {
  const reach = new Map<Color, number>();
  const below = new Map<Color, number>();
  let chainSeeds = 0;
  let totalCards = 0;
  let maxH = 0;
  let minH = Infinity;
  for (const slot of player.board.slots) {
    const st = slot.stack;
    const h = st.length;
    totalCards += h;
    if (h > maxH) maxH = h;
    if (h < minH) minH = h;
    const top = st[h - 1];
    if (!top) continue;
    reach.set(top.color, (reach.get(top.color) ?? 0) + 1);
    const b = st[h - 2];
    if (b) {
      below.set(b.color, (below.get(b.color) ?? 0) + 1);
      if (b.color === top.color) chainSeeds += 1;
    }
  }
  let maxReach = 0;
  let reach2 = 0;
  let reach3plus = 0;
  let reach4plus = 0;
  for (const c of reach.values()) {
    if (c > maxReach) maxReach = c;
    if (c === 2) reach2++;
    if (c >= 3) reach3plus++;
    if (c >= 4) reach4plus++;
  }
  let cascade2plus = 0;
  for (const c of below.values()) if (c >= 2) cascade2plus++;
  return {
    maxReach,
    reach2,
    reach3plus,
    reach4plus,
    totalCards,
    chainSeeds,
    cascade2plus,
    maxH,
    minH: minH === Infinity ? 0 : minH,
  };
}

/**
 * pid 視点のコンパクト特徴ベクトル（HUMAN_FEATURE_NAMES と同順）。任意の phase の局面で計算可能。
 */
export function humanFeatures(state: GameState, pid: number): number[] {
  const T = END_SCORE_THRESHOLD; // 20
  const me = state.players[pid];
  const sig = boardSignal(me);
  let maxOpp = 0;
  for (const p of state.players) {
    if (p.id === pid) continue;
    if (p.score > maxOpp) maxOpp = p.score;
  }
  let pending = 0;
  if (state.currentPlayerIndex === pid) {
    pending = totalScoreForTurn(state.turn.combosThisTurn).total;
  }
  return [
    me.score / T,
    (me.score - maxOpp) / T,
    maxOpp / T,
    sig.maxReach / 5,
    sig.reach2 / 5,
    sig.reach3plus / 5,
    sig.reach4plus / 5,
    sig.totalCards / 15,
    sig.chainSeeds / 5,
    sig.cascade2plus / 5,
    (sig.maxH - sig.minH) / 5,
    pending / 10,
    state.turnNumber / 30,
    state.endTriggered ? 1 : 0,
  ];
}

/**
 * 学習済みモデルで「人間らしさ効用」を返す: 標準化済み φ と重みの内積。
 * tempoHumanAI の葉評価に humanPriorW 倍して加える。
 */
export function humanPriorScore(state: GameState, pid: number, model: HumanPriorModel): number {
  const phi = humanFeatures(state, pid);
  let s = 0;
  for (let i = 0; i < phi.length; i++) {
    const z = (phi[i] - model.mean[i]) / model.std[i];
    s += z * model.weights[i];
  }
  return s;
}
