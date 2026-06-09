/**
 * 【結果 (Gen-13 Stage2, 2026-06-09)】6 パラメータを ES 最適化しても vs tempoFast LA=0 で globalBest は
 * 新規シード 24.2%(parity)・収束 mean 14.1%(有意に弱い)。size5 率も上がらず(≤2.4 vs 人間8.1)＝下層装填の
 * 構築経路が構造的に狭く、最適調律された build policy でも champion を超えられない（ES は build モードを
 * 実質 OFF へ収束）。採用せず・browser 非配線。詳細は ai/CHANGELOG.md の Gen-13 Stage 2。
 *
 * tempoBuildAI ― Stage 2「build policy」: 多ターンのカスケード構築を明示的に計画する派生（Gen-13 候補）。
 *
 * これまでの全失敗の逆算:
 *   tempoFast は「最上段に同色 3 つ揃うと自動発火」を即時得点として常に発火するため、深い縦積みを
 *   溜められない（size5 率 2.7。人間は 8.1）。静的評価(Gen-7/13)・葉 formation shaping(Gen-12 lattice)・
 *   局面適応(Gen-10)・人間模倣(Gen-11)はいずれも「評価/葉の設計」であり、多ターンの装填計画を遂行できず
 *   parity だった。
 *
 * 本 AI の新規機構（評価でなく探索 policy 側。build/discharge の 2 相）:
 *   - **build 相**（既定。放電条件未達の間）: 葉評価を「下層に同色を装填した量（cascade ポテンシャル）」へ
 *     置換し、かつ**今ターンの発火・得点を罰する（発火遅延）**。これにより探索は「最上段を完成させて
 *     即発火する」手を避け、最上段の 1 つ下以降に同色を複数スロットで揃える（＝放電時に上層除去で
 *     露出して連鎖する装填層）を多ターンかけて積む。tempoFast の即時発火欲を構造的に抑える。
 *   - **discharge 相**（放電トリガ: 場の最高スコアが閾値到達 / 自分の装填層が目標到達 / ターン到達）:
 *     葉を通常の tempoFast 評価（発火・得点最大化）へ戻し、溜めた装填を一気に連鎖放電する。
 *   相の判定は決定（手番）単位で root 局面に対し 1 回行い、その手番の探索全体で固定する。
 *
 * 探索は tempoFast と同一（own-turn 完全読み + expectimax + αβ + 反復深化 + TT）。lookahead は既定 0
 * （build は構造を貪欲に積めばよく、相手手番を挟む先読みは不要・高コスト）。
 *
 * パラメータ（後で ES で進化させる前提で options 公開）。既定値は v1 の手始め。
 * 既存 AI（tempoFast/evaluator 等）は一切変更しない（追加のみ）。ユーザーの lattice 系ファイルにも触れない。
 */
import type { Action, Color, GameState, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { END_SCORE_THRESHOLD } from '../game/engine';
import { evaluateState, type EvalWeights } from './evaluator';
import { totalScoreForTurn } from '../game/scoring';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { observationKey } from './infoSet';

export interface TempoBuildOptions {
  /** discharge 相の葉に使う重み（省略時 evaluator の DEFAULT_WEIGHTS）。 */
  weights?: EvalWeights;
  /** build 相: 装填層スコアへの係数（下層の同色 3+ を強く報酬）。 */
  buildLoadW?: number;
  /** build 相: 装填寸前（同色 2）への係数。 */
  buildNearW?: number;
  /** build 相: 今ターンに発火・得点した分への罰（発火遅延の本体）。 */
  buildFirePenalty?: number;
  /** build 相: 大局観のための薄い静的評価係数（overflow/脅威）。 */
  buildStaticW?: number;
  /** 放電トリガ: 場の最高スコアがこの値以上で discharge。既定 = 終了閾値 -6。 */
  dischargeScore?: number;
  /** 放電トリガ: 自分の装填層（下層同色 3+ の層数）がこの値以上で discharge。 */
  dischargeLayers?: number;
  /** 放電トリガ: turnNumber がこの値以上で discharge。既定 Infinity（無効）。 */
  dischargeTurn?: number;
  rootDrawSamples?: number;
  chainDrawSamples?: number;
  maxPlaceDepth?: number;
  minPlaceDepth?: number;
  timeBudgetMs?: number;
}

const DEFAULT_BUILD_LOAD_W = 600;
const DEFAULT_BUILD_NEAR_W = 120;
const DEFAULT_BUILD_FIRE_PENALTY = 400;
const DEFAULT_BUILD_STATIC_W = 0.2;
const DEFAULT_DISCHARGE_SCORE = END_SCORE_THRESHOLD - 6; // 14
const DEFAULT_DISCHARGE_LAYERS = 3;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
const DEFAULT_MIN_PLACE_DEPTH = 2;
const DEFAULT_TIME_BUDGET_MS = 1000;
const DEFAULT_TEMPO_CHAIN_W = 50;
const OPP_CHAIN_FACTOR = 0.5;
const TIME_CHECK_MASK = 0x3ff;

interface ResolvedOptions {
  weights: EvalWeights | undefined;
  buildLoadW: number;
  buildNearW: number;
  buildFirePenalty: number;
  buildStaticW: number;
  dischargeScore: number;
  dischargeLayers: number;
  dischargeTurn: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
  minPlaceDepth: number;
  timeBudgetMs: number;
}

class BudgetExceeded extends Error {}

interface SearchContext {
  me: number;
  opts: ResolvedOptions;
  deadline: number;
  /** この決定で discharge 相か（false=build 相）。root で 1 回判定し固定。 */
  discharge: boolean;
  /** build 相の発火罰の基準となるターン開始時スコア。 */
  baseScore: number;
  tt: Map<string, number>;
  leafCounter: number;
  timedOut: boolean;
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

/**
 * 装填層の集計: 深さ d（0=最上段）ごとに各色が何スロットに在るかを数え、
 *  - loaded = d>=1 で同色 3 スロット以上（放電時に上層除去で露出すれば即連鎖発火する装填層）の延べ層数
 *  - near   = 同色 2 スロット（あと 1 で装填／d=0 なら放電の起点になりうる最上段リーチ）
 * を返す。loaded が多いほど、1 回の放電で連鎖する段数が多い＝大カスケードのポテンシャル。
 */
function loadCounts(player: Player): { loaded: number; near: number } {
  const depthColor: Map<Color, number>[] = [];
  let maxDepth = 0;
  for (const slot of player.board.slots) if (slot.stack.length > maxDepth) maxDepth = slot.stack.length;
  for (let d = 0; d < maxDepth; d++) depthColor.push(new Map<Color, number>());
  for (const slot of player.board.slots) {
    const st = slot.stack;
    const n = st.length;
    for (let d = 0; d < n; d++) {
      const c = st[n - 1 - d].color;
      const m = depthColor[d];
      m.set(c, (m.get(c) ?? 0) + 1);
    }
  }
  let loaded = 0;
  let near = 0;
  for (let d = 0; d < depthColor.length; d++) {
    for (const count of depthColor[d].values()) {
      if (d >= 1 && count >= 3) loaded += 1;
      else if (count === 2) near += 1;
    }
  }
  return { loaded, near };
}

/** build 相の薄い静的評価（overflow/脅威の大局観のみ。得点項は罰側で扱う）。 */
function thinStatic(state: GameState, me: number, w: EvalWeights | undefined): number {
  return evaluateState(state, me, w);
}

/**
 * 葉評価。discharge 相は通常 tempoFast（発火・得点最大化）。build 相は装填を報酬し発火・得点を罰する。
 */
function leafValue(state: GameState, ctx: SearchContext): number {
  const me = ctx.me;
  const opts = ctx.opts;
  if (ctx.discharge || state.phase === 'gameOver') {
    // 通常 tempoFast 葉（評価 + 複数色チェイン準備度、相手割引）。終局もこちらでフル評価。
    let v = evaluateState(state, me, opts.weights);
    v += DEFAULT_TEMPO_CHAIN_W * multiColorChainReadiness(state.players[me]);
    for (const p of state.players) {
      if (p.id === me) continue;
      v -= DEFAULT_TEMPO_CHAIN_W * OPP_CHAIN_FACTOR * multiColorChainReadiness(p);
    }
    return v;
  }
  // build 相: 装填を積み、発火・得点を遅延する。
  const player = state.players[me];
  const { loaded, near } = loadCounts(player);
  let realizedGain = player.score - ctx.baseScore;
  if (state.currentPlayerIndex === me) {
    realizedGain += totalScoreForTurn(state.turn.combosThisTurn).total;
  }
  let v = opts.buildLoadW * loaded + opts.buildNearW * near;
  v -= opts.buildFirePenalty * realizedGain; // 発火遅延（今ターン得点を罰す）
  if (opts.buildStaticW !== 0) v += opts.buildStaticW * thinStatic(state, me, opts.weights);
  return v;
}

function quickChildScore(state: GameState, action: Action, ctx: SearchContext): number {
  if (isBlindDraw(action)) return 0;
  const next = stepGame(state, action);
  if (next === state) return -Infinity;
  return leafValue(next, ctx);
}

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
    ctx.pure = true;
    return leafValue(state, ctx);
  }
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
    ctx.pure = false;
    return v;
  }
  if (placeDepth >= maxPlaceDepth) {
    ctx.pure = true;
    return leafValue(state, ctx);
  }
  const remaining = maxPlaceDepth - placeDepth;
  const ttKey = observationKey(state, me) + '|r:' + remaining + '|d:' + (ctx.discharge ? 1 : 0);
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
    ctx.pure = false;
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

/** root 局面で discharge 相かを判定（場の最高スコア / 自分の装填層 / ターン数のいずれかで放電へ）。 */
function isDischargePhase(state: GameState, me: number, opts: ResolvedOptions): boolean {
  let maxScore = 0;
  for (const p of state.players) if (p.score > maxScore) maxScore = p.score;
  if (maxScore >= opts.dischargeScore) return true;
  if (loadCounts(state.players[me]).loaded >= opts.dischargeLayers) return true;
  if (state.turnNumber >= opts.dischargeTurn) return true;
  return false;
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoBuildOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights,
    buildLoadW: options.buildLoadW ?? DEFAULT_BUILD_LOAD_W,
    buildNearW: options.buildNearW ?? DEFAULT_BUILD_NEAR_W,
    buildFirePenalty: options.buildFirePenalty ?? DEFAULT_BUILD_FIRE_PENALTY,
    buildStaticW: options.buildStaticW ?? DEFAULT_BUILD_STATIC_W,
    dischargeScore: options.dischargeScore ?? DEFAULT_DISCHARGE_SCORE,
    dischargeLayers: options.dischargeLayers ?? DEFAULT_DISCHARGE_LAYERS,
    dischargeTurn: options.dischargeTurn ?? Infinity,
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
  const discharge = isDischargePhase(state, playerId, opts);
  const baseScore = state.players[playerId].score;

  const mkCtx = (): SearchContext => ({
    me: playerId,
    opts,
    deadline,
    discharge,
    baseScore,
    tt: new Map(),
    leafCounter: 0,
    timedOut: false,
    pure: false,
  });

  const orderCtx = mkCtx();
  orderCtx.deadline = Infinity;
  const rootScored = actions.map((a) => ({ a, s: quickChildScore(state, a, orderCtx) }));
  rootScored.sort((x, y) => y.s - x.s);
  let bestAction: Action = rootScored[0].a;

  for (let depth = opts.minPlaceDepth; depth <= opts.maxPlaceDepth; depth++) {
    const ctx = mkCtx();
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
        const v = evalAction(state, action, 0, depth, baseSeed, alpha, Infinity, ctx);
        if (v > depthBestValue) {
          depthBestValue = v;
          depthBestAction = action;
        }
        if (depthBestValue > alpha) alpha = depthBestValue;
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) completed = false;
      else throw e;
    }
    if (completed && depthBestValue > -Infinity) bestAction = depthBestAction;
    if (!completed || Date.now() >= deadline) break;
  }
  return bestAction;
}
