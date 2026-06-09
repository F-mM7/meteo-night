/**
 * tempoLatticeAI ― 現チャンピオン tempoFast の探索エンジン（自分の手番完全読み + LA=1 +
 * αβ + 反復深化 + TT）をそのまま使い、葉評価にだけ人間戦略
 * 「5色で5コンボを最速で組む（4スロットで完成・1スロットは捨て札置き場）」を静的な
 * formation 項として加える派生（Gen-12 候補）。formationW=0 で tempoFast と完全一致。
 * formation の定義は下の formationScore / FormParams を参照。
 *
 * --- 以下は土台 tempoFast 由来の探索の説明（そのまま流用） ---
 * tempoFastAI ― tempoAI（Gen-4-A）の「自分の手番完全読み + テンポ評価」 を踏襲しつつ、
 * 探索コストを大幅に下げて (a) レイテンシ tail を有界化し (b) より深い先読みを可能にする変種。
 *
 * tempoAI との差分（探索の中身だけを最適化。 評価関数 leafValue は完全に同一）:
 *   1) 壁時計タイムバジェット + 反復深化（iterative deepening）:
 *        decideAction ごとに目標時間（timeBudgetMs）を設け、 maxPlaceDepth を浅い側から
 *        段階的に深くしながら探索する。 期限超過時はその反復を破棄し、 直前に完走した
 *        深さの「best-so-far」 root 手を返す。 これにより連鎖が爆発する局面でも
 *        最悪レイテンシが timeBudget 程度で頭打ちになる。
 *   2) 着手順序付け + αβ 枝刈り（max ノードのみ）:
 *        各 max ノードで子の即時評価（evaluateState）で着手を降順ソートし、 αβ で
 *        劣勢な枝を刈る。 expectimax のドローノード（chance）は αβ で刈れないが、
 *        サンプルをソート/上限化して期待値の分散と本数を抑える。
 *   3) Transposition Table（盤面ハッシュ keyed）:
 *        2 枚配置の順序入れ替えや可換な配置で大量の transposition が生じる。
 *        observationKey（mctsAI と同じ正典ハッシュ）+ 残り探索量で leaf/部分木の値を
 *        decideAction 内でキャッシュする（手ごとにクリア）。
 *
 * STRETCH（lookaheadTurns>0）:
 *   tempoAI は先読み中の相手手番を smartAI で進める（advanceToMyTurn）。 本変種は
 *   `opponentModel` オプションで相手モデルを 'smart' | 'mcts' | 'tempo' から選べる。
 *   より強い相手モデルで 2-ply（lookahead=1）にしたときに現状 tempo を上回るか検証するため。
 *
 * 注意: tempoAI.ts / evaluator.ts / index.ts 等の共有ファイルは一切変更しない（本ファイルは追加のみ）。
 */
import type { Action, Color, GameState, Player } from '../game/types';
import { COLORS } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { evaluateState, type EvalWeights } from './evaluator';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { decideAction as decideMcts } from './mctsAI';
import { observationKey } from './infoSet';

export type OpponentModel = 'smart' | 'mcts' | 'tempo';

/** 人間戦略 formation 項の内部重み（チューニング対象）。 */
export interface FormParams {
  /** 4 working スロットの下層(d>=1)で同色3スロット以上=装填済みカスケード層1つあたり加点（連鎖「数」potential の主役）。 */
  chainW: number;
  /** 装填層に現れた色数1つあたり加点（5色性）。 */
  colorW: number;
  /** 最上段で同色ちょうど2（あと1枚で発火）の引き金1つあたり加点（最速の発火準備）。 */
  triggerW: number;
  /** working 総カードがこれを超えたら depthPenalty を課す閾値。 */
  depthTarget: number;
  /** 過剰積み（完成せず溜め続ける暴走）ペナルティ係数。 */
  depthPenalty: number;
}

export const DEFAULT_FORM_PARAMS: FormParams = {
  // 連鎖「数」(loaded)を主役に線形評価し、色数と発火寸前を補助に。size4/5 は base の reach 項に委ねる。
  chainW: 1,
  colorW: 0.3,
  triggerW: 0.5,
  depthTarget: 16, // 4 working スロットで 5連鎖を組むには深さが要るので緩め。
  depthPenalty: 2, // 完成せず溜め続ける暴走だけを軽く罰する。
};

export interface TempoLatticeOptions {
  /** 人間戦略の formation 項への係数。0 で tempoFast と完全一致。既定で有効。 */
  formationW?: number;
  /** formation 項の内部重み（省略時は DEFAULT_FORM_PARAMS）。チューニング用。 */
  formParams?: Partial<FormParams>;
  /** leaf 評価の重み。省略時は evaluator のモジュール global（DEFAULT_WEIGHTS）を使う。 */
  weights?: EvalWeights;
  /** 複数色チェイン準備度への加点係数（tempoAI と同一の意味・既定値）。 */
  tempoChainW?: number;
  /** 多ターン先読みのターン数（0 で 1 ターン完全読みのみ＝tempoAI の既定挙動）。 */
  lookaheadTurns?: number;
  /** ターン最初の山札ドロー（先頭 2 枚が不明）の期待値サンプル数。 */
  rootDrawSamples?: number;
  /** 連鎖中の追加ドロー（先頭 1 枚が不明）の期待値サンプル数。ネストするので小さめ。 */
  chainDrawSamples?: number;
  /** 反復深化で到達しうる最大の配置深さ（安全弁）。 */
  maxPlaceDepth?: number;
  /** 1 手あたりの壁時計タイムバジェット（ms）。超過すると best-so-far を返す。 */
  timeBudgetMs?: number;
  /** 反復深化の開始深さ。 */
  minPlaceDepth?: number;
  /** lookahead>0 のとき相手手番を進めるモデル。'smart'（既定・tempoAI 互換）/ 'mcts' / 'tempo'。 */
  opponentModel?: OpponentModel;
  /** opponentModel='mcts' のときの探索 iteration（軽量化のため既定を小さめにする）。 */
  opponentMctsIterations?: number;
}

const DEFAULT_TEMPO_CHAIN_W = 50;
// ブラウザ既定で 1（2 手先読み）。lookahead=1 は現 tempoFast(LA=0) に有意勝ち（n=300, 33.0%,
// CI 下限 27.9% > 公平 25%）。ただし 1 手 ~1 秒（中央値）と重いので、ブラウザでは Web Worker
// （src/ai/aiWorker.ts）で実行し UI をブロックしない。相手モデルは既定の 'smart'。
const DEFAULT_LOOKAHEAD_TURNS = 1;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
// ブラウザ既定。1 手あたりの壁時計上限（=最悪フリーズ時間の上限）。tempoAI の無制限探索が
// 連鎖の配置局面で最大 ~21 秒固まる問題への対処。250ms では現 tempo より有意に弱かった(19.3%, n=300)
// ため、打ち切り頻度を下げて強さを回復させる狙いで ~1 秒に設定。max は反復深化 1 段ぶん超過しうる。
const DEFAULT_TIME_BUDGET_MS = 1000;
const DEFAULT_MIN_PLACE_DEPTH = 2;
const DEFAULT_OPPONENT_MODEL: OpponentModel = 'smart';
const DEFAULT_OPPONENT_MCTS_ITER = 120;
/** 人間戦略 formation 項のマスター係数（既定で ON。0 で tempoFast 一致）。 */
// 「それ以外では発火を許さない」を満たす大きめの既定: 小連鎖で撃つより形を保つ方を高評価にする。
// ただし完成した5連鎖の firing payoff（超線形 n(n-1)/2）は上回るよう調整＝完成したら撃てる。要・人間 playtest 微調整。
const DEFAULT_FORMATION_W = 280;
/** 相手のチェイン準備度を脅威として割り引く係数（tempoAI と同一）。 */
const OPP_CHAIN_FACTOR = 0.5;
/** 先読みで相手の手番を進める際の無限ループ安全弁。 */
const ADVANCE_MAX_STEPS = 400;
/**
 * Date.now() 呼び出しコストを抑えるため、 leaf 評価 N 回ごとにのみ期限を確認する。
 *   - lookahead=0: 1 leaf が安価（静的評価のみ）なので 1024 ごとでよい。
 *   - lookahead>0: 1 leaf で advanceToMyTurn（相手 mcts/tempo を数手）が走り 1 leaf が高価なので
 *     16 ごとに細かく確認する（粗いと 1 チェック間隔で予算を大幅超過しうる）。
 *   さらに advanceToMyTurn 直後にも明示確認する（下記 searchTurn 参照）。
 */
const TIME_CHECK_MASK_CHEAP = 0x3ff; // 1024 leaf ごと
const TIME_CHECK_MASK_EXPENSIVE = 0xf; // 16 leaf ごと

interface ResolvedOptions {
  weights: EvalWeights | undefined;
  tempoChainW: number;
  formationW: number;
  formParams: FormParams;
  lookaheadTurns: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
  timeBudgetMs: number;
  minPlaceDepth: number;
  opponentModel: OpponentModel;
  opponentMctsIterations: number;
}

/** 期限超過を反復深化ループまで伝播させるためのセンチネル。 */
class BudgetExceeded extends Error {}

/**
 * 探索 1 回分（1 深さ）の共有コンテキスト。 TT・期限・leaf カウンタを束ねる。
 * 反復深化の各深さで新しい SearchContext を作る（TT を深さ間で再利用しない＝健全性優先）。
 */
interface SearchContext {
  me: number;
  opts: ResolvedOptions;
  deadline: number;
  /** observationKey(+残り深さ+turnDepth) -> 部分木の値。決定的に到達したノードのみ格納。 */
  tt: Map<string, number>;
  leafCounter: number;
  timedOut: boolean;
  /** 期限確認の間引きマスク（lookahead の有無で粗密を変える）。 */
  timeCheckMask: number;
  /**
   * 直近に評価した部分木が「chance（観測不能ドロー）を一切含まない＝再現可能」 だったか。
   * TT への格納は pure な部分木に限定して健全性を保つ（seed 依存の期待値はキャッシュしない）。
   * searchTurn / evalAction の戻り値とセットで読む（呼び出し直後に参照する規約）。
   */
  pure: boolean;
}

function currentActorId(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

function stateBaseSeed(state: GameState, playerId: number): number {
  const a = state.rngSeed >>> 0;
  const b = Math.imul(state.turnNumber + 1, 0x9e3779b1);
  const c = Math.imul(playerId + 1, 0x85ebca6b);
  const d = Math.imul(state.log.length + 1, 0xc2b2ae35);
  return (a ^ b ^ c ^ d) | 0;
}

function enumerateOwnActions(state: GameState, actor: number): Action[] {
  const ids = legalActionIds(state, actor);
  const acts: Action[] = [];
  for (const id of ids) {
    const a = actionIdToAction(state, actor, id);
    if (a) acts.push(a);
  }
  return acts;
}

function isBlindDraw(action: Action): boolean {
  return action.type === 'DRAW_FROM_DECK' || action.type === 'CHOOSE_ADDITIONAL_DRAW';
}

function isPlacement(action: Action): boolean {
  return (
    action.type === 'PLACE_DRAWN' ||
    action.type === 'PLACE_ADDITIONAL_DRAW' ||
    action.type === 'DISCARD_TOP'
  );
}

const COLOR_INDEX: Record<string, number> = {};
COLORS.forEach((c, i) => {
  COLOR_INDEX[c] = i;
});

/**
 * 人間戦略の中核「1ターンで size3 の5連鎖を組む形」を測る（best-4-of-5）。
 *   - 4 working スロットで多色の縦カスケードを組み、残り1スロットは捨て札置き場。
 *   - コンボは size3（同色3枚=発火の最小）でよく、狙いは連鎖の「数」（5色=5連鎖）。
 *   - 「それ以外では発火を許さない」: 小連鎖で撃たず、形が完成してから一気に discharge。
 * 実装: working スロットの下層(d>=1)で「同色>=3」の装填済み層を数える＝1トリガで連鎖するコンボ数
 * potential。これを線形に評価（連鎖数を積むほど価値↑。完成時の firing payoff＝超線形 n(n-1)/2 が
 * 上回るよう線形に保つ＝完成したら撃てる）。色数(5色性)と最上段の発火寸前(引き金)を補助に。size4/5 は
 * base の reach 項が見るので特別扱いしない。捨て札スロットは best-4-of-5 で自動的に除外する。
 */
const FORM_COUNTS = new Int8Array(5); // 単スレッド同期探索専用の再利用スクラッチ。

function workingFormation(slots: Player['board']['slots'], junkIdx: number, p: FormParams): number {
  let maxH = 0;
  let totalCards = 0;
  for (let i = 0; i < slots.length; i++) {
    if (i === junkIdx) continue;
    const h = slots[i].stack.length;
    totalCards += h;
    if (h > maxH) maxH = h;
  }
  if (maxH === 0) return 0;

  let loaded = 0;
  let colorMask = 0;
  let triggerNear = 0;
  for (let d = 0; d < maxH; d++) {
    FORM_COUNTS.fill(0);
    for (let i = 0; i < slots.length; i++) {
      if (i === junkIdx) continue;
      const st = slots[i].stack;
      const idx = st.length - 1 - d;
      if (idx < 0) continue;
      FORM_COUNTS[COLOR_INDEX[st[idx].color]] += 1;
    }
    let dom = 0;
    let domColor = -1;
    for (let c = 0; c < 5; c++) {
      if (FORM_COUNTS[c] > dom) {
        dom = FORM_COUNTS[c];
        domColor = c;
      }
    }
    if (d === 0) {
      if (dom === 2) triggerNear += 1; // 発火寸前（あと1枚で size3）。解決済み leaf は dom<=2。
    } else if (dom >= 3) {
      loaded += 1; // 装填済みカスケード層＝連鎖1つぶんの potential。
      if (domColor >= 0) colorMask |= 1 << domColor;
    }
  }
  let colorCount = 0;
  for (let m = colorMask; m; m &= m - 1) colorCount += 1;

  let score = p.chainW * loaded + p.colorW * colorCount + p.triggerW * triggerNear;
  if (p.depthPenalty !== 0 && totalCards > p.depthTarget) {
    score -= p.depthPenalty * (totalCards - p.depthTarget); // 完成せず溜め続ける暴走を罰する。
  }
  return score;
}

function formationScore(player: Player, p: FormParams): number {
  const slots = player.board.slots;
  const n = slots.length;
  if (n === 0) return 0;
  if (n < 5) return workingFormation(slots, -1, p); // 5スロット未満なら捨て札なし。
  // 捨て札にする1スロットを選び、残り4 working でのチェイン potential を最大化（best-4-of-5）。
  let best = -Infinity;
  for (let junk = 0; junk < n; junk++) {
    const s = workingFormation(slots, junk, p);
    if (s > best) best = s;
  }
  return best;
}

/** tempoAI と完全に同一の複数色チェイン準備度。 */
function multiColorChainReadiness(player: Player): number {
  const topCount = new Map<Color, number>();
  const nearCount = new Map<Color, number>();
  for (const slot of player.board.slots) {
    const n = slot.stack.length;
    if (n === 0) continue;
    const top = slot.stack[n - 1];
    topCount.set(top.color, (topCount.get(top.color) ?? 0) + 1);
    const near = new Set<Color>([top.color]);
    if (n >= 2) near.add(slot.stack[n - 2].color);
    for (const c of near) nearCount.set(c, (nearCount.get(c) ?? 0) + 1);
  }
  let sum = 0;
  for (const [color, near] of nearCount) {
    if (near < 2) continue;
    const top = topCount.get(color) ?? 0;
    sum += near * near + top;
  }
  return sum;
}

/** tempoAI と完全に同一の leaf 評価（評価関数は一切変えない）。 */
function leafValue(state: GameState, me: number, opts: ResolvedOptions): number {
  let v = evaluateState(state, me, opts.weights);
  if (opts.tempoChainW !== 0) {
    v += opts.tempoChainW * multiColorChainReadiness(state.players[me]);
    for (const p of state.players) {
      if (p.id === me) continue;
      v -= opts.tempoChainW * OPP_CHAIN_FACTOR * multiColorChainReadiness(p);
    }
  }
  // 人間戦略の formation 項（自分のみ＝攻撃的。守備は base の threat 項に委ねる）。
  if (opts.formationW !== 0) {
    v += opts.formationW * formationScore(state.players[me], opts.formParams);
  }
  return v;
}

/** 着手順序付け用の「子の即時評価」。 placement の決定的遷移先を 1 手だけ評価する（安価）。 */
function quickChildScore(
  state: GameState,
  action: Action,
  me: number,
  opts: ResolvedOptions
): number {
  if (isBlindDraw(action)) {
    // ドローはサンプリングが要るので順序付けでは中立（実評価で展開）。
    return 0;
  }
  const next = stepGame(state, action);
  if (next === state) return -Infinity;
  return leafValue(next, me, opts);
}

function checkDeadline(ctx: SearchContext): void {
  if (((ctx.leafCounter++ & ctx.timeCheckMask) === 0) && Date.now() >= ctx.deadline) {
    ctx.timedOut = true;
    throw new BudgetExceeded();
  }
}

/** advanceToMyTurn など高コスト処理の直後に呼ぶ無条件の期限確認。 */
function checkDeadlineNow(ctx: SearchContext): void {
  if (Date.now() >= ctx.deadline) {
    ctx.timedOut = true;
    throw new BudgetExceeded();
  }
}

/**
 * 相手（および自分のギフト受領）の手番を相手モデルで進め、 自分の次の手番に戻った状態を返す。
 * tempoAI の advanceToMyTurn を opponentModel 切替できるように一般化したもの。
 */
function advanceToMyTurn(state: GameState, ctx: SearchContext, seed: number): GameState {
  let s = state;
  const opp = ctx.opts.opponentModel;
  for (let g = 0; g < ADVANCE_MAX_STEPS && s.phase !== 'gameOver'; g++) {
    if (s.currentPlayerIndex === ctx.me && s.phase === 'awaitingDraw') return s;
    const actor = currentActorId(s);
    const stepSeed = (seed + Math.imul(g + 1, 0x9e3779b1)) | 0;
    let a: Action | null;
    if (opp === 'mcts') {
      a = decideMcts(s, actor, stepSeed, {
        weights: ctx.opts.weights,
        iterations: ctx.opts.opponentMctsIterations,
      });
    } else if (opp === 'tempo') {
      // 相手 tempo は「自分の手番完全読みのみ（lookahead=0, TT/予算なし軽量）」 で 1 手返す。
      a = decideTempoOpponent(s, actor, stepSeed, ctx.opts);
    } else {
      a = decideSmart(s, actor, stepSeed);
    }
    if (!a) return s;
    const before = s;
    s = stepGame(s, a);
    if (s === before) return s;
  }
  return s;
}

/**
 * αβ 付き「自分の手番完全読み」。 actor が自分でなくなる/終局でターン内探索を止め、
 * lookahead 余地があれば相手を進めて次の手番を読む。
 * alpha/beta は max レイヤのみで有効（draw の chance ノードは平均なので刈らない）。
 */
function searchTurn(
  state: GameState,
  placeDepth: number,
  maxPlaceDepth: number,
  seed: number,
  turnDepth: number,
  alpha: number,
  beta: number,
  ctx: SearchContext
): number {
  checkDeadline(ctx);

  if (state.phase === 'gameOver') {
    ctx.pure = true;
    return leafValue(state, ctx.me, ctx.opts);
  }

  const me = ctx.me;
  const actor = currentActorId(state);
  if (actor !== me) {
    if (state.currentPlayerIndex !== me && turnDepth < ctx.opts.lookaheadTurns) {
      const advanced = advanceToMyTurn(state, ctx, seed);
      checkDeadlineNow(ctx); // 相手モデルの前進は高コスト。 直後に必ず期限を確認する。
      if (
        advanced.phase !== 'gameOver' &&
        advanced.currentPlayerIndex === me &&
        advanced.phase === 'awaitingDraw'
      ) {
        const v = searchTurn(
          advanced,
          0,
          maxPlaceDepth,
          (seed ^ 0x9e3779b9) | 0,
          turnDepth + 1,
          alpha,
          beta,
          ctx
        );
        // 相手手番を seeded ヒューリスティックで進めたので、 この部分木は再現可能でない。
        ctx.pure = false;
        return v;
      }
      ctx.pure = false; // advanceToMyTurn は seeded
      return leafValue(advanced, me, ctx.opts);
    }
    ctx.pure = true;
    return leafValue(state, me, ctx.opts);
  }

  // ギフト割り当ては得点不変のため smartAI のヒューリスティックで 1 手だけ進める（tempoAI と同じ）。
  if (state.phase === 'awaitingGiftSelection') {
    const a = decideSmart(state, me, seed);
    if (!a) {
      ctx.pure = true;
      return leafValue(state, me, ctx.opts);
    }
    const next = stepGame(state, a);
    if (next === state) {
      ctx.pure = true;
      return leafValue(state, me, ctx.opts);
    }
    const v = searchTurn(next, placeDepth, maxPlaceDepth, seed, turnDepth, alpha, beta, ctx);
    ctx.pure = false; // gift 割り当ては seeded ヒューリスティック
    return v;
  }

  // 反復深化の深さ上限に達したら静的評価で打ち切る（best-so-far の根拠）。
  if (placeDepth >= maxPlaceDepth) {
    ctx.pure = true;
    return leafValue(state, me, ctx.opts);
  }

  // Transposition Table 参照（決定的に到達したノードのみ。 残り深さ・turnDepth をキーに含める）。
  const remaining = maxPlaceDepth - placeDepth;
  const ttKey = observationKey(state, me) + '|r:' + remaining + '|t:' + turnDepth;
  const cached = ctx.tt.get(ttKey);
  if (cached !== undefined) {
    ctx.pure = true; // 格納済み = pure な部分木の確定値
    return cached;
  }

  const actions = enumerateOwnActions(state, me);
  if (actions.length === 0) {
    const lv = leafValue(state, me, ctx.opts);
    ctx.tt.set(ttKey, lv);
    ctx.pure = true;
    return lv;
  }

  // 着手順序付け: 子の即時評価で降順ソート（αβ の枝刈り効率を上げる）。
  // ドロー（chance）は score 0 で中立に置く。
  let ordered: Action[];
  if (actions.length > 1) {
    const scored = actions.map((a) => ({ a, s: quickChildScore(state, a, me, ctx.opts) }));
    scored.sort((x, y) => y.s - x.s);
    ordered = scored.map((x) => x.a);
  } else {
    ordered = actions;
  }

  let best = -Infinity;
  let a = alpha;
  let subtreePure = true; // 全子が pure かつ βカット無しのときのみ TT 格納可
  let cut = false;
  for (const action of ordered) {
    const v = evalAction(state, action, placeDepth, maxPlaceDepth, seed, turnDepth, a, beta, ctx);
    if (!ctx.pure) subtreePure = false;
    if (v > best) best = v;
    if (best > a) a = best;
    if (a >= beta) {
      cut = true;
      break; // βカット（max ノードのみ。 この値は下界なので exact TT には入れない）
    }
  }

  // pure かつ βカット無し（= 全子探索済みで exact）のときだけ TT に格納。
  if (subtreePure && !cut && best > -Infinity) ctx.tt.set(ttKey, best);
  ctx.pure = subtreePure;
  return best;
}

/**
 * 1 手の価値。 観測不能ドローは expectimax（サンプル平均）、 それ以外は決定的遷移。
 * draw の chance ノードは平均値なので β カットはできないが、 alpha は子に伝播する。
 */
function evalAction(
  state: GameState,
  action: Action,
  placeDepth: number,
  maxPlaceDepth: number,
  seed: number,
  turnDepth: number,
  alpha: number,
  beta: number,
  ctx: SearchContext
): number {
  if (isBlindDraw(action)) {
    let samples =
      action.type === 'DRAW_FROM_DECK'
        ? ctx.opts.rootDrawSamples
        : ctx.opts.chainDrawSamples;
    if (turnDepth > 0) samples = Math.min(samples, 2);
    let total = 0;
    let count = 0;
    for (let i = 0; i < samples; i++) {
      const rand = mulberry32((seed + Math.imul(i + 1, 0x9e3779b1)) | 0);
      const shuffled = shuffle(state.deck, rand);
      const sampledState: GameState = { ...state, deck: shuffled };
      const next = stepGame(sampledState, action);
      if (next === sampledState) continue;
      const childSeed = (seed ^ Math.imul(i + 1, 0x85ebca6b)) | 0;
      // chance ノードでは alpha/beta を緩く（±∞）渡す: 平均なので個々の子を刈ると期待値が歪む。
      total += searchTurn(
        next,
        placeDepth + 1,
        maxPlaceDepth,
        childSeed,
        turnDepth,
        -Infinity,
        Infinity,
        ctx
      );
      count++;
    }
    ctx.pure = false; // 観測不能ドローの期待値は seed 依存なので再現不可
    return count > 0 ? total / count : leafValue(state, ctx.me, ctx.opts);
  }

  const next = stepGame(state, action);
  if (next === state) {
    ctx.pure = true; // 無効手は確定（不変）
    return -Infinity;
  }
  const nextDepth = isPlacement(action) ? placeDepth + 1 : placeDepth;
  // 決定的遷移: 子 searchTurn が ctx.pure を設定するのでそのまま伝播する。
  return searchTurn(next, nextDepth, maxPlaceDepth, seed, turnDepth, alpha, beta, ctx);
}

/**
 * 相手モデル 'tempo' 用の軽量 tempo（lookahead=0, TT/予算/αβ なしの素朴な max）。
 * advanceToMyTurn 内から呼ぶため、 ネストして重くなり過ぎないよう浅い固定深さで動かす。
 */
function decideTempoOpponent(
  state: GameState,
  playerId: number,
  seed: number,
  parentOpts: ResolvedOptions
): Action | null {
  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    return decideSmart(state, playerId, seed);
  }
  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) return null;

  const actions = enumerateOwnActions(state, playerId);
  if (actions.length === 0) return null;
  if (actions.length === 1) return actions[0];

  // 浅い固定深さの素朴 max（相手モデルとして十分強く、 かつネストでも安価）。
  const oppOpts: ResolvedOptions = {
    ...parentOpts,
    lookaheadTurns: 0,
    maxPlaceDepth: 6,
    rootDrawSamples: 2,
    chainDrawSamples: 1,
  };
  const ctx: SearchContext = {
    me: playerId,
    opts: oppOpts,
    deadline: Infinity,
    tt: new Map(),
    leafCounter: 0,
    timedOut: false,
    timeCheckMask: TIME_CHECK_MASK_CHEAP,
    pure: false,
  };
  let bestAction: Action = actions[0];
  let bestValue = -Infinity;
  for (const action of actions) {
    const v = evalAction(state, action, 0, oppOpts.maxPlaceDepth, seed, 0, -Infinity, Infinity, ctx);
    if (v > bestValue) {
      bestValue = v;
      bestAction = action;
    }
  }
  return bestAction;
}

/**
 * tempoFastAI の行動決定（Decider 互換）。
 * 反復深化 + 壁時計バジェット: minPlaceDepth から maxPlaceDepth まで段階的に深くし、
 * 期限を超えたらその反復を破棄して直前完走深さの best-so-far root 手を返す。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoLatticeOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights,
    tempoChainW: options.tempoChainW ?? DEFAULT_TEMPO_CHAIN_W,
    formationW: options.formationW ?? DEFAULT_FORMATION_W,
    formParams: { ...DEFAULT_FORM_PARAMS, ...(options.formParams ?? {}) },
    lookaheadTurns: options.lookaheadTurns ?? DEFAULT_LOOKAHEAD_TURNS,
    rootDrawSamples: options.rootDrawSamples ?? DEFAULT_ROOT_DRAW_SAMPLES,
    chainDrawSamples: options.chainDrawSamples ?? DEFAULT_CHAIN_DRAW_SAMPLES,
    maxPlaceDepth: options.maxPlaceDepth ?? DEFAULT_MAX_PLACE_DEPTH,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    minPlaceDepth: options.minPlaceDepth ?? DEFAULT_MIN_PLACE_DEPTH,
    opponentModel: options.opponentModel ?? DEFAULT_OPPONENT_MODEL,
    opponentMctsIterations: options.opponentMctsIterations ?? DEFAULT_OPPONENT_MCTS_ITER,
  };
  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;

  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    return decideSmart(state, playerId, baseSeed);
  }

  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (!isGiftPlacementActor && state.currentPlayerIndex !== playerId) return null;

  const actions = enumerateOwnActions(state, playerId);
  if (actions.length === 0) return null;
  if (actions.length === 1) return actions[0];

  const deadline = Date.now() + opts.timeBudgetMs;

  // root 手の順序を即時評価で初期化（最初の浅い反復が終わる前に打ち切られても返せるよう、
  // quick score 順の先頭を暫定 best とする）。
  const rootScored = actions.map((a) => ({ a, s: quickChildScore(state, a, playerId, opts) }));
  rootScored.sort((x, y) => y.s - x.s);
  let bestAction: Action = rootScored[0].a;

  // 反復深化: 浅い深さから順に。 各深さで完走したら best を更新。 期限超過で打ち切り。
  for (let depth = opts.minPlaceDepth; depth <= opts.maxPlaceDepth; depth++) {
    const ctx: SearchContext = {
      me: playerId,
      opts,
      deadline,
      tt: new Map(),
      leafCounter: 0,
      timedOut: false,
      timeCheckMask:
        opts.lookaheadTurns > 0 ? TIME_CHECK_MASK_EXPENSIVE : TIME_CHECK_MASK_CHEAP,
      pure: false,
    };
    let depthBestAction: Action = bestAction;
    let depthBestValue = -Infinity;
    let alpha = -Infinity;
    let completed = true;

    // 前反復の best を先頭に持ってきて αβ の刈りを効かせる（move ordering の核）。
    const orderedRoot = rootScored.map((x) => x.a);
    const bi = orderedRoot.indexOf(bestAction);
    if (bi > 0) {
      orderedRoot.splice(bi, 1);
      orderedRoot.unshift(bestAction);
    }

    try {
      for (const action of orderedRoot) {
        const v = evalAction(
          state,
          action,
          0,
          depth,
          baseSeed,
          0,
          alpha,
          Infinity,
          ctx
        );
        if (v > depthBestValue) {
          depthBestValue = v;
          depthBestAction = action;
        }
        if (depthBestValue > alpha) alpha = depthBestValue;
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        completed = false;
      } else {
        throw e;
      }
    }

    if (completed && depthBestValue > -Infinity) {
      bestAction = depthBestAction;
    }
    if (!completed || Date.now() >= deadline) break;
  }

  return bestAction;
}
