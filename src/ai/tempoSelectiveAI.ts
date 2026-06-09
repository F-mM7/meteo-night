/**
 * 【結果 (Gen-11, 2026-06-09)】vs tempoFast LA=1 @budget1000 で 18.8% (CI 11.1-30.0%) = parity
 * （点推定<25% でやや劣勢）。採用せず・browser 非配線。width を絞っても LA=2 は LA=1 を超えず、
 * horizon の sweet-spot は LA=1 のままと再確認。詳細は ai/CHANGELOG.md の Gen-11。
 *
 * tempoSelectiveAI ― tempoFastAI の探索エンジンをそのまま流用しつつ、
 * 多ターン先読み（lookahead=2）を「全 root 手」ではなく「Pass1 で有望と判った上位 K 手」だけに
 * 適用する選択的深化（selective deepening）の検証 AI。
 *
 * 背景（既知の dead-end の回避）:
 *   全幅 lookahead=2 はテスト済みで悪化する（budget1000 で 20%、budget2500 で 14.6%。公平基準 25%）。
 *   原因は「時間予算内で枝を広げ過ぎて各枝が浅くなり、相手モデル誤差 + 観測不能ドローの分散が累積する」こと。
 *   本 AI はこの失敗（広げ過ぎ）を構造的に回避する: root の分岐のうち有望な少数だけを深く読み、
 *   残りは安価な lookahead=1 の値のまま据え置く。深い読みに使う計算量を root の有望手に集中させる。
 *
 * アルゴリズム = root の 2 パス探索:
 *   Pass 1（安価・全幅）:
 *     全 root 手を lookaheadTurns=pass1Lookahead（既定 1）で評価し、値で降順に順位付けする。
 *     反復深化 + 壁時計バジェット + αβ + Transposition Table は tempoFast と同一。
 *     各 root 手の「その手単独の値」を保持する（αβ の root では枝刈りしない＝全手の exact 値を得る）。
 *   Pass 2（高価・選択的）:
 *     Pass1 上位 topK 手だけを lookaheadTurns=pass2Lookahead（既定 2）で再評価する。
 *     Pass2 で得た（より深い）値が大きい手を最終手として返す。topK 圏外の手は Pass1 値のまま
 *     比較に残す（Pass2 の最良が Pass1 の topK 圏外 best を下回ることは設計上ほぼ無いが、健全性のため
 *     全手を「Pass2 で見た手は Pass2 値、見ていない手は Pass1 値」として横断比較する）。
 *
 * 時間予算（必須）:
 *   decideAction 全体で 1 つの deadline（now + timeBudgetMs）を持つ。Pass1 と Pass2 はこの同一 deadline を
 *   共有する。Pass2 が deadline に間に合わなければ（途中で打ち切られれば）、その時点で確定している
 *   「Pass1 best ＋ Pass2 で完走した分の最良」を返す（フォールバック）。budget を超過しない。
 *
 * 探索の中身（leafValue / searchTurn / evalAction / advanceToMyTurn / TT / 反復深化）は tempoFastAI から
 * コピーして流用している。lookaheadTurns を ctx.opts 経由で参照するため、パスごとに opts.lookaheadTurns を
 * 差し替えるだけで「Pass1=1 / Pass2=2」のような使い分けができる。
 *
 * インターフェース: 他 AI と同一の Decider 互換
 *   decideAction(state, playerId, seed?, options?): Action | null
 *
 * 注意: 既存ファイル（tempoFastAI.ts / evaluator.ts / index.ts 等の共有ファイル）は一切変更しない
 * （本ファイルは追加のみ）。
 */
import type { Action, Color, GameState, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { evaluateState, type EvalWeights } from './evaluator';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { decideAction as decideMcts } from './mctsAI';
import { observationKey } from './infoSet';

export type OpponentModel = 'smart' | 'mcts' | 'tempo';

export interface TempoSelectiveOptions {
  /** leaf 評価の重み。省略時は evaluator のモジュール global（DEFAULT_WEIGHTS）を使う。 */
  weights?: EvalWeights;
  /** 複数色チェイン準備度への加点係数（tempoFast と同一の意味・既定値）。 */
  tempoChainW?: number;
  /** Pass1（全 root 手の順位付け）の先読みターン数。既定 1（安価側）。0 で own-turn 完全読みのみ。 */
  pass1Lookahead?: number;
  /** Pass2（上位 topK 手の深掘り）の先読みターン数。既定 2（選択的深化の本体）。 */
  pass2Lookahead?: number;
  /** Pass2 で深掘りする root 手の本数（Pass1 上位から）。既定 3。 */
  topK?: number;
  /** ターン最初の山札ドロー（先頭 2 枚が不明）の期待値サンプル数。 */
  rootDrawSamples?: number;
  /** 連鎖中の追加ドロー（先頭 1 枚が不明）の期待値サンプル数。ネストするので小さめ。 */
  chainDrawSamples?: number;
  /** 反復深化で到達しうる最大の配置深さ（安全弁）。 */
  maxPlaceDepth?: number;
  /** 反復深化の開始深さ。 */
  minPlaceDepth?: number;
  /** 1 手あたりの壁時計タイムバジェット（ms）。超過すると best-so-far を返す。Pass1+Pass2 で共有。 */
  timeBudgetMs?: number;
  /** lookahead>0 のとき相手手番を進めるモデル。'smart'（既定・tempoFast 互換）/ 'mcts' / 'tempo'。 */
  opponentModel?: OpponentModel;
  /** opponentModel='mcts' のときの探索 iteration（軽量化のため既定を小さめにする）。 */
  opponentMctsIterations?: number;
  /**
   * Pass1 に割り当てる時間予算の割合（0〜1）。残りが Pass2 に回る。
   * Pass1 を全幅で確実に完走させ、Pass2（深掘り）に十分な残時間を残すための配分。既定 0.5。
   */
  pass1BudgetFraction?: number;
}

const DEFAULT_TEMPO_CHAIN_W = 50;
const DEFAULT_PASS1_LOOKAHEAD = 1;
const DEFAULT_PASS2_LOOKAHEAD = 2;
const DEFAULT_TOP_K = 3;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
const DEFAULT_MIN_PLACE_DEPTH = 2;
const DEFAULT_TIME_BUDGET_MS = 1000;
const DEFAULT_OPPONENT_MODEL: OpponentModel = 'smart';
const DEFAULT_OPPONENT_MCTS_ITER = 120;
const DEFAULT_PASS1_BUDGET_FRACTION = 0.5;
/** 相手のチェイン準備度を脅威として割り引く係数（tempoFast と同一）。 */
const OPP_CHAIN_FACTOR = 0.5;
/** 先読みで相手の手番を進める際の無限ループ安全弁。 */
const ADVANCE_MAX_STEPS = 400;
/**
 * Date.now() 呼び出しコストを抑えるため、leaf 評価 N 回ごとにのみ期限を確認する。
 *   - lookahead=0: 1 leaf が安価（静的評価のみ）なので 1024 ごとでよい。
 *   - lookahead>0: 1 leaf で advanceToMyTurn（相手モデルを数手）が走り高価なので 16 ごとに細かく確認する。
 */
const TIME_CHECK_MASK_CHEAP = 0x3ff; // 1024 leaf ごと
const TIME_CHECK_MASK_EXPENSIVE = 0xf; // 16 leaf ごと

interface ResolvedOptions {
  weights: EvalWeights | undefined;
  tempoChainW: number;
  pass1Lookahead: number;
  pass2Lookahead: number;
  topK: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
  minPlaceDepth: number;
  timeBudgetMs: number;
  opponentModel: OpponentModel;
  opponentMctsIterations: number;
  pass1BudgetFraction: number;
}

/** 期限超過を反復深化ループまで伝播させるためのセンチネル。 */
class BudgetExceeded extends Error {}

/**
 * 探索 1 回分（1 深さ）の共有コンテキスト。TT・期限・leaf カウンタを束ねる。
 * lookaheadTurns はこのコンテキストが持つ（パスごとに差し替える）ので、searchTurn は ctx.lookaheadTurns を見る。
 */
interface SearchContext {
  me: number;
  opts: ResolvedOptions;
  /** このコンテキスト（パス）の先読みターン数。Pass1=pass1Lookahead / Pass2=pass2Lookahead。 */
  lookaheadTurns: number;
  deadline: number;
  /** observationKey(+残り深さ+turnDepth) -> 部分木の値。決定的に到達したノードのみ格納。 */
  tt: Map<string, number>;
  leafCounter: number;
  timedOut: boolean;
  /** 期限確認の間引きマスク（lookahead の有無で粗密を変える）。 */
  timeCheckMask: number;
  /**
   * 直近に評価した部分木が「chance（観測不能ドロー）を一切含まない＝再現可能」だったか。
   * TT への格納は pure な部分木に限定して健全性を保つ（seed 依存の期待値はキャッシュしない）。
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

/** tempoFast と完全に同一の複数色チェイン準備度。 */
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

/** tempoFast と完全に同一の leaf 評価（評価関数は一切変えない）。 */
function leafValue(state: GameState, me: number, opts: ResolvedOptions): number {
  let v = evaluateState(state, me, opts.weights);
  if (opts.tempoChainW !== 0) {
    v += opts.tempoChainW * multiColorChainReadiness(state.players[me]);
    for (const p of state.players) {
      if (p.id === me) continue;
      v -= opts.tempoChainW * OPP_CHAIN_FACTOR * multiColorChainReadiness(p);
    }
  }
  return v;
}

/** 着手順序付け用の「子の即時評価」。placement の決定的遷移先を 1 手だけ評価する（安価）。 */
function quickChildScore(
  state: GameState,
  action: Action,
  me: number,
  opts: ResolvedOptions
): number {
  if (isBlindDraw(action)) {
    return 0; // ドローはサンプリングが要るので順序付けでは中立
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
 * 相手（および自分のギフト受領）の手番を相手モデルで進め、自分の次の手番に戻った状態を返す。
 * tempoFast の advanceToMyTurn と同一（opponentModel 切替対応）。
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
 * αβ 付き「自分の手番完全読み」。actor が自分でなくなる/終局でターン内探索を止め、
 * lookahead 余地があれば相手を進めて次の手番を読む。
 * lookahead の段数は ctx.lookaheadTurns（パスごとに差し替え）を見る。
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
    if (state.currentPlayerIndex !== me && turnDepth < ctx.lookaheadTurns) {
      const advanced = advanceToMyTurn(state, ctx, seed);
      checkDeadlineNow(ctx); // 相手モデルの前進は高コスト。直後に必ず期限を確認する。
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
        ctx.pure = false; // 相手手番を seeded ヒューリスティックで進めたので再現不可
        return v;
      }
      ctx.pure = false;
      return leafValue(advanced, me, ctx.opts);
    }
    ctx.pure = true;
    return leafValue(state, me, ctx.opts);
  }

  // ギフト割り当ては得点不変のため smartAI のヒューリスティックで 1 手だけ進める（tempoFast と同じ）。
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

  // Transposition Table 参照（決定的に到達したノードのみ。残り深さ・turnDepth をキーに含める）。
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
  let subtreePure = true;
  let cut = false;
  for (const action of ordered) {
    const v = evalAction(state, action, placeDepth, maxPlaceDepth, seed, turnDepth, a, beta, ctx);
    if (!ctx.pure) subtreePure = false;
    if (v > best) best = v;
    if (best > a) a = best;
    if (a >= beta) {
      cut = true;
      break; // βカット（max ノードのみ）
    }
  }

  if (subtreePure && !cut && best > -Infinity) ctx.tt.set(ttKey, best);
  ctx.pure = subtreePure;
  return best;
}

/**
 * 1 手の価値。観測不能ドローは expectimax（サンプル平均）、それ以外は決定的遷移。
 * draw の chance ノードは平均値なので β カットはできないが、alpha は子に伝播する。
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
      action.type === 'DRAW_FROM_DECK' ? ctx.opts.rootDrawSamples : ctx.opts.chainDrawSamples;
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
  return searchTurn(next, nextDepth, maxPlaceDepth, seed, turnDepth, alpha, beta, ctx);
}

/**
 * 相手モデル 'tempo' 用の軽量 tempo（lookahead=0, TT/予算/αβ なしの素朴な max）。
 * advanceToMyTurn 内から呼ぶため、ネストして重くなり過ぎないよう浅い固定深さで動かす。
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

  const oppOpts: ResolvedOptions = {
    ...parentOpts,
    rootDrawSamples: 2,
    chainDrawSamples: 1,
    maxPlaceDepth: 6,
  };
  const ctx: SearchContext = {
    me: playerId,
    opts: oppOpts,
    lookaheadTurns: 0,
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

/** root 手 1 つとその評価値（パスをまたいで比較するために保持）。 */
interface RootEntry {
  action: Action;
  /** 直近に評価したパスでの値（Pass2 で更新されうる）。比較はこの値で行う。 */
  value: number;
  /** 順序付けの安定化に使う quickChildScore。 */
  quick: number;
}

/**
 * 1 パスぶんの反復深化で「全 root 手の値」を求める。
 * tempoFast の decideAction の反復深化を踏襲しつつ、root では αβ で枝刈りせず（root の各手に
 * beta=+∞ を渡す）全手の exact 値を得る。Pass1 はこれで全手を順位付けし、Pass2 は上位手の集合に
 * 対して呼んで深い値で上書きする。
 *
 * deadline を超えた反復はその場で破棄し、直前に完走した深さの値（entries に保持）を確定値とする。
 * 少なくとも 1 深さも完走しなかった場合でも、各 entry には呼び出し前の値（Pass1 なら quick 順の暫定、
 * Pass2 なら Pass1 値）が入っているので、フォールバックとして機能する。
 *
 * @param entries 評価対象の root 手（この配列の各 value を in-place で更新する）。
 * @param lookaheadTurns このパスの先読み段数。
 * @param deadline 共有 deadline（Pass1+Pass2 通算）。
 * @returns 何らかの深さを完走できたか（true なら entries.value は探索値で更新済み）。
 */
function runPass(
  state: GameState,
  me: number,
  baseSeed: number,
  opts: ResolvedOptions,
  entries: RootEntry[],
  lookaheadTurns: number,
  deadline: number
): boolean {
  let anyDepthCompleted = false;

  for (let depth = opts.minPlaceDepth; depth <= opts.maxPlaceDepth; depth++) {
    const ctx: SearchContext = {
      me,
      opts,
      lookaheadTurns,
      deadline,
      tt: new Map(),
      leafCounter: 0,
      timedOut: false,
      timeCheckMask: lookaheadTurns > 0 ? TIME_CHECK_MASK_EXPENSIVE : TIME_CHECK_MASK_CHEAP,
      pure: false,
    };

    // 前反復の値で降順ソートしてから評価する（move ordering）。root では αβ を効かせず全手を読むが、
    // 良い手を先に評価しておくと各手の探索内部 αβ が安定する。
    entries.sort((x, y) => y.value - x.value);

    const depthValues = new Array<number>(entries.length);
    let completed = true;
    try {
      for (let i = 0; i < entries.length; i++) {
        // root の各手は独立に full window（beta=+∞）で読む＝枝刈りせず exact 値を得る。
        const v = evalAction(
          state,
          entries[i].action,
          0,
          depth,
          baseSeed,
          0,
          -Infinity,
          Infinity,
          ctx
        );
        depthValues[i] = v;
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        completed = false;
      } else {
        throw e;
      }
    }

    if (completed) {
      for (let i = 0; i < entries.length; i++) entries[i].value = depthValues[i];
      anyDepthCompleted = true;
    }
    if (!completed || Date.now() >= deadline) break;
  }

  return anyDepthCompleted;
}

/**
 * tempoSelectiveAI の行動決定（Decider 互換）。
 *
 * Pass1: 全 root 手を pass1Lookahead で反復深化評価し、降順に並べる（共有 deadline の pass1 配分まで）。
 * Pass2: Pass1 上位 topK 手だけを pass2Lookahead で再評価し、Pass2 値で上書き（残り deadline まで）。
 * 最終: 全 root 手を「Pass2 で見た手は Pass2 値、未見手は Pass1 値」として横断比較し、最良手を返す。
 * Pass2 が一切完走しなくても Pass1 best が確実に返る（フォールバック）。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoSelectiveOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights,
    tempoChainW: options.tempoChainW ?? DEFAULT_TEMPO_CHAIN_W,
    pass1Lookahead: options.pass1Lookahead ?? DEFAULT_PASS1_LOOKAHEAD,
    pass2Lookahead: options.pass2Lookahead ?? DEFAULT_PASS2_LOOKAHEAD,
    topK: options.topK ?? DEFAULT_TOP_K,
    rootDrawSamples: options.rootDrawSamples ?? DEFAULT_ROOT_DRAW_SAMPLES,
    chainDrawSamples: options.chainDrawSamples ?? DEFAULT_CHAIN_DRAW_SAMPLES,
    maxPlaceDepth: options.maxPlaceDepth ?? DEFAULT_MAX_PLACE_DEPTH,
    minPlaceDepth: options.minPlaceDepth ?? DEFAULT_MIN_PLACE_DEPTH,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    opponentModel: options.opponentModel ?? DEFAULT_OPPONENT_MODEL,
    opponentMctsIterations: options.opponentMctsIterations ?? DEFAULT_OPPONENT_MCTS_ITER,
    pass1BudgetFraction: options.pass1BudgetFraction ?? DEFAULT_PASS1_BUDGET_FRACTION,
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

  const startTime = Date.now();
  const deadline = startTime + opts.timeBudgetMs;
  // Pass1 の中間 deadline（共有予算の一部）。Pass1 を確実に終わらせ Pass2 に残時間を残すための配分。
  const frac = Math.min(1, Math.max(0, opts.pass1BudgetFraction));
  const pass1Deadline = Math.min(deadline, startTime + opts.timeBudgetMs * frac);

  // 全 root 手の entry を quickChildScore で初期化（最初の反復前に打ち切られても返せる暫定値）。
  const entries: RootEntry[] = actions.map((a) => {
    const q = quickChildScore(state, a, playerId, opts);
    return { action: a, value: q, quick: q };
  });

  // --- Pass 1: 全 root 手を pass1Lookahead で評価し順位付け（pass1Deadline まで） ---
  runPass(state, playerId, baseSeed, opts, entries, opts.pass1Lookahead, pass1Deadline);

  // Pass1 の値で降順整列。先頭が Pass1 best（フォールバックの基準）。
  entries.sort((x, y) => y.value - x.value);
  let bestEntry = entries[0];

  // --- Pass 2: 上位 topK だけを pass2Lookahead で深掘り（残り deadline まで） ---
  // Pass2 が浅くするだけ（pass2 < pass1）の構成や topK が全手以上の構成でも安全に動く。
  const k = Math.min(opts.topK, entries.length);
  const needPass2 = opts.pass2Lookahead !== opts.pass1Lookahead && k >= 1 && Date.now() < deadline;
  if (needPass2) {
    const topEntries = entries.slice(0, k);
    // Pass2 は entries の value を pass2 の値で上書きする。完走しなければ Pass1 値のまま残る（フォールバック）。
    runPass(state, playerId, baseSeed, opts, topEntries, opts.pass2Lookahead, deadline);
    // topEntries は entries と同じ参照オブジェクトを共有しているので value は更新済み。
    // 全 entry（Pass2 で見た上位手は Pass2 値、未見手は Pass1 値）から最良を取り直す。
    bestEntry = entries[0];
    for (const e of entries) {
      if (e.value > bestEntry.value) bestEntry = e;
    }
  }

  return bestEntry.action;
}
