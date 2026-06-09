/**
 * tempoHumanAI ― E2: 人間棋譜の模倣プライアを葉評価に注入した tempoFast 変種。
 *
 * `ai/scripts/learn-human-prior.ts` が 27 局の人間配置選択から学習した「人間らしさ効用」
 * （`src/ai/humanPriorWeights.ts` の HUMAN_PRIOR_MODEL）を、tempoFast の葉評価に
 * `humanPriorW * humanPriorScore(局面)` として加える。self-play 自己参照を抜けて
 * 「人間が好む局面」へ探索を寄せられるかを検証する。
 *
 * 注意（学習段階の所見）: per-placement の条件付きロジットはホールドアウトで evaluateState の
 * 人間手予測率（~27%）を**下回った**（test 18%）。＝人間優位は単一配置の選好でなく多ターンの
 * race-timing にあるため単一局面プライアでは捉えにくい。本 AI はその self-play での実地確認用。
 *
 * 探索・評価は tempoFast と同一（own-turn 完全読み, lookahead=1, expectimax, αβ, 反復深化, TT）。
 * leafValue に人間プライア項を足すだけ。既存ファイルは一切変更しない（追加のみ）。
 */
import type { Action, Color, GameState, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { evaluateState, type EvalWeights } from './evaluator';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { observationKey } from './infoSet';
import { humanPriorScore } from './humanFeatures';
import { HUMAN_PRIOR_MODEL } from './humanPriorWeights';

export interface TempoHumanOptions {
  weights?: EvalWeights;
  tempoChainW?: number;
  /** 人間プライア効用への係数。0 で tempoFast と同一。既定は効用 O(0.3) を eval スケールに乗せる目安。 */
  humanPriorW?: number;
  lookaheadTurns?: number;
  rootDrawSamples?: number;
  chainDrawSamples?: number;
  maxPlaceDepth?: number;
  timeBudgetMs?: number;
  minPlaceDepth?: number;
}

const DEFAULT_TEMPO_CHAIN_W = 50;
// 人間プライア係数。humanPriorScore は標準化空間の小さな効用（O(0.3)）なので、evaluateState の
// 着手差（数十〜数百）と拮抗させるには大きめが要る。500 で「人間効用 0.1 ≒ eval 50 点弱」程度。
const DEFAULT_HUMAN_PRIOR_W = 500;
const DEFAULT_LOOKAHEAD_TURNS = 1;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
const DEFAULT_TIME_BUDGET_MS = 1000;
const DEFAULT_MIN_PLACE_DEPTH = 2;
const OPP_CHAIN_FACTOR = 0.5;
const ADVANCE_MAX_STEPS = 400;
const TIME_CHECK_MASK_CHEAP = 0x3ff;
const TIME_CHECK_MASK_EXPENSIVE = 0xf;

interface ResolvedOptions {
  weights: EvalWeights | undefined;
  tempoChainW: number;
  humanPriorW: number;
  lookaheadTurns: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
  timeBudgetMs: number;
  minPlaceDepth: number;
}

class BudgetExceeded extends Error {}

interface SearchContext {
  me: number;
  opts: ResolvedOptions;
  deadline: number;
  tt: Map<string, number>;
  leafCounter: number;
  timedOut: boolean;
  timeCheckMask: number;
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

/** tempoFast の leaf に人間プライア項を加えた評価。humanPriorW=0 で tempoFast と完全一致。 */
function leafValue(state: GameState, me: number, opts: ResolvedOptions): number {
  let v = evaluateState(state, me, opts.weights);
  if (opts.tempoChainW !== 0) {
    v += opts.tempoChainW * multiColorChainReadiness(state.players[me]);
    for (const p of state.players) {
      if (p.id === me) continue;
      v -= opts.tempoChainW * OPP_CHAIN_FACTOR * multiColorChainReadiness(p);
    }
  }
  if (opts.humanPriorW !== 0) {
    v += opts.humanPriorW * humanPriorScore(state, me, HUMAN_PRIOR_MODEL);
  }
  return v;
}

function quickChildScore(state: GameState, action: Action, me: number, opts: ResolvedOptions): number {
  if (isBlindDraw(action)) return 0;
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

function checkDeadlineNow(ctx: SearchContext): void {
  if (Date.now() >= ctx.deadline) {
    ctx.timedOut = true;
    throw new BudgetExceeded();
  }
}

function advanceToMyTurn(state: GameState, ctx: SearchContext, seed: number): GameState {
  let s = state;
  for (let g = 0; g < ADVANCE_MAX_STEPS && s.phase !== 'gameOver'; g++) {
    if (s.currentPlayerIndex === ctx.me && s.phase === 'awaitingDraw') return s;
    const actor = currentActorId(s);
    const stepSeed = (seed + Math.imul(g + 1, 0x9e3779b1)) | 0;
    const a = decideSmart(s, actor, stepSeed);
    if (!a) return s;
    const before = s;
    s = stepGame(s, a);
    if (s === before) return s;
  }
  return s;
}

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
        const v = searchTurn(advanced, 0, maxPlaceDepth, (seed ^ 0x9e3779b9) | 0, turnDepth + 1, alpha, beta, ctx);
        ctx.pure = false;
        return v;
      }
      ctx.pure = false;
      return leafValue(advanced, me, ctx.opts);
    }
    ctx.pure = true;
    return leafValue(state, me, ctx.opts);
  }

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
      total += searchTurn(next, placeDepth + 1, maxPlaceDepth, childSeed, turnDepth, -Infinity, Infinity, ctx);
      count++;
    }
    ctx.pure = false;
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

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoHumanOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights,
    tempoChainW: options.tempoChainW ?? DEFAULT_TEMPO_CHAIN_W,
    humanPriorW: options.humanPriorW ?? DEFAULT_HUMAN_PRIOR_W,
    lookaheadTurns: options.lookaheadTurns ?? DEFAULT_LOOKAHEAD_TURNS,
    rootDrawSamples: options.rootDrawSamples ?? DEFAULT_ROOT_DRAW_SAMPLES,
    chainDrawSamples: options.chainDrawSamples ?? DEFAULT_CHAIN_DRAW_SAMPLES,
    maxPlaceDepth: options.maxPlaceDepth ?? DEFAULT_MAX_PLACE_DEPTH,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    minPlaceDepth: options.minPlaceDepth ?? DEFAULT_MIN_PLACE_DEPTH,
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
      timeCheckMask: opts.lookaheadTurns > 0 ? TIME_CHECK_MASK_EXPENSIVE : TIME_CHECK_MASK_CHEAP,
      pure: false,
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
        const v = evalAction(state, action, 0, depth, baseSeed, 0, alpha, Infinity, ctx);
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
