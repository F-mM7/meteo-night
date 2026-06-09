/**
 * 【結果 (Gen-11, 2026-06-09)】vs tempoFast LA=1 @budget1000 で 28.1% (CI 18.6-40.1%) = parity。
 * 採用せず・browser 非配線。手の識別を鋭くしても勝率は動かない（律速は手比較ノイズでなく
 * 自己対戦の勝敗そのものの予測不能性）。詳細は ai/CHANGELOG.md の Gen-11。
 *
 * tempoCrnAI ― tempoFastAI（現状最強）と探索・評価を完全に同一に保ちつつ、
 * 盲ドロー（観測不能ドロー）の expectimax サンプリングにのみ
 * 共通乱数（Common Random Numbers, CRN）による分散削減を適用した変種。
 *
 * ■ tempoFast との唯一の差分
 *   expectimax のドローノードで山札をシャッフルする際の seed 導出だけが異なる。
 *
 *   - tempoFast: シャッフル seed を「手の累積 seed」（root から枝を下るたびに
 *     置換・更新される seed）から導出していた。このため、root の兄弟候補手 A と B が
 *     同じ探索深さのドロー局面に到達しても、そこまでの配置経路が違えば seed が異なり、
 *     A と B は「別々の偶然の山札の並び」で評価される。これが手の比較に分散ノイズを乗せ、
 *     同じサンプル数でも手の差の識別を鈍らせる。
 *
 *   - tempoCrn: シャッフル seed を「探索文脈」＝(decideAction ごとに 1 回固定する salt,
 *     placeDepth, turnDepth, サンプル index) だけから導出する。手の系列（どの配置を
 *     経由したか）には一切依存させない。こうすると「ある探索深さ・ターン深さでの
 *     k 番目の山札の並び」は兄弟手で完全に同一になる。手 A と手 B の差は
 *     “同じ未来” の上で推定されるので、相関ノイズが相殺され、識別が鋭くなる
 *     （= Common Random Numbers による分散削減）。
 *
 * ■ 公平性（バイアスを入れない）
 *   CRN は依然として state.deck を正しい Fisher-Yates でシャッフルした実現からの
 *   サンプリングである。兄弟間で「同じ実現を共有する」だけで、サンプリング分布自体は
 *   変えていない。salt は決定単位ごとに（呼び出しごとに）異なるので、決定をまたいで
 *   特定の山札並びに偏ることもない。
 *
 * ■ TT（置換表）の健全性
 *   盲ドローを含む部分木を pure 扱いしない既存ロジック（ctx.pure=false）はそのまま維持する。
 *   CRN にしてもドロー期待値は salt（決定単位の固定値）に依存するため、決定をまたいで
 *   キャッシュできない事実は変わらない。よって tempoFast と同じく「pure な部分木のみ
 *   TT 格納」「salt/seed 依存の期待値は格納しない」方針を保つ。
 *
 * 注意: tempoFastAI.ts / evaluator.ts / index.ts 等の共有ファイルは一切変更しない（本ファイルは追加のみ）。
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

export interface TempoCrnOptions {
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
  /**
   * CRN（共通乱数）を有効にするか。true（既定）で本変種の本質である「兄弟手間で
   * 山札実現を共有」する挙動。false にすると tempoFast と完全に同一の挙動
   * （シャッフル seed を手の累積 seed から導出）に戻る（A/B 比較用のスイッチ）。
   */
  crnEnabled?: boolean;
}

const DEFAULT_TEMPO_CHAIN_W = 50;
const DEFAULT_LOOKAHEAD_TURNS = 1;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
const DEFAULT_TIME_BUDGET_MS = 1000;
const DEFAULT_MIN_PLACE_DEPTH = 2;
const DEFAULT_OPPONENT_MODEL: OpponentModel = 'smart';
const DEFAULT_OPPONENT_MCTS_ITER = 120;
const DEFAULT_CRN_ENABLED = true;
/** 相手のチェイン準備度を脅威として割り引く係数（tempoAI と同一）。 */
const OPP_CHAIN_FACTOR = 0.5;
/** 先読みで相手の手番を進める際の無限ループ安全弁。 */
const ADVANCE_MAX_STEPS = 400;
const TIME_CHECK_MASK_CHEAP = 0x3ff; // 1024 leaf ごと
const TIME_CHECK_MASK_EXPENSIVE = 0xf; // 16 leaf ごと

interface ResolvedOptions {
  weights: EvalWeights | undefined;
  tempoChainW: number;
  lookaheadTurns: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
  timeBudgetMs: number;
  minPlaceDepth: number;
  opponentModel: OpponentModel;
  opponentMctsIterations: number;
  crnEnabled: boolean;
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
   */
  pure: boolean;
  /**
   * CRN 用の決定単位の固定 salt。decideAction で 1 回だけ生成し、探索全体で共有する。
   * これと探索文脈（placeDepth/turnDepth/sample index）だけからシャッフル seed を導出すると、
   * 兄弟手が同じドロー局面で同じ山札実現を共有する（= 共通乱数）。
   */
  crnSalt: number;
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

/**
 * CRN シャッフル seed の導出。手の累積 seed には一切依存せず、決定単位の salt と
 * 探索文脈（placeDepth, turnDepth, sample index, ドロー種別）だけから決まる。
 * これにより「ある探索深さ・ターン深さでの k 番目の山札並び」が兄弟手で一致する。
 * `kind`（0=root ドロー / 1=追加ドロー）も混ぜ、別種ドローの実現が衝突しないようにする。
 */
function crnDrawSeed(
  ctx: SearchContext,
  placeDepth: number,
  turnDepth: number,
  sampleIndex: number,
  kind: number
): number {
  let h = ctx.crnSalt | 0;
  h = (Math.imul(h ^ (placeDepth + 1), 0x9e3779b1)) | 0;
  h = (Math.imul(h ^ (turnDepth + 1), 0x85ebca6b)) | 0;
  h = (Math.imul(h ^ (sampleIndex + 1), 0xc2b2ae35)) | 0;
  h = (Math.imul(h ^ (kind + 1), 0x27d4eb2f)) | 0;
  // 最終撹拌（avalanche）。隣接 index・深さの seed が近接しすぎないようにする。
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h | 0;
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
 * αβ 付き「自分の手番完全読み」。 actor が自分でなくなる/終局でターン内探索を止め、
 * lookahead 余地があれば相手を進めて次の手番を読む。
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
      checkDeadlineNow(ctx);
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
        ctx.pure = false;
        return v;
      }
      ctx.pure = false;
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
    ctx.pure = false;
    return v;
  }

  if (placeDepth >= maxPlaceDepth) {
    ctx.pure = true;
    return leafValue(state, me, ctx.opts);
  }

  const remaining = maxPlaceDepth - placeDepth;
  const ttKey = observationKey(state, me) + '|r:' + remaining + '|t:' + turnDepth;
  const cached = ctx.tt.get(ttKey);
  if (cached !== undefined) {
    ctx.pure = true;
    return cached;
  }

  const actions = enumerateOwnActions(state, me);
  if (actions.length === 0) {
    const lv = leafValue(state, me, ctx.opts);
    ctx.tt.set(ttKey, lv);
    ctx.pure = true;
    return lv;
  }

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
      break;
    }
  }

  if (subtreePure && !cut && best > -Infinity) ctx.tt.set(ttKey, best);
  ctx.pure = subtreePure;
  return best;
}

/**
 * 1 手の価値。 観測不能ドローは expectimax（サンプル平均）、 それ以外は決定的遷移。
 *
 * ★ CRN の核心はここ。盲ドローのシャッフル seed の導出だけが tempoFast と異なる。
 *   - crnEnabled（既定 true）: シャッフル seed を crnDrawSeed(salt, placeDepth, turnDepth, i, kind)
 *     から導出する（手の累積 seed に依存しない＝兄弟手で同一の山札実現を共有）。
 *     ドロー後の継続 seed も同じ文脈から導出し、より深いドローにも CRN を伝播させる。
 *   - crnEnabled=false: tempoFast と完全に同じく、手の累積 seed からシャッフル seed を導出する。
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
    const kind = action.type === 'DRAW_FROM_DECK' ? 0 : 1;
    let samples =
      action.type === 'DRAW_FROM_DECK'
        ? ctx.opts.rootDrawSamples
        : ctx.opts.chainDrawSamples;
    if (turnDepth > 0) samples = Math.min(samples, 2);
    let total = 0;
    let count = 0;
    for (let i = 0; i < samples; i++) {
      let shuffleSeed: number;
      let childSeed: number;
      if (ctx.opts.crnEnabled) {
        // CRN: 探索文脈のみから導出（手の系列に依存しない）。兄弟手で同一の実現を共有する。
        shuffleSeed = crnDrawSeed(ctx, placeDepth, turnDepth, i, kind);
        // 継続 seed も文脈由来にして、より深いドローノードにも CRN を伝播させる。
        childSeed = crnDrawSeed(ctx, placeDepth, turnDepth, i, kind + 2);
      } else {
        // 従来挙動（tempoFast 互換）: 手の累積 seed から導出。
        shuffleSeed = (seed + Math.imul(i + 1, 0x9e3779b1)) | 0;
        childSeed = (seed ^ Math.imul(i + 1, 0x85ebca6b)) | 0;
      }
      const rand = mulberry32(shuffleSeed);
      const shuffled = shuffle(state.deck, rand);
      const sampledState: GameState = { ...state, deck: shuffled };
      const next = stepGame(sampledState, action);
      if (next === sampledState) continue;
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
    ctx.pure = false; // 観測不能ドローの期待値は salt/seed 依存なので再現不可
    return count > 0 ? total / count : leafValue(state, ctx.me, ctx.opts);
  }

  const next = stepGame(state, action);
  if (next === state) {
    ctx.pure = true;
    return -Infinity;
  }
  const nextDepth = isPlacement(action) ? placeDepth + 1 : placeDepth;
  return searchTurn(next, nextDepth, maxPlaceDepth, seed, turnDepth, alpha, beta, ctx);
}

/**
 * 相手モデル 'tempo' 用の軽量 tempo（lookahead=0, TT/予算/αβ なしの素朴な max）。
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
    // 相手モデル内でも CRN を効かせる（salt は親探索文脈の seed から決定的に作る）。
    crnSalt: (seed ^ 0x6d2b79f5) | 0,
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
 * tempoCrnAI の行動決定（Decider 互換）。
 * 反復深化 + 壁時計バジェット: minPlaceDepth から maxPlaceDepth まで段階的に深くし、
 * 期限を超えたらその反復を破棄して直前完走深さの best-so-far root 手を返す。
 *
 * CRN salt は「決定単位の固定シード」としてここで 1 回だけ作る。反復深化の各深さで
 * 新しい SearchContext を作っても salt は同一なので、深さ間でも同じ山札実現を再利用でき、
 * かつ兄弟手間で必ず共有される（= 共通乱数）。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoCrnOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights,
    tempoChainW: options.tempoChainW ?? DEFAULT_TEMPO_CHAIN_W,
    lookaheadTurns: options.lookaheadTurns ?? DEFAULT_LOOKAHEAD_TURNS,
    rootDrawSamples: options.rootDrawSamples ?? DEFAULT_ROOT_DRAW_SAMPLES,
    chainDrawSamples: options.chainDrawSamples ?? DEFAULT_CHAIN_DRAW_SAMPLES,
    maxPlaceDepth: options.maxPlaceDepth ?? DEFAULT_MAX_PLACE_DEPTH,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    minPlaceDepth: options.minPlaceDepth ?? DEFAULT_MIN_PLACE_DEPTH,
    opponentModel: options.opponentModel ?? DEFAULT_OPPONENT_MODEL,
    opponentMctsIterations: options.opponentMctsIterations ?? DEFAULT_OPPONENT_MCTS_ITER,
    crnEnabled: options.crnEnabled ?? DEFAULT_CRN_ENABLED,
  };
  const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;
  // CRN 用の決定単位の固定 salt。baseSeed から決定的に作るので再現可能だが、
  // 手の系列には依存しない（探索文脈とこの salt だけがドロー実現を決める）。
  const crnSalt = (Math.imul(baseSeed, 0x9e3779b1) ^ 0x632be5ab) | 0;

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

  const rootScored = actions.map((a) => ({ a, s: quickChildScore(state, a, playerId, opts) }));
  rootScored.sort((x, y) => y.s - x.s);
  let bestAction: Action = rootScored[0].a;

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
      crnSalt,
    };
    let depthBestAction: Action = bestAction;
    let depthBestValue = -Infinity;
    let alpha = -Infinity;
    let completed = true;

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
