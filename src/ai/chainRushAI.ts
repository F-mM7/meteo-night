/**
 * chainRushAI ― 「発火時に20点到達する確率が閾値を超えるまで積み、超えたら発火する」 bot。
 *
 * 設計（ユーザーと合意した論理）:
 *   - 必要点数 = 20（最速到達が至上命題）。
 *   - 非発火盤面の価値 = 「今このターンに発火を狙ったときの獲得点分布」 の P(20点到達)。
 *     山札を多数サンプル（determinize）し、 各サンプルで発火プレイアウトを回して 20 到達割合を測る。
 *     確率は山札ランダム性（引く札＋発火ごとに強制されるドロー）由来。
 *   - 各ターン: P(20到達) ≥ 閾値 なら発火。 未満なら非発火で連鎖準備度を最大化して積む。
 *   - 閾値は相手の最高点の関数（相手が 20 に近いほど早期発火）＝軽量な相手織り込み。
 *
 * フェアネス: 発火プレイアウトは「取り除き優先・繋がらない時だけブラインドドロー」 で打つ。
 *   ドローの選択は引く札を覗かない（評価はサンプル山札、 実戦は実際の山札を引いて反応）。
 */
import type { Action, Color, GameState, GiftAssignment, Player } from '../game/types';
import { COLORS } from '../game/types';
import { stepGame } from '../game/reducer';
import { totalScoreForTurn } from '../game/scoring';
import { END_SCORE_THRESHOLD } from '../game/engine';
import { determinizeDeck } from './infoSet';

const REQUIRED = END_SCORE_THRESHOLD; // 20
const FIRE_SAMPLES = 12; // 発火統計の山札サンプル数
const BUILD_SAMPLES = 3; // 積む配置評価（期待発火得点）の山札サンプル数
const PLAYOUT_MAX_STEPS = 40; // 発火プレイアウトの安全上限
const BASE_THRESHOLD = 0.5; // P(20到達) で発火する基準閾値（相手が遠いとき）

function freshTurnState(): GameState['turn'] {
  return {
    pendingDraw: [],
    pendingAdditionalDraw: null,
    combosThisTurn: [],
    giftQueue: [],
    hasDrawn: false,
    pendingGiftBatches: [],
    discardedCardIds: [],
  };
}

const MY_ACTION_PHASES: ReadonlySet<GameState['phase']> = new Set([
  'awaitingDraw',
  'awaitingPlaceDrawn',
  'awaitingAdditionalActionChoice',
  'awaitingPlaceAdditionalDraw',
  'awaitingAdditionalDiscard',
]);

function currentActorId(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

/** 自分の確定スコア + （自手番の行動中なら）当ターン未確定コンボ点。 */
function projectedScore(state: GameState, pid: number): number {
  const me = state.players[pid];
  if (state.currentPlayerIndex === pid && MY_ACTION_PHASES.has(state.phase)) {
    return me.score + totalScoreForTurn(state.turn.combosThisTurn).total;
  }
  return me.score;
}

function dominantNearTopColor(player: Player): Color {
  const nearTopCount = new Map<Color, number>();
  for (const slot of player.board.slots) {
    const n = slot.stack.length;
    if (n === 0) continue;
    const near = new Set<Color>([slot.stack[n - 1].color]);
    if (n >= 2) near.add(slot.stack[n - 2].color);
    for (const c of near) nearTopCount.set(c, (nearTopCount.get(c) ?? 0) + 1);
  }
  let best: Color = COLORS[0];
  let bestN = -1;
  for (const color of COLORS) {
    const n = nearTopCount.get(color) ?? 0;
    if (n > bestN) {
      bestN = n;
      best = color;
    }
  }
  return best;
}

function maxOpponentScore(state: GameState, pid: number): number {
  let m = 0;
  for (const p of state.players) {
    if (p.id !== pid && p.score > m) m = p.score;
  }
  return m;
}

/** 相手が 20 に近いほど閾値を下げ、 早期発火させる（軽量な相手織り込み）。 */
function fireThreshold(maxOpp: number): number {
  return Math.max(0.15, BASE_THRESHOLD - 0.05 * Math.max(0, maxOpp - 12));
}

// ---- 発火プレイアウト（貪欲・フェア） ----

/** awaitingPlaceDrawn: 手元の既知カードを配置して projectedScore を最大化する最初の配置手を返す。 */
function bestPlacementFirstAction(state: GameState, pid: number): Action | null {
  const pending = state.turn.pendingDraw;
  if (pending.length === 0) return null;
  const card0 = pending[0];
  const slots = state.players[pid].board.slots;
  let bestSlot = 0;
  let bestV = -Infinity;
  for (let slot = 0; slot < slots.length; slot++) {
    let ns: GameState;
    try {
      ns = stepGame(state, { type: 'PLACE_DRAWN', cardId: card0.id, slotIndex: slot });
    } catch {
      continue;
    }
    if (ns === state) continue;
    // まだ配置が残る（awaitingPlaceDrawn）なら 1 手先まで簡易評価、 そうでなければ即評価
    let v: number;
    if (ns.phase === 'awaitingPlaceDrawn') {
      const c1 = ns.turn.pendingDraw[0];
      let sub = -Infinity;
      for (let s2 = 0; s2 < slots.length; s2++) {
        try {
          const ns2 = stepGame(ns, { type: 'PLACE_DRAWN', cardId: c1.id, slotIndex: s2 });
          if (ns2 === ns) continue;
          const pv = projectedScore(ns2, pid);
          if (pv > sub) sub = pv;
        } catch {
          /* skip */
        }
      }
      v = sub === -Infinity ? projectedScore(ns, pid) : sub;
    } else {
      v = projectedScore(ns, pid);
    }
    if (v > bestV) {
      bestV = v;
      bestSlot = slot;
    }
  }
  return { type: 'PLACE_DRAWN', cardId: card0.id, slotIndex: bestSlot };
}

function bestSingleSlot(
  state: GameState,
  pid: number,
  make: (slotIndex: number) => Action
): Action | null {
  const slots = state.players[pid].board.slots;
  let best: Action | null = null;
  let bestV = -Infinity;
  for (let slot = 0; slot < slots.length; slot++) {
    const a = make(slot);
    try {
      const ns = stepGame(state, a);
      if (ns === state) continue;
      const v = projectedScore(ns, pid);
      if (v > bestV) {
        bestV = v;
        best = a;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

/** awaitingAdditionalActionChoice で「取り除きが連鎖を継続させるか」 を 2 手先読みで確認。 */
function discardSustains(state: GameState, pid: number): boolean {
  let s1: GameState;
  try {
    s1 = stepGame(state, { type: 'CHOOSE_ADDITIONAL_DISCARD' });
  } catch {
    return false;
  }
  if (s1.phase !== 'awaitingAdditionalDiscard') return false;
  const base = projectedScore(state, pid);
  const slots = s1.players[pid].board.slots;
  for (let slot = 0; slot < slots.length; slot++) {
    if (slots[slot].stack.length === 0) continue;
    try {
      const s2 = stepGame(s1, { type: 'DISCARD_TOP', slotIndex: slot });
      if (projectedScore(s2, pid) > base) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/** 発火継続のための次の 1 手（貪欲・フェア）。 */
function greedyFireAction(state: GameState, pid: number): Action | null {
  const player = state.players[pid];
  switch (state.phase) {
    case 'awaitingDraw': {
      // 場札優先（見えている）。 dominant 色を含む組を取る。 無ければ山札（ブラインド）。
      const dom = dominantNearTopColor(player);
      let bestPair: 0 | 1 | null = null;
      let bestCnt = -1;
      for (const pi of [0, 1] as const) {
        const pair = state.field[pi];
        if (!pair) continue;
        const cnt = pair.filter((c) => c.color === dom).length;
        if (cnt > bestCnt) {
          bestCnt = cnt;
          bestPair = pi;
        }
      }
      const canDeck = state.deck.length > 0 || state.discardPile.length > 0;
      if (bestPair !== null && (bestCnt > 0 || !canDeck)) {
        return { type: 'DRAW_FROM_FIELD', pairIndex: bestPair };
      }
      if (canDeck) return { type: 'DRAW_FROM_DECK' };
      if (bestPair !== null) return { type: 'DRAW_FROM_FIELD', pairIndex: bestPair };
      return null;
    }
    case 'awaitingPlaceDrawn':
      return bestPlacementFirstAction(state, pid);
    case 'awaitingPlaceAdditionalDraw':
      return bestSingleSlot(state, pid, (slotIndex) => ({ type: 'PLACE_ADDITIONAL_DRAW', slotIndex }));
    case 'awaitingAdditionalActionChoice': {
      const canDiscard = player.board.slots.some((s) => s.stack.length > 0);
      const canDraw = state.deck.length > 0 || state.discardPile.length > 0;
      // 取り除きで連鎖が続くなら取り除き（決定論・フェア）。 続かなければブラインドドローで賭ける。
      if (canDiscard && discardSustains(state, pid)) return { type: 'CHOOSE_ADDITIONAL_DISCARD' };
      if (canDraw) return { type: 'CHOOSE_ADDITIONAL_DRAW' };
      if (canDiscard) return { type: 'CHOOSE_ADDITIONAL_DISCARD' };
      return null;
    }
    case 'awaitingAdditionalDiscard':
      return bestSingleSlot(state, pid, (slotIndex) => ({ type: 'DISCARD_TOP', slotIndex }));
    default:
      return null;
  }
}

/** この状態から自分のターンを「発火を狙って」 貪欲に最後まで打ち、 最終 projectedScore を返す。 */
function firePlayout(state: GameState, pid: number): number {
  let s = state;
  for (let i = 0; i < PLAYOUT_MAX_STEPS; i++) {
    if (s.phase === 'gameOver') break;
    if (!MY_ACTION_PHASES.has(s.phase) || currentActorId(s) !== pid) break;
    const a = greedyFireAction(s, pid);
    if (!a) break;
    const before = s;
    s = stepGame(s, a);
    if (s === before) break;
  }
  return projectedScore(s, pid);
}

/**
 * 「今このターンに発火を狙ったとき」 の統計（山札サンプル）:
 *   p   = 累計が 20 点へ到達する確率
 *   mean = 発火で得られる期待獲得点（点を貯めるべきかの判断に使う）
 */
function fireStats(state: GameState, pid: number): { p: number; mean: number } {
  let hit = 0;
  let sum = 0;
  const startScore = state.players[pid].score;
  for (let k = 0; k < FIRE_SAMPLES; k++) {
    const seed = (state.rngSeed ^ ((k + 1) * 0x9e3779b1)) | 0;
    const finalScore = firePlayout(determinizeDeck(state, seed), pid);
    if (finalScore >= REQUIRED) hit++;
    sum += finalScore - startScore; // 発火による獲得点
  }
  return { p: hit / FIRE_SAMPLES, mean: sum / FIRE_SAMPLES };
}

/**
 * 与えられた状態の自分の盤面について、「自分の手番（awaitingDraw）」 として発火を狙ったときの
 * 期待獲得点（山札サンプル平均）。 積む配置の評価＝「発火得点分布を改善するか」 を測る。
 */
function boardFirePotential(state: GameState, pid: number): number {
  const base: GameState = {
    ...state,
    currentPlayerIndex: pid,
    phase: 'awaitingDraw',
    turn: freshTurnState(),
  };
  let sum = 0;
  for (let k = 0; k < BUILD_SAMPLES; k++) {
    const seed = (state.rngSeed ^ ((k + 11) * 0x85ebca6b)) | 0;
    sum += firePlayout(determinizeDeck(base, seed), pid);
  }
  return sum / BUILD_SAMPLES;
}

// ---- 積む（非発火で連鎖準備度を最大化） ----

/**
 * 積む配置: 手元カードを「発火させずに」 置き、 結果盤面の期待発火得点が最大になる最初の配置手を返す。
 * 評価は boardFirePotential（＝発火得点分布の改善度）。 連鎖準備度のような浅い近似は使わない。
 */
function bestBuildPlacement(state: GameState, pid: number): Action | null {
  const pending = state.turn.pendingDraw;
  if (pending.length === 0) return null;
  const card0 = pending[0];
  const nSlots = state.players[pid].board.slots.length;
  const baseCombo = state.turn.combosThisTurn.length;
  let bestSlot: number | null = null;
  let bestV = -Infinity;
  let fbSlot = 0;
  let fbV = -Infinity;

  for (let slot0 = 0; slot0 < nSlots; slot0++) {
    let ns: GameState;
    try {
      ns = stepGame(state, { type: 'PLACE_DRAWN', cardId: card0.id, slotIndex: slot0 });
    } catch {
      continue;
    }
    if (ns === state) continue;
    const firedNow = ns.turn.combosThisTurn.length > baseCombo;

    if (ns.phase === 'awaitingPlaceDrawn') {
      // 2 枚目も置いてから評価（残り 1 枚）
      const card1 = ns.turn.pendingDraw[0];
      for (let slot1 = 0; slot1 < nSlots; slot1++) {
        let ns2: GameState;
        try {
          ns2 = stepGame(ns, { type: 'PLACE_DRAWN', cardId: card1.id, slotIndex: slot1 });
        } catch {
          continue;
        }
        if (ns2 === ns) continue;
        const fired2 = ns2.turn.combosThisTurn.length > ns.turn.combosThisTurn.length;
        const v = boardFirePotential(ns2, pid);
        if (v > fbV) {
          fbV = v;
          fbSlot = slot0;
        }
        if (!firedNow && !fired2 && v > bestV) {
          bestV = v;
          bestSlot = slot0;
        }
      }
    } else {
      const v = boardFirePotential(ns, pid);
      if (v > fbV) {
        fbV = v;
        fbSlot = slot0;
      }
      if (!firedNow && v > bestV) {
        bestV = v;
        bestSlot = slot0;
      }
    }
  }
  return { type: 'PLACE_DRAWN', cardId: card0.id, slotIndex: bestSlot ?? fbSlot };
}

function buildDrawAction(state: GameState, pid: number): Action | null {
  const dom = dominantNearTopColor(state.players[pid]);
  let bestPair: 0 | 1 | null = null;
  let bestCnt = -1;
  for (const pi of [0, 1] as const) {
    const pair = state.field[pi];
    if (!pair) continue;
    const cnt = pair.filter((c) => c.color === dom).length;
    if (cnt > bestCnt) {
      bestCnt = cnt;
      bestPair = pi;
    }
  }
  const canDeck = state.deck.length > 0 || state.discardPile.length > 0;
  if (bestPair !== null && (bestCnt > 0 || !canDeck)) {
    return { type: 'DRAW_FROM_FIELD', pairIndex: bestPair };
  }
  if (canDeck) return { type: 'DRAW_FROM_DECK' };
  if (bestPair !== null) return { type: 'DRAW_FROM_FIELD', pairIndex: bestPair };
  return null;
}

// ---- ギフト ----

function buildGiftAssignments(state: GameState, pid: number): GiftAssignment[] {
  const queue = state.turn.giftQueue;
  const opponents = state.players.filter((p) => p.id !== pid);
  if (opponents.length === 0) return [];
  const leader = opponents.reduce((m, c) => (c.score > m.score ? c : m), opponents[0]);
  return queue.map((combo, comboIndex) => ({
    comboIndex,
    cardId: combo.cards[0].id,
    targetPlayerId: leader.id,
  }));
}

/** デバッグ用: 今このターンに発火を狙ったときの得点サンプル列（山札 n 通り）。 */
export function __debugFireSamples(state: GameState, pid: number, n: number): number[] {
  const base: GameState = {
    ...state,
    currentPlayerIndex: pid,
    phase: 'awaitingDraw',
    turn: freshTurnState(),
  };
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    out.push(firePlayout(determinizeDeck(base, (state.rngSeed ^ ((k + 1) * 0x9e3779b1)) | 0), pid));
  }
  return out;
}

export function decideAction(state: GameState, playerId: number, _seed?: number): Action | null {
  void _seed;

  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== playerId) return null;
    return { type: 'CONFIRM_GIFTS', assignments: buildGiftAssignments(state, playerId) };
  }

  const isGiftPlacementActor =
    state.phase === 'awaitingGiftPlacement' &&
    state.turn.pendingGiftBatches[0]?.recipientId === playerId;
  if (isGiftPlacementActor) {
    const batch = state.turn.pendingGiftBatches[0];
    const card = batch.cards[0];
    return (
      bestSingleSlot(state, playerId, (slotIndex) => ({ type: 'PLACE_GIFT', cardId: card.id, slotIndex })) ?? {
        type: 'PLACE_GIFT',
        cardId: card.id,
        slotIndex: 0,
      }
    );
  }

  if (state.currentPlayerIndex !== playerId) return null;
  if (!MY_ACTION_PHASES.has(state.phase)) return null;

  // 発火進行中はそのまま貪欲に連鎖を回しきる
  if (state.turn.combosThisTurn.length > 0) {
    return greedyFireAction(state, playerId);
  }

  // 発火 / 積む の判断は「手札を無視した盤面ポテンシャル」 基準で行う。
  // 盤面はドロー〜配置直前まで不変なので、 awaitingDraw と awaitingPlaceDrawn で
  // 同じ判断になり、 ターン内で揺れない（ドローした 2 枚で再評価して翻意する不整合を防ぐ）。
  const base: GameState = {
    ...state,
    currentPlayerIndex: playerId,
    phase: 'awaitingDraw',
    turn: freshTurnState(),
  };
  const { p, mean } = fireStats(base, playerId);
  const score = state.players[playerId].score;
  const thr = fireThreshold(maxOpponentScore(state, playerId));
  // 発火条件:
  //  (1) 累計 20 到達確率が閾値超 ＝ 仕上げ。
  //  (2) 期待獲得点が「残り点数の相応割合」 を超える ＝ 大連鎖を貯金（単発で 20 に届かなくても
  //      点を確定させ、 残り点数を減らして次の発火を容易にする）。 死蔵デッドロックを破る。
  const bankNeed = Math.max(6, 0.5 * (REQUIRED - score));
  const fire = p >= thr || mean >= bankNeed;

  if (state.phase === 'awaitingDraw') {
    return fire ? greedyFireAction(state, playerId) : buildDrawAction(state, playerId);
  }
  if (state.phase === 'awaitingPlaceDrawn') {
    return fire ? bestPlacementFirstAction(state, playerId) : bestBuildPlacement(state, playerId);
  }
  return greedyFireAction(state, playerId);
}
