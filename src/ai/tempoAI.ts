/**
 * tempoAI ― 1 ターン完全読み（own-turn full search）+ テンポ志向の評価 + 任意で多ターン先読み。
 *
 * 設計の核心（なぜ既存 AI が頭打ちだったか）:
 *   既存の smartAI（1 手読み貪欲）も mctsAI（IS-MCTS, leaf は静的評価）も、 状態遷移を
 *   「1 手ずつ」 評価するため、 「このターン全体で組める連鎖・得点」 を陽に最大化していない。
 *   実測（ai/CHANGELOG.md 根本診断）でも mcts の連鎖は size3=88% / size5=0.1% と、
 *   大連鎖をほぼ組めていなかった。
 *
 *   このゲームは平均合法手数が 5.1 と分岐因子が小さいため、 「自分の手番が続く限りを
 *   全探索する」 own-turn full search が現実的に可能。 tempoAI は:
 *     - 2 枚の配置順・配置先、 連鎖ごとの「引く/捨てる」、 連鎖シーケンスを DFS で完全展開し、
 *     - ターン終了時（actor が自分でなくなる / 終局）の盤面価値を最大化する最初の 1 手を返す。
 *   これにより「1 ターンで組める最大の連鎖（チェイン）」 を陽に探索する（smart / mcts にはできない）。
 *
 *   山札からのドロー（先頭が観測不能）は山札をシャッフルした複数サンプルの期待値で近似する
 *   （expectimax）。 これは smartAI.evaluateUnknownDraw と同じ「フェアな」 不完全情報の扱い。
 *   ギフト割り当て（CONFIRM_GIFTS）は得点に影響しない（得点は連鎖解決時に確定済み）ため、
 *   離散化が難しいこのフェーズは smartAI のヒューリスティックに委譲する。
 *
 *   leaf 評価は既存 evaluateState を土台にしつつ、 「複数色チェイン準備度」 を加点できる
 *   （`tempoChainW`）。 既存評価の chainReadinessScore が「最良 1 色」 のみを見るのに対し、
 *   tempo が実際に組む「複数色を同時に準備するチェイン」 を全色合計・非線形（near²）で評価する。
 *
 *   `lookaheadTurns > 0` のときは「自分のターンが終わった」 葉で即評価せず、 相手の手番を
 *   smartAI で軽く進めて自分の次の手番に戻り、 そこで再びターン完全読みを行う（多ターン先読み）。
 *   チェイン準備の価値を静的近似でなく「次の自分の手番で実際に取れる得点」 で評価できる。
 *   `lookaheadTurns=0`（デフォルト）なら 1 ターン完全読みのみ＝従来挙動。
 */
import type { Action, Color, GameState, Player } from '../game/types';
import { stepGame } from '../game/reducer';
import { mulberry32, shuffle } from '../game/rng';
import { evaluateState, type EvalWeights } from './evaluator';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';

export interface TempoOptions {
  /** leaf 評価の重み。省略時は evaluator のモジュール global（DEFAULT_WEIGHTS）を使う。 */
  weights?: EvalWeights;
  /**
   * 複数色チェイン準備度への加点係数（0 で従来の evaluateState のみ）。
   * 自分の準備度を加点し、 相手の準備度を `OPP_CHAIN_FACTOR` 倍して減点する。
   */
  tempoChainW?: number;
  /**
   * 多ターン先読みのターン数（0 で 1 ターン完全読みのみ＝従来挙動）。
   * 1 なら「自分の次の手番」 まで、 相手の手番を smartAI で進めてから再びターン完全読みする。
   */
  lookaheadTurns?: number;
  /** ターン最初の山札ドロー（先頭 2 枚が不明）の期待値サンプル数。 */
  rootDrawSamples?: number;
  /** 連鎖中の追加ドロー（先頭 1 枚が不明）の期待値サンプル数。ネストするので小さめ。 */
  chainDrawSamples?: number;
  /** ターン内 DFS の最大配置深さ（連鎖が異常に続く場合の安全弁）。 */
  maxPlaceDepth?: number;
}

/**
 * 複数色チェイン準備度の加点係数のデフォルト。Gen-4-A 確証ベンチ（w=45/50/60 × seed 8001/9001,
 * 各 150 局、 候補 tempo 1 席 vs 現状最強 mcts 3 席 rotate）で 45〜60 はいずれも勝率 ~55%
 * （Wilson CI 下限 >25%）。 50 は 2 seed とも 55.3%（worst-case が最良・seed 間で最も安定）のため採用。
 * 0 にすると従来の evaluateState のみ（探索構造だけ）になる。
 */
const DEFAULT_TEMPO_CHAIN_W = 50;
const DEFAULT_LOOKAHEAD_TURNS = 0;
const DEFAULT_ROOT_DRAW_SAMPLES = 5;
const DEFAULT_CHAIN_DRAW_SAMPLES = 2;
const DEFAULT_MAX_PLACE_DEPTH = 12;
/** 相手のチェイン準備度を脅威として割り引く係数（自分の準備度よりは軽く見る）。 */
const OPP_CHAIN_FACTOR = 0.5;
/** 先読みで相手の手番を進める際の無限ループ安全弁（自分の手番に戻るまでの最大ステップ）。 */
const ADVANCE_MAX_STEPS = 400;

interface ResolvedOptions {
  weights: EvalWeights | undefined;
  tempoChainW: number;
  lookaheadTurns: number;
  rootDrawSamples: number;
  chainDrawSamples: number;
  maxPlaceDepth: number;
}

/**
 * 現在「行動を選ぶ主体」 のプレイヤー ID。 awaitingGiftPlacement では受領者、 それ以外は手番者。
 * mctsAI / chainRushAI と同じ定義。
 */
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

/** actionSpace（mcts と共通の正典）経由で actor の合法手を列挙する。 */
function enumerateOwnActions(state: GameState, actor: number): Action[] {
  const ids = legalActionIds(state, actor);
  const acts: Action[] = [];
  for (const id of ids) {
    const a = actionIdToAction(state, actor, id);
    if (a) acts.push(a);
  }
  return acts;
}

/** 山札の先頭が観測不能なドロー（期待値計算が必要な手）か。 */
function isBlindDraw(action: Action): boolean {
  return action.type === 'DRAW_FROM_DECK' || action.type === 'CHOOSE_ADDITIONAL_DRAW';
}

/** 配置系（ターン内の「カードを 1 枚消費する」手）か。DFS の深さ制御に使う。 */
function isPlacement(action: Action): boolean {
  return (
    action.type === 'PLACE_DRAWN' ||
    action.type === 'PLACE_ADDITIONAL_DRAW' ||
    action.type === 'DISCARD_TOP'
  );
}

/**
 * 複数色チェイン準備度。 既存 evaluator の chainReadinessScore が「最良 1 色」 のみを見るのに対し、
 * これは「複数色がそれぞれ複数スロットの上位に並ぶ」 状態を全色合計・非線形に評価する。
 * このゲームの得点はチェインボーナス n(n-1)/2 を含むため、 単色の高リーチ温存より
 * 「多色を同時に発火寸前まで持っていく」 盤面を高く見積もる。
 */
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
    if (near < 2) continue; // 1 スロットだけの色は連鎖の起点にならない
    const top = topCount.get(color) ?? 0;
    // near の 2 乗で「多くのスロットの上位に同色が並ぶ」 ほど非線形に加点。
    // top（既に最上段に揃っている枚数）も少し加える。
    sum += near * near + top;
  }
  return sum;
}

/**
 * ターン終了局面（または探索打ち切り）の自分視点の価値。
 * 既存 evaluateState（smartAI と同じく終局時は winnerBonus/loserPenalty が効く）を土台に、
 * tempoChainW>0 のときは複数色チェイン準備度（自分 − 相手×係数）を加える。
 */
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

/**
 * 相手（および自分のギフト受領）の手番を smartAI で進め、 自分の次の手番（awaitingDraw）に
 * 戻った状態を返す。 多ターン先読み（lookahead）でのみ使う軽量な相手モデル。
 * 終局や進行不能になったらその状態を返す。
 */
function advanceToMyTurn(state: GameState, me: number, seed: number): GameState {
  let s = state;
  for (let g = 0; g < ADVANCE_MAX_STEPS && s.phase !== 'gameOver'; g++) {
    if (s.currentPlayerIndex === me && s.phase === 'awaitingDraw') return s;
    const actor = currentActorId(s);
    const a = decideSmart(s, actor, (seed + Math.imul(g + 1, 0x9e3779b1)) | 0);
    if (!a) return s;
    const before = s;
    s = stepGame(s, a);
    if (s === before) return s;
  }
  return s;
}

/**
 * 「自分の手番が続く限り」 を DFS で完全展開し、 ターン終了時（または先読み後）の盤面価値の
 * 最大値を返す。 actor が自分でなくなる or 終局でターン内探索は止まり、
 * `turnDepth < lookaheadTurns` かつ自分のターンが終わった場合のみ相手を進めて次の手番を読む。
 */
function searchTurn(
  state: GameState,
  me: number,
  placeDepth: number,
  seed: number,
  opts: ResolvedOptions,
  turnDepth: number
): number {
  if (state.phase === 'gameOver') return leafValue(state, me, opts);

  const actor = currentActorId(state);
  if (actor !== me) {
    // 自分のターンが完全に終わった（currentPlayerIndex が他者）かつ先読み余地があれば、
    // 相手を smartAI で進めて自分の次の手番を完全読みする。
    // （自分のターン中のギフト配布で相手が受領する局面は currentPlayerIndex===me なので除外）
    if (state.currentPlayerIndex !== me && turnDepth < opts.lookaheadTurns) {
      const advanced = advanceToMyTurn(state, me, seed);
      if (
        advanced.phase !== 'gameOver' &&
        advanced.currentPlayerIndex === me &&
        advanced.phase === 'awaitingDraw'
      ) {
        return searchTurn(advanced, me, 0, (seed ^ 0x9e3779b9) | 0, opts, turnDepth + 1);
      }
      return leafValue(advanced, me, opts);
    }
    return leafValue(state, me, opts);
  }

  // ギフト割り当ては得点に影響しない（得点は連鎖解決時に確定済み）。
  // 離散化が難しいので smartAI のヒューリスティックで 1 手だけ確定して進める。
  if (state.phase === 'awaitingGiftSelection') {
    const a = decideSmart(state, me, seed);
    if (!a) return leafValue(state, me, opts);
    const next = stepGame(state, a);
    if (next === state) return leafValue(state, me, opts);
    return searchTurn(next, me, placeDepth, seed, opts, turnDepth);
  }

  // 連鎖が異常に続く場合の安全弁。
  if (placeDepth >= opts.maxPlaceDepth) return leafValue(state, me, opts);

  const actions = enumerateOwnActions(state, me);
  if (actions.length === 0) return leafValue(state, me, opts);

  let best = -Infinity;
  for (const action of actions) {
    const v = evalAction(state, action, me, placeDepth, seed, opts, turnDepth);
    if (v > best) best = v;
  }
  return best;
}

/**
 * 1 手の価値を求める。 観測不能ドローは山札シャッフルの期待値（expectimax）、 それ以外は決定的に遷移。
 * 先読み（turnDepth>0）中はドローサンプル数を抑えて計算量の指数増を防ぐ。
 */
function evalAction(
  state: GameState,
  action: Action,
  me: number,
  placeDepth: number,
  seed: number,
  opts: ResolvedOptions,
  turnDepth: number
): number {
  if (isBlindDraw(action)) {
    let samples =
      action.type === 'DRAW_FROM_DECK' ? opts.rootDrawSamples : opts.chainDrawSamples;
    if (turnDepth > 0) samples = Math.min(samples, 2); // 先読み中は軽量化
    let total = 0;
    let count = 0;
    for (let i = 0; i < samples; i++) {
      const rand = mulberry32((seed + Math.imul(i + 1, 0x9e3779b1)) | 0);
      const shuffled = shuffle(state.deck, rand);
      const sampledState: GameState = { ...state, deck: shuffled };
      const next = stepGame(sampledState, action);
      if (next === sampledState) continue;
      const childSeed = (seed ^ Math.imul(i + 1, 0x85ebca6b)) | 0;
      total += searchTurn(next, me, placeDepth + 1, childSeed, opts, turnDepth);
      count++;
    }
    return count > 0 ? total / count : leafValue(state, me, opts);
  }

  const next = stepGame(state, action);
  if (next === state) return -Infinity; // 無効手（state 不変）は選ばない
  const nextDepth = isPlacement(action) ? placeDepth + 1 : placeDepth;
  return searchTurn(next, me, nextDepth, seed, opts, turnDepth);
}

/**
 * tempoAI の行動決定。Decider 互換（余分な引数は無視可能）。
 *
 * - awaitingGiftSelection: 割り当ては smartAI に委譲（得点不変・離散化困難）。
 * - awaitingGiftPlacement（自分が受領）/ 通常手番: ターン内を完全読みして最善の初手を返す。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  options: TempoOptions = {}
): Action | null {
  const opts: ResolvedOptions = {
    weights: options.weights,
    tempoChainW: options.tempoChainW ?? DEFAULT_TEMPO_CHAIN_W,
    lookaheadTurns: options.lookaheadTurns ?? DEFAULT_LOOKAHEAD_TURNS,
    rootDrawSamples: options.rootDrawSamples ?? DEFAULT_ROOT_DRAW_SAMPLES,
    chainDrawSamples: options.chainDrawSamples ?? DEFAULT_CHAIN_DRAW_SAMPLES,
    maxPlaceDepth: options.maxPlaceDepth ?? DEFAULT_MAX_PLACE_DEPTH,
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

  let bestAction: Action = actions[0];
  let bestValue = -Infinity;
  for (const action of actions) {
    const v = evalAction(state, action, playerId, 0, baseSeed, opts, 0);
    if (v > bestValue) {
      bestValue = v;
      bestAction = action;
    }
  }
  return bestAction;
}
