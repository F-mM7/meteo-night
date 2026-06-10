/**
 * GRM（目標到達確率最大化法）の内側関数 `f` の実装。
 *
 * `f(S, V) = max_π P_π( このターンの得点 ≥ V | 発火状態 S から連鎖開始 )`
 *
 * 発火後の連鎖サブゲームを確率付き後退帰納（DP）で **厳密に** 解く。設計は
 * `ai/REACHABILITY.md` の §1.3（ドロー確率）/ §3（得点）/ §4（サブゲームと f）に準拠。
 *
 * 重要な力学（`reducer.ts: resolveChainStep` と完全一致させる）:
 *  1. 解決: 最上段の同色3枚以上を全色同時に検出・除去（`resolveCombosAtBoard` を再利用）。
 *  2. コンボが出たら必ず「追加アクション選択」へ進む（自動連鎖はしない）。プレイヤーは
 *     「削除（最上段1枚を捨札へ）」か「ドロー&配置（山札1枚を引いて積む）」のどちらかを取る。
 *  3. 配置/削除後に再び 1. へ。新たな発火が無ければ得点確定（終端）。
 *
 * ランダム性はドローの色のみ。山札の色分布からの非復元抽出（超幾何）で厳密に期待値を取る。
 * 山札が尽きると捨札がリシャッフルされて山札になるため、DP 状態は山札と捨札の色分布の
 * 両方を持つ（§1.3 / §4.2）。
 *
 * 後退帰納は2種のノードに分かれる（エンジンと対応）:
 *  - 解決ノード `resolveValue` ＝ `resolveChainStep`（盤面を解決→終端 or 追加アクション選択へ）。
 *  - 決定ノード `decideValue` ＝ `awaitingAdditionalActionChoice`（削除/ドローを選ぶ局面）。
 * これらは `createChainSolver` で公開し、`f` 本体のほか GRM 本体（連鎖中の最適手）でも再利用する。
 */
import type { Card, Color, GameState, PlayerBoard } from '../game/types';
import { COLORS } from '../game/types';
import { resolveCombosAtBoard } from '../game/engine';
import { comboCountBonus } from '../game/scoring';

/** 色別枚数。全色をキーに持つ（欠損は 0）。 */
export type ColorCounts = Record<Color, number>;

export interface SubgameInput {
  /** 各スロットのスタック（下→上、配列末尾が最上段）。通常 5 スロット。 */
  slots: Color[][];
  /** 山札の色別枚数。 */
  deck: ColorCounts;
  /** 捨札の色別枚数。 */
  discard: ColorCounts;
}

export interface ReachFOptions {
  /**
   * 各スロットを上から K 枚で切り詰めて状態表現とする（§2.1, 既定 7）。
   * K より下層は当ターンの勝敗に寄与しないとみなして捨象する。
   */
  K?: number;
  /**
   * 後退帰納で展開するノード数の上限。超過したら **黙って打ち切らず例外を投げる**（§8-3）。
   * 既定は十分大きく、テスト規模では到達しない。実運用で K・枝刈りを詰める際に調整する。
   */
  maxNodes?: number;
}

const DEFAULT_K = 7;
const DEFAULT_MAX_NODES = 5_000_000;
/** §1.3: 各色は 24 枚固定（5 色 × 24 = 120）。`setup.ts: DEFAULT_CARDS_PER_COLOR` と一致。 */
export const CARDS_PER_COLOR = 24;

const COLOR_IDX: Record<Color, string> = COLORS.reduce((m, c, i) => {
  m[c] = String(i);
  return m;
}, {} as Record<Color, string>);

// ---------------------------------------------------------------------------
// 色別枚数ユーティリティ
// ---------------------------------------------------------------------------

export function emptyCounts(): ColorCounts {
  const out = {} as ColorCounts;
  for (const c of COLORS) out[c] = 0;
  return out;
}

/** 部分指定の色別枚数を、全色キーを持つ正規形に整える。 */
export function normalizeCounts(c: Partial<Record<Color, number>>): ColorCounts {
  const out = emptyCounts();
  for (const color of COLORS) out[color] = c[color] ?? 0;
  return out;
}

export function totalCount(c: ColorCounts): number {
  let n = 0;
  for (const color of COLORS) n += c[color];
  return n;
}

/** 色 `color` の枚数を `delta` だけ変えた新しい色別枚数を返す。 */
export function addCount(c: ColorCounts, color: Color, delta: number): ColorCounts {
  const out = { ...c };
  out[color] += delta;
  return out;
}

/** カード列の色別枚数。 */
export function colorCounts(cards: readonly { color: Color }[]): ColorCounts {
  const out = emptyCounts();
  for (const card of cards) out[card.color] += 1;
  return out;
}

/** 色の配列から色別枚数を作る（テスト用ヘルパ）。 */
export function colorCountsFromColors(colors: readonly Color[]): ColorCounts {
  const out = emptyCounts();
  for (const c of colors) out[c] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// 盤面ユーティリティ
// ---------------------------------------------------------------------------

/** 色スタックを `PlayerBoard` に変換（エンジンの検出/除去ロジックを再利用するため）。 */
function colorsToBoard(slots: Color[][]): PlayerBoard {
  return {
    slots: slots.map((stack, si) => ({
      stack: stack.map((color, di): Card => ({ id: `s${si}d${di}-${color}`, color })),
    })),
  };
}

function boardToColors(board: PlayerBoard): Color[][] {
  return board.slots.map((s) => s.stack.map((c) => c.color));
}

/** スタックを上から K 枚に切り詰める（下層＝先頭側を捨象）。 */
export function truncTop(stack: Color[], K: number): Color[] {
  if (stack.length <= K) return stack;
  return stack.slice(stack.length - K);
}

/** スロット集合の `slotIndex` に `color` を積み、上から K 枚に切り詰めた新しいスロット集合を返す。 */
export function placeColorOnSlots(slots: Color[][], slotIndex: number, color: Color, K: number): Color[][] {
  return slots.map((s, idx) => (idx === slotIndex ? truncTop([...s, color], K) : s));
}

/**
 * 発火判定（`detectCombos` と同じく最上段の同色 3 枚以上）。
 * 位相 t = own はサブゲーム（自手番の連鎖）前提なので色配置のみで判定する。
 */
export function fireSlots(slots: readonly (readonly Color[])[]): boolean {
  const counts = new Map<Color, number>();
  for (const st of slots) {
    const top = st[st.length - 1];
    if (top === undefined) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  for (const v of counts.values()) if (v >= 3) return true;
  return false;
}

function makeKey(
  slots: Color[][],
  comboCount: number,
  baseSoFar: number,
  deck: ColorCounts,
  discard: ColorCounts
): string {
  const s = slots.map((st) => st.map((c) => COLOR_IDX[c]).join('')).join('|');
  const d = COLORS.map((c) => deck[c]).join(',');
  const dd = COLORS.map((c) => discard[c]).join(',');
  return `${s}#${comboCount}#${baseSoFar}#${d}#${dd}`;
}

// ---------------------------------------------------------------------------
// 連鎖サブゲームのソルバ（f 本体 + GRM の連鎖中プレイで再利用）
// ---------------------------------------------------------------------------

/** 決定ノードでの最適アクション。 */
export type ChainDecision =
  | { kind: 'draw' }
  | { kind: 'discard'; slot: number }
  | { kind: 'terminal' };

export interface ChainSolver {
  /** 解決ノード: 盤面をまず解決し、終端 or 追加アクション選択へ進む（= resolveChainStep）。 */
  resolveValue(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts): number;
  /** 決定ノード: 盤面は解決済みの前提で、追加アクション局面の最適値（= awaitingAdditionalActionChoice）。 */
  decideValue(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts): number;
  /** 決定ノードでの最適アクション（削除どのスロット / ドロー）。 */
  bestDecision(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts): ChainDecision;
  /** 引いた 1 枚 `color` を最適スロットへ置く（追加ドロー配置局面の最適スロット）。 */
  bestPlacementSlot(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts, color: Color): number;
  /** 削除局面で取り除く最適スロット。 */
  bestDiscardSlot(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts): number;
  /** 展開したノード数（デバッグ・性能計測用）。 */
  nodesUsed(): number;
}

/**
 * 目標点 `V` に対する連鎖サブゲームのソルバを作る。内部にメモ化を持つ。
 * 得点は単調非減少なので、累計が V 以上になった時点で確率 1 に短絡する。
 */
export function createChainSolver(V: number, K = DEFAULT_K, maxNodes = DEFAULT_MAX_NODES): ChainSolver {
  const memo = new Map<string, number>();
  let nodes = 0;
  let depth = 0; // 公開メソッドの再帰深さ。最上位(=外部からの 1 回の f 評価)でノード予算をリセットする。

  function guard(): void {
    if (++nodes > maxNodes) {
      throw new Error(
        `createChainSolver: 1 回の f 評価の展開ノード数が上限 ${maxNodes} を超過（K=${K}, V=${V}）。` +
          `黙って打ち切らず例外で通知（§8-3）。K の縮小か枝刈りの導入が必要。`
      );
    }
  }

  // 公開メソッドの最上位呼び出しごとにノード予算をリセットする。上限は「1 回の f 評価の暴走」を捉えるための
  // もので、メモを共有したまま多数の f 評価を回すと累積して誤発火するため（内部再帰では維持＝リセットしない）。
  function topLevel<T>(fn: () => T): T {
    if (depth === 0) nodes = 0;
    depth++;
    try {
      return fn();
    } finally {
      depth--;
    }
  }

  function resolveValue(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts
  ): number {
    if (base + comboCountBonus(cc) >= V) return 1;
    const key = `R${makeKey(slots, cc, base, deck, discard)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    guard();

    const { newBoard, combos } = resolveCombosAtBoard(colorsToBoard(slots));
    if (combos.length === 0) {
      const res = base + comboCountBonus(cc) >= V ? 1 : 0;
      memo.set(key, res);
      return res;
    }
    const newCc = cc + combos.length;
    const newBase = base + combos.reduce((s, c) => s + c.basePoints, 0);
    if (newBase + comboCountBonus(newCc) >= V) {
      memo.set(key, 1);
      return 1;
    }
    const res = decideValue(boardToColors(newBoard), newCc, newBase, deck, discard);
    memo.set(key, res);
    return res;
  }

  function decideValue(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts
  ): number {
    if (base + comboCountBonus(cc) >= V) return 1;
    const key = `D${makeKey(slots, cc, base, deck, discard)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    guard();

    const deckTotal = totalCount(deck);
    const discardTotal = totalCount(discard);
    const canDraw = deckTotal > 0 || discardTotal > 0;
    const canDiscard = slots.some((s) => s.length > 0);
    if (!canDraw && !canDiscard) {
      const res = base + comboCountBonus(cc) >= V ? 1 : 0;
      memo.set(key, res);
      return res;
    }

    let best = 0;
    if (canDiscard) {
      for (let j = 0; j < slots.length && best < 1; j++) {
        const st = slots[j];
        if (st.length === 0) continue;
        const removed = st[st.length - 1];
        const childSlots = slots.map((s, idx) => (idx === j ? s.slice(0, -1) : s));
        const v = resolveValue(childSlots, cc, base, deck, addCount(discard, removed, 1));
        if (v > best) best = v;
      }
    }
    if (best < 1 && canDraw) {
      const v = drawExpectation(slots, cc, base, deck, discard, deckTotal, discardTotal);
      if (v > best) best = v;
    }
    memo.set(key, best);
    return best;
  }

  /** ドロー（1 枚）の期待値。山札が空なら捨札をリシャッフルしたプールから引く（§1.3）。 */
  function drawExpectation(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts,
    deckTotal: number,
    discardTotal: number
  ): number {
    let sum = 0;
    if (deckTotal > 0) {
      for (const color of COLORS) {
        const n = deck[color];
        if (n <= 0) continue;
        sum += (n / deckTotal) * placeBest(slots, color, cc, base, addCount(deck, color, -1), discard);
      }
    } else {
      // 山札空 → 捨札が新しい山札になる
      for (const color of COLORS) {
        const n = discard[color];
        if (n <= 0) continue;
        sum += (n / discardTotal) * placeBest(slots, color, cc, base, addCount(discard, color, -1), emptyCounts());
      }
    }
    return sum;
  }

  /** 引いた `color` を最良スロットへ置いたときの値（max_d）。 */
  function placeBest(
    slots: Color[][],
    color: Color,
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts
  ): number {
    let best = 0;
    for (let j = 0; j < slots.length && best < 1; j++) {
      const v = resolveValue(placeColorOnSlots(slots, j, color, K), cc, base, deck, discard);
      if (v > best) best = v;
    }
    return best;
  }

  function bestDecision(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts
  ): ChainDecision {
    const deckTotal = totalCount(deck);
    const discardTotal = totalCount(discard);
    const canDraw = deckTotal > 0 || discardTotal > 0;
    const canDiscard = slots.some((s) => s.length > 0);
    if (!canDraw && !canDiscard) return { kind: 'terminal' };

    let discardBestVal = -1;
    let discardBestSlot = -1;
    if (canDiscard) {
      for (let j = 0; j < slots.length; j++) {
        const st = slots[j];
        if (st.length === 0) continue;
        const removed = st[st.length - 1];
        const childSlots = slots.map((s, idx) => (idx === j ? s.slice(0, -1) : s));
        const v = resolveValue(childSlots, cc, base, deck, addCount(discard, removed, 1));
        if (v > discardBestVal) {
          discardBestVal = v;
          discardBestSlot = j;
        }
      }
    }
    const drawVal = canDraw
      ? drawExpectation(slots, cc, base, deck, discard, deckTotal, discardTotal)
      : -1;

    // 値が高い方を選ぶ。同値は削除を優先（山札を温存）。
    if (drawVal > discardBestVal) return { kind: 'draw' };
    if (discardBestSlot >= 0) return { kind: 'discard', slot: discardBestSlot };
    return { kind: 'draw' };
  }

  function bestPlacementSlot(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts,
    color: Color
  ): number {
    let bestVal = -1;
    let bestSlot = 0;
    for (let j = 0; j < slots.length; j++) {
      const v = resolveValue(placeColorOnSlots(slots, j, color, K), cc, base, deck, discard);
      if (v > bestVal) {
        bestVal = v;
        bestSlot = j;
      }
    }
    return bestSlot;
  }

  function bestDiscardSlot(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts
  ): number {
    let bestVal = -1;
    let bestSlot = -1;
    for (let j = 0; j < slots.length; j++) {
      const st = slots[j];
      if (st.length === 0) continue;
      const removed = st[st.length - 1];
      const childSlots = slots.map((s, idx) => (idx === j ? s.slice(0, -1) : s));
      const v = resolveValue(childSlots, cc, base, deck, addCount(discard, removed, 1));
      if (v > bestVal) {
        bestVal = v;
        bestSlot = j;
      }
    }
    // 取り除けるスロットが無い場合は 0 を返す（呼び出し側が合法性を担保する）。
    return bestSlot >= 0 ? bestSlot : 0;
  }

  // 公開メソッドはそれぞれ最上位呼び出しでノード予算をリセットしてから内部関数へ委譲する
  // （内部の相互再帰は元の関数を直接呼ぶのでリセットされない）。
  return {
    resolveValue: (slots, cc, base, deck, discard) => topLevel(() => resolveValue(slots, cc, base, deck, discard)),
    decideValue: (slots, cc, base, deck, discard) => topLevel(() => decideValue(slots, cc, base, deck, discard)),
    bestDecision: (slots, cc, base, deck, discard) => topLevel(() => bestDecision(slots, cc, base, deck, discard)),
    bestPlacementSlot: (slots, cc, base, deck, discard, color) =>
      topLevel(() => bestPlacementSlot(slots, cc, base, deck, discard, color)),
    bestDiscardSlot: (slots, cc, base, deck, discard) => topLevel(() => bestDiscardSlot(slots, cc, base, deck, discard)),
    nodesUsed: () => nodes,
  };
}

// ---------------------------------------------------------------------------
// f 本体
// ---------------------------------------------------------------------------

/**
 * GRM 内側関数 `f`。発火状態から最適連鎖で「ターン得点 ≥ V」となる最大確率を返す。
 *
 * @throws 入力が発火状態でない場合（§4 は fire(S)=true を前提とする）。
 */
export function reachF(input: SubgameInput, V: number, opts: ReachFOptions = {}): number {
  const K = opts.K ?? DEFAULT_K;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const slots0 = input.slots.map((s) => truncTop(s.slice(), K));
  const deck0 = normalizeCounts(input.deck);
  const discard0 = normalizeCounts(input.discard);

  if (!Number.isFinite(V)) {
    throw new Error('reachF: V は有限の数値でなければならない');
  }
  if (!fireSlots(slots0)) {
    throw new Error('reachF: 入力は発火状態（最上段に同色 3 枚以上）でなければならない（§4 は fire(S)=true 前提）');
  }

  return createChainSolver(V, K, maxNodes).resolveValue(slots0, 0, 0, deck0, discard0);
}

// ---------------------------------------------------------------------------
// GameState からの入力組み立て
// ---------------------------------------------------------------------------

/**
 * 実際の山札・捨札が分かっている状況（テスト・自己対戦シミュレーション）で、
 * `GameState` から `f` の入力を直接組み立てる。山札の色分布は `state.deck` を実数えする。
 */
export function subgameInputFromState(state: GameState, playerId: number): SubgameInput {
  const player = state.players[playerId];
  if (!player) throw new Error(`subgameInputFromState: playerId ${playerId} が存在しない`);
  return {
    slots: player.board.slots.map((s) => s.stack.map((c) => c.color)),
    deck: colorCounts(state.deck),
    discard: colorCounts(state.discardPile),
  };
}

/**
 * §1.3 の逆算で山札の色分布を求める（手番プレイヤー視点で山札の中身が不可視な実運用向け）。
 *
 *   deckCount(c) = 24 − (全ボードの c) − (場の c) − (捨札の c)
 *                     − (保留カードの c) − (連鎖中に除去済み・未処理の c)
 *
 * 「連鎖中に除去済み・未処理」は当ターンに発火で盤面から除いたがまだ捨札/プレゼント処理
 * されていない分（`turn.combosThisTurn` 等）。`f` のサブゲーム中はこれらも山札に存在しない。
 * 連鎖の途中（finalize 前）の状態を前提とする。
 */
export function reconstructDeckCounts(
  state: GameState,
  cardsPerColor: number = CARDS_PER_COLOR
): ColorCounts {
  const out = emptyCounts();
  for (const c of COLORS) out[c] = cardsPerColor;

  const sub = (color: Color) => {
    out[color] -= 1;
  };

  for (const p of state.players) {
    for (const slot of p.board.slots) {
      for (const card of slot.stack) sub(card.color);
    }
  }
  for (const pair of state.field) {
    if (pair) {
      sub(pair[0].color);
      sub(pair[1].color);
    }
  }
  for (const card of state.discardPile) sub(card.color);
  for (const card of state.turn.pendingDraw) sub(card.color);
  if (state.turn.pendingAdditionalDraw) sub(state.turn.pendingAdditionalDraw.color);
  // 連鎖中に除去済み・未処理（finalize 前は combosThisTurn が保持。giftQueue /
  // pendingGiftBatches は finalize 後にのみ値を持つので二重計上を避けるため通常は空）。
  for (const combo of state.turn.combosThisTurn) {
    for (const card of combo.cards) sub(card.color);
  }
  for (const combo of state.turn.giftQueue) {
    for (const card of combo.cards) sub(card.color);
  }
  for (const batch of state.turn.pendingGiftBatches) {
    for (const card of batch.cards) sub(card.color);
  }

  return out;
}

/**
 * 発火状態の `GameState`（自手番の連鎖開始局面）に対して `f(S, V)` を計算する便利関数。
 * 山札は実数え（`subgameInputFromState`）を使う。
 */
export function reachFFromState(
  state: GameState,
  V: number,
  playerId: number,
  opts: ReachFOptions = {}
): number {
  return reachF(subgameInputFromState(state, playerId), V, opts);
}
