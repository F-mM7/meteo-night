/**
 * adaptiveBurstAI ― 「後半爆発タイミング」戦略の検証 AI。
 *
 * 仮説（人間棋譜分析で唯一未検証の角度）:
 *   人間は最強 CPU(tempoFast) に約 63% 勝つ。その正体は「序盤を犠牲にせず、盤面が育った後半に
 *   5→20 点を一気に爆発させる」ことと判明した（人間は 5 点到達は AI より遅い 29 vs 25 ターンだが、
 *   20 点到達は速い 29 vs 32 ターン）。このゲームは誰かが 20 点に達した最終ラウンドで即終了するため、
 *   後半に先に 20 点へ到達した者が勝つ。
 *
 * 先行検証で「序盤から大コンボを仕込む」型（cascadeAI: 発火プレイアウト主軸）は対 tempoFast で
 *   勝率 4.9% と惨敗した。原因は「序盤から大コンボを仕込むと立ち上がりが遅く、20 点レースで横並べ型に
 *   競り負ける」。静的な評価重み調整（reach 増 / cascade 特徴 / pendingMult 増を**常時**有効化）も全て
 *   parity だった。
 *
 * 本 AI の角度（未検証）= 局面適応:
 *   葉（ターン終了局面）の評価重みを「局面が後半か」で切り替える。
 *     - 序盤（盤面が浅い / 場の最高スコアが閾値未満）: `weights`（既定 = DEFAULT_WEIGHTS）。
 *       これは tempoFast の葉評価と**完全に同一**であり、序盤は現状最強と同じ速さで得点する
 *       （cascadeAI の轍＝立ち上がりの遅さを構造的に回避する）。
 *     - 後半（場の最高スコアが終了閾値 20 に近い / 自盤面が育った / ターンが進んだ）: `lateWeights`。
 *       reach4-5・縦積みカスケード(cascade2/3)・当ターンのコンボ総得点(pendingMult) を増強し、
 *       大コンボ・連鎖を重視して「爆発で先に 20 点へ到達する」手順を選ばせる。
 *   切り替えは**決定（手番）単位で 1 回**判定し、その手番のターン内探索の全葉で同じ重みを使う
 *   （局面ごとに揺れない一貫した regime）。閾値と後半重みは options で調整可能。
 *
 * 探索（tempoAI / cascadeAI と同じ own-turn full search。lookahead は持たない）:
 *   - 2 枚の配置順・配置先、連鎖ごとの「引く/捨てる」、連鎖シーケンスを DFS で完全展開し、
 *     ターン終了時（actor が自分でなくなる / 終局）の葉評価を最大化。
 *   - 観測不能ドロー（山札先頭）は山札シャッフルの複数サンプル期待値（expectimax）で近似（フェア）。
 *   - 反復深化 + 壁時計バジェット + αβ（max ノードのみ）+ Transposition Table で計算量を抑える。
 *   - cascadeAI の発火プレイアウト（boardFirePotential）は**意図的に使わない**: 葉ごとに重い playout を
 *     走らせると探索が浅くなり（cascadeAI の遅さの元凶）、かつ chainRush/cascade に続く 3 箇所目の
 *     重複になる。後半の「大コンボ重視」は既存 evaluateState の reach/cascade/pending 項を後半だけ
 *     増強する安価な重み切替で表現する。
 *
 * インターフェース: 他 AI と同一の Decider 互換
 *   decideAction(state, playerId, seed?, options?): Action | null
 *
 * 注意: 既存 AI（tempoFastAI.ts / tempoAI.ts / evaluator.ts の既存ロジック）は一切変更しない。
 */
import type { Action, Color, GameState, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { END_SCORE_THRESHOLD } from '../game/engine';
import { evaluateState, DEFAULT_WEIGHTS, type EvalWeights } from './evaluator';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { observationKey } from './infoSet';

export interface AdaptiveBurstOptions {
  /** 序盤（非 burst）の葉評価の重み。省略時は DEFAULT_WEIGHTS（= tempoFast の葉と同一）。 */
  weights?: EvalWeights;
  /** 後半（burst）の葉評価の重み。省略時は DEFAULT_LATE_WEIGHTS（大コンボ重視に増強）。 */
  lateWeights?: EvalWeights;
  /** 複数色チェイン準備度への加点係数（tempoAI / tempoFast と同一の意味・既定値）。 */
  tempoChainW?: number;
  /**
   * burst（後半）判定: いずれかの席の score がこの値以上で burst モードに入る。
   * 終了閾値 20 に近いほど「20 点レースが始まった＝爆発で先着すべき」。既定 12。
   */
  burstScoreThreshold?: number;
  /** burst 判定: 自分の盤面の総カード数がこの値以上で burst（盤面が育った）。既定 Infinity（無効）。 */
  burstFillThreshold?: number;
  /** burst 判定: turnNumber がこの値以上で burst。既定 Infinity（無効）。 */
  burstTurnThreshold?: number;
  /** ターン最初の山札ドロー（先頭 2 枚が不明）の期待値サンプル数。 */
  rootDrawSamples?: number;
  /** 連鎖中の追加ドロー（先頭 1 枚が不明）の期待値サンプル数。ネストするので小さめ。 */
  chainDrawSamples?: number;
  /** 反復深化で到達しうる最大の配置深さ（安全弁）。 */
  maxPlaceDepth?: number;
  /** 反復深化の開始深さ。 */
  minPlaceDepth?: number;
  /** 1 手あたりの壁時計タイムバジェット（ms）。超過すると best-so-far を返す。 */
  timeBudgetMs?: number;
}

const DEFAULT_TEMPO_CHAIN_W = 50;
// 終了閾値（20 点）まで残り 8 点で後半開始とする＝誰かが 12 点に到達したら 20 点レースが始まる。
const DEFAULT_BURST_SCORE_THRESHOLD = END_SCORE_THRESHOLD - 8;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
const DEFAULT_MIN_PLACE_DEPTH = 2;
const DEFAULT_TIME_BUDGET_MS = 1000;
/** 相手のチェイン準備度を脅威として割り引く係数（tempoAI / tempoFast と同一）。 */
const OPP_CHAIN_FACTOR = 0.5;
/** Date.now() 呼び出しコストを抑えるため、leaf 評価 N 回ごとにのみ期限を確認する。 */
const TIME_CHECK_MASK = 0x3ff; // 1024 leaf ごと

/**
 * 後半（burst）モードの既定重み。序盤の DEFAULT_WEIGHTS をベースに、大コンボ・連鎖・当ターン総得点を
 * 増強する。「序盤を犠牲にせず後半に爆発」させるため、これらの増強は burst 判定が立った手番でのみ効く。
 *   - reach5plus / reach4: 横並べ大コンボ（size5=10 点 / size4=3 点）への近さを高く評価。
 *   - reach3: 軽め（小コンボに飛びつかせない）。
 *   - chainSeed / cascade2 / cascade3plus: 縦積み（上下同色 / 2 層目の同色並び）で連鎖カスケードの仕込み。
 *   - pendingMult: 当ターンに実際に積み上げたコンボ総得点（一気に爆発させる手順）を高く評価。
 */
export const DEFAULT_LATE_WEIGHTS: EvalWeights = {
  ...DEFAULT_WEIGHTS,
  reach5plus: DEFAULT_WEIGHTS.reach5plus * 2, // ~445
  reach4: DEFAULT_WEIGHTS.reach4 * 2, // ~180
  reach3: DEFAULT_WEIGHTS.reach3 * 1.5, // ~87
  chainSeed: DEFAULT_WEIGHTS.chainSeed * 3, // ~28
  pendingMult: DEFAULT_WEIGHTS.pendingMult * 2, // ~213
  cascade2: 60,
  cascade3plus: 200,
};

interface ResolvedOptions {
  weights: EvalWeights;
  lateWeights: EvalWeights;
  tempoChainW: number;
  burstScoreThreshold: number;
  burstFillThreshold: number;
  burstTurnThreshold: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
  minPlaceDepth: number;
  timeBudgetMs: number;
}

/** 期限超過を反復深化ループまで伝播させるためのセンチネル。 */
class BudgetExceeded extends Error {}

interface SearchContext {
  me: number;
  opts: ResolvedOptions;
  deadline: number;
  /** この決定（手番）で burst（後半）モードか。root 局面で 1 回判定して固定する。 */
  burst: boolean;
  /** observationKey(+残り深さ) -> pure な部分木の値。 */
  tt: Map<string, number>;
  leafCounter: number;
  timedOut: boolean;
  /** 直近に評価した部分木が観測不能ドローを一切含まない（再現可能）か。TT 格納の健全性判定用。 */
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

/** tempoAI / tempoFast と完全に同一の複数色チェイン準備度。 */
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

/** 盤面の総カード数（burst の「盤面が育った」判定用）。 */
function totalCardsOnBoard(player: Player): number {
  let n = 0;
  for (const slot of player.board.slots) n += slot.stack.length;
  return n;
}

/**
 * この局面が burst（後半）モードかを判定する。決定（手番）単位で root 局面に対して 1 回呼び、
 * その手番の探索全体で固定して使う。
 *   - いずれかの席が burstScoreThreshold 以上（誰かが終了閾値 20 に近い＝レース開始）
 *   - 自分の盤面が burstFillThreshold 以上に育った
 *   - turnNumber が burstTurnThreshold 以上
 * のいずれかで burst。
 */
function isBurstPhase(state: GameState, me: number, opts: ResolvedOptions): boolean {
  let maxScore = 0;
  for (const p of state.players) if (p.score > maxScore) maxScore = p.score;
  if (maxScore >= opts.burstScoreThreshold) return true;
  if (totalCardsOnBoard(state.players[me]) >= opts.burstFillThreshold) return true;
  if (state.turnNumber >= opts.burstTurnThreshold) return true;
  return false;
}

/**
 * ターン終了局面（または探索打ち切り）の自分視点の価値。
 *
 * 序盤（非 burst）は `weights`（既定 DEFAULT_WEIGHTS）で評価し、tempoFast の葉と完全に一致する。
 * 後半（burst）は `lateWeights` に切り替え、reach4-5・cascade・pending を増強して大コンボ・連鎖を重視する。
 * burst 判定は ctx.burst に固定済み（決定単位で 1 回）。
 *
 * チェイン準備度項（multiColorChainReadiness）は tempoFast と同一に常時加える（早晩問わずテンポの軸）。
 */
function leafValue(state: GameState, ctx: SearchContext): number {
  const me = ctx.me;
  const opts = ctx.opts;
  const w = ctx.burst ? opts.lateWeights : opts.weights;
  let v = evaluateState(state, me, w);
  if (opts.tempoChainW !== 0) {
    v += opts.tempoChainW * multiColorChainReadiness(state.players[me]);
    for (const p of state.players) {
      if (p.id === me) continue;
      v -= opts.tempoChainW * OPP_CHAIN_FACTOR * multiColorChainReadiness(p);
    }
  }
  return v;
}

/** 着手順序付け用の安価な「子の即時評価」。placement の決定的遷移先を 1 手だけ静的 leaf 評価する。 */
function quickChildScore(state: GameState, action: Action, ctx: SearchContext): number {
  if (isBlindDraw(action)) return 0; // ドローはサンプリングが要るので順序付けでは中立
  const next = stepGame(state, action);
  if (next === state) return -Infinity;
  return leafValue(next, ctx);
}

/**
 * αβ 付き「自分の手番完全読み」。actor が自分でなくなる / 終局でターン内探索を止め、葉評価を返す。
 * own-turn のみ（多ターン先読みはしない）。alpha/beta は max レイヤのみで有効。
 */
function searchTurn(
  state: GameState,
  placeDepth: number,
  maxPlaceDepth: number,
  seed: number,
  alpha: number,
  beta: number,
  ctx: SearchContext
): number {
  if (((ctx.leafCounter++ & TIME_CHECK_MASK) === 0) && Date.now() >= ctx.deadline) {
    ctx.timedOut = true;
    throw new BudgetExceeded();
  }

  if (state.phase === 'gameOver') {
    ctx.pure = true;
    return leafValue(state, ctx);
  }

  const me = ctx.me;
  const actor = currentActorId(state);
  if (actor !== me) {
    // 自分のターンが完全に終わった（相手の手番）。own-turn のみなのでここで葉評価。
    ctx.pure = true;
    return leafValue(state, ctx);
  }

  // ギフト割り当ては得点不変のため smartAI のヒューリスティックで 1 手だけ進める（tempo 系と同じ）。
  if (state.phase === 'awaitingGiftSelection') {
    const a = decideSmart(state, me, seed);
    if (!a) {
      ctx.pure = true;
      return leafValue(state, ctx);
    }
    const next = stepGame(state, a);
    if (next === state) {
      ctx.pure = true;
      return leafValue(state, ctx);
    }
    const v = searchTurn(next, placeDepth, maxPlaceDepth, seed, alpha, beta, ctx);
    ctx.pure = false; // gift 割り当ては seeded ヒューリスティック
    return v;
  }

  // 反復深化の深さ上限に達したら静的評価で打ち切る。
  if (placeDepth >= maxPlaceDepth) {
    ctx.pure = true;
    return leafValue(state, ctx);
  }

  // Transposition Table 参照（決定的に到達した pure ノードのみ）。
  const remaining = maxPlaceDepth - placeDepth;
  const ttKey = observationKey(state, me) + '|r:' + remaining;
  const cached = ctx.tt.get(ttKey);
  if (cached !== undefined) {
    ctx.pure = true;
    return cached;
  }

  const actions = enumerateOwnActions(state, me);
  if (actions.length === 0) {
    const lv = leafValue(state, ctx);
    ctx.tt.set(ttKey, lv);
    ctx.pure = true;
    return lv;
  }

  // 着手順序付け: 子の即時 leaf 評価で降順ソート（αβ の枝刈り効率を上げる）。
  let ordered: Action[];
  if (actions.length > 1) {
    const scored = actions.map((a) => ({ a, s: quickChildScore(state, a, ctx) }));
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
    const v = evalAction(state, action, placeDepth, maxPlaceDepth, seed, a, beta, ctx);
    if (!ctx.pure) subtreePure = false;
    if (v > best) best = v;
    if (best > a) a = best;
    if (a >= beta) {
      cut = true;
      break;
    }
  }

  if (subtreePure && !cut && best > -Infinity) ctx.tt.set(ttKey, best);
  ctx.pure = subtreePure;
  return best;
}

/**
 * 1 手の価値。観測不能ドローは expectimax（サンプル平均）、それ以外は決定的遷移。
 * draw の chance ノードは平均値なので β カットはできない（alpha/beta を ±∞ で子に渡す）。
 */
function evalAction(
  state: GameState,
  action: Action,
  placeDepth: number,
  maxPlaceDepth: number,
  seed: number,
  alpha: number,
  beta: number,
  ctx: SearchContext
): number {
  if (isBlindDraw(action)) {
    const samples =
      action.type === 'DRAW_FROM_DECK' ? ctx.opts.rootDrawSamples : ctx.opts.chainDrawSamples;
    let total = 0;
    let count = 0;
    for (let i = 0; i < samples; i++) {
      const rand = mulberry32((seed + Math.imul(i + 1, 0x9e3779b1)) | 0);
      const shuffled = shuffle(state.deck, rand);
      const sampledState: GameState = { ...state, deck: shuffled };
      const next = stepGame(sampledState, action);
      if (next === sampledState) continue;
      const childSeed = (seed ^ Math.imul(i + 1, 0x85ebca6b)) | 0;
      total += searchTurn(next, placeDepth + 1, maxPlaceDepth, childSeed, -Infinity, Infinity, ctx);
      count++;
    }
    ctx.pure = false; // 観測不能ドローの期待値は seed 依存なので再現不可
    return count > 0 ? total / count : leafValue(state, ctx);
  }

  const next = stepGame(state, action);
  if (next === state) {
    ctx.pure = true;
    return -Infinity;
  }
  const nextDepth = isPlacement(action) ? placeDepth + 1 : placeDepth;
  return searchTurn(next, nextDepth, maxPlaceDepth, seed, alpha, beta, ctx);
}

/**
 * adaptiveBurstAI の行動決定（Decider 互換）。
 * 反復深化 + 壁時計バジェット: minPlaceDepth から maxPlaceDepth まで段階的に深くし、
 * 期限超過でその反復を破棄して直前完走深さの best-so-far root 手を返す。
 *
 * burst（後半）判定は root 局面に対して 1 回だけ行い、その手番の探索全体で固定する。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: AdaptiveBurstOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights ?? DEFAULT_WEIGHTS,
    lateWeights: options.lateWeights ?? DEFAULT_LATE_WEIGHTS,
    tempoChainW: options.tempoChainW ?? DEFAULT_TEMPO_CHAIN_W,
    burstScoreThreshold: options.burstScoreThreshold ?? DEFAULT_BURST_SCORE_THRESHOLD,
    burstFillThreshold: options.burstFillThreshold ?? Infinity,
    burstTurnThreshold: options.burstTurnThreshold ?? Infinity,
    rootDrawSamples: options.rootDrawSamples ?? DEFAULT_ROOT_DRAW_SAMPLES,
    chainDrawSamples: options.chainDrawSamples ?? DEFAULT_CHAIN_DRAW_SAMPLES,
    maxPlaceDepth: options.maxPlaceDepth ?? DEFAULT_MAX_PLACE_DEPTH,
    minPlaceDepth: options.minPlaceDepth ?? DEFAULT_MIN_PLACE_DEPTH,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
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
  // この手番が後半（burst）かを root 局面で 1 回判定し、探索全体で固定する。
  const burst = isBurstPhase(state, playerId, opts);

  // root 手の順序を即時評価で初期化（最初の浅い反復前に打ち切られても返せるよう暫定 best を置く）。
  const orderCtx: SearchContext = {
    me: playerId,
    opts,
    deadline: Infinity,
    burst,
    tt: new Map(),
    leafCounter: 0,
    timedOut: false,
    pure: false,
  };
  const rootScored = actions.map((a) => ({ a, s: quickChildScore(state, a, orderCtx) }));
  rootScored.sort((x, y) => y.s - x.s);
  let bestAction: Action = rootScored[0].a;

  for (let depth = opts.minPlaceDepth; depth <= opts.maxPlaceDepth; depth++) {
    const ctx: SearchContext = {
      me: playerId,
      opts,
      deadline,
      burst,
      tt: new Map(),
      leafCounter: 0,
      timedOut: false,
      pure: false,
    };
    let depthBestAction: Action = bestAction;
    let depthBestValue = -Infinity;
    let alpha = -Infinity;
    let completed = true;

    // 前反復の best を先頭に持ってきて αβ の刈りを効かせる。
    const orderedRoot = rootScored.map((x) => x.a);
    const bi = orderedRoot.indexOf(bestAction);
    if (bi > 0) {
      orderedRoot.splice(bi, 1);
      orderedRoot.unshift(bestAction);
    }

    try {
      for (const action of orderedRoot) {
        const v = evalAction(state, action, 0, depth, baseSeed, alpha, Infinity, ctx);
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
