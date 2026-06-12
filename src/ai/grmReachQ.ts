/**
 * GRM（目標到達確率最大化法）の内側関数 `q` の実装。
 *
 * `q(S, V) = max_π P_π( このターンの得点 ≥ V | 発火状態 S から連鎖開始 )`
 *
 * 発火後の連鎖サブゲームを確率付き後退帰納（DP）で **厳密に** 解く。設計は
 * `ai/REACHABILITY.md` の §1.3（ドロー確率）/ §3（得点）/ §4（サブゲームと q）に準拠。
 *
 * 重要な力学（`reducer.ts: resolveChainStep` と完全一致させる）:
 *  1. 解決: 最上段の同色3枚以上を全色同時に検出・除去（`resolveCombosColors`＝エンジンの
 *     `resolveCombosAtBoard` と同値の Color[][] 直実装。同値性はファズ＋全着手一致で担保）。
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
 * これらは `createChainSolver` で公開し、`q` 本体のほか GRM 本体（連鎖中の最適手）でも再利用する。
 */
import type { Color, GameState } from '../game/types';
import { COLORS } from '../game/types';
import { comboCountBonus, basePointsForSize } from '../game/scoring';

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

export interface ReachQOptions {
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

// ---------------------------------------------------------------------------
// memo キーのビットパック（SPEED-PLAN 手法 2: キー構築・ハッシュ・メモリの定数倍削減）
// ---------------------------------------------------------------------------
// JS 文字列は UTF-16 コード単位の列なので、16bit 整数をそのまま 1 文字に詰められる（Map のキー比較は
// コード単位一致＝不対サロゲートでも問題ない）。旧キーは色数字 join + 区切りの連結（盤面・山札・捨札で
// ~45-60 文字・中間配列を多数生成）だったのに対し、パック後は典型 ~16 文字・単一パスで構築する。
// **実ゲームの盤面スタックは K を超えて任意長になりうる**（K 切り詰めは AI 内部展開の状態表現のみ。
// 固定長前提の初版パックは実対局 5 局目で長さ 8 に当たり即例外＝可変長へ再設計した経緯あり）。

const COLOR_NUM: Record<Color, number> = COLORS.reduce((m, c, i) => {
  m[c] = i;
  return m;
}, {} as Record<Color, number>);

/**
 * スタック 1 本を可変長で単射パックする: 先頭 1 文字＝長さ、続いて下から 6 枚ごとに base-5 で
 * 1 文字（5^6 = 15625 < 2^16）。長さプレフィクスで自己区切りになるため、複数スタックを連結しても
 * 単射性が保たれる。空きスタックは 1 文字。
 */
export function packStack(st: readonly Color[]): string {
  const codes: number[] = [st.length];
  for (let i = 0; i < st.length; i += 6) {
    let v = 0;
    let mul = 1;
    const end = Math.min(i + 6, st.length);
    for (let k = i; k < end; k++) {
      v += COLOR_NUM[st[k]] * mul;
      mul *= 5;
    }
    codes.push(v);
  }
  return String.fromCharCode(...codes);
}

/** 盤面（スロット列・各スタック任意長）を単射パックする（自己区切りな packStack の連結）。 */
export function packSlots(slots: readonly (readonly Color[])[]): string {
  let out = '';
  for (let j = 0; j < slots.length; j++) out += packStack(slots[j]);
  return out;
}

/** 色別枚数（各色 ≤24 ＝ 5bit に収まる、§1.3）を 2 文字に単射パックする。 */
export function packCounts(c: ColorCounts): string {
  return String.fromCharCode(
    (c[COLORS[0]] << 10) | (c[COLORS[1]] << 5) | c[COLORS[2]],
    (c[COLORS[3]] << 5) | c[COLORS[4]]
  );
}

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

/**
 * 連鎖解決を Color[][] のまま直接行う（`engine.resolveCombosAtBoard` と同値。SPEED-PLAN 手法 7）。
 * 検出＝最上段の同色 3 枚以上（全色同時）・除去＝該当スロットの最上段 1 枚・基礎点＝`basePointsForSize`。
 * 旧実装は解決ノードごとに `colorsToBoard`（Card オブジェクト盤面の生成）→ エンジン関数 → 逆変換を
 * 行っており、P=0.45 病的シャードの生体スタックサンプリングで最内ループの定数倍コストとして顕在化した。
 * 同値性は engine 経路との全数比較ファズ＋既存の q 厳密値テスト＋全着手一致で担保する。
 */
export function resolveCombosColors(slots: Color[][]): {
  newSlots: Color[][];
  comboCount: number;
  basePoints: number;
} {
  let comboCount = 0;
  let basePoints = 0;
  let fireMask: boolean[] | null = null;
  const topSlots = new Map<Color, number[]>();
  for (let j = 0; j < slots.length; j++) {
    const st = slots[j];
    const top = st[st.length - 1];
    if (top === undefined) continue;
    const arr = topSlots.get(top);
    if (arr) arr.push(j);
    else topSlots.set(top, [j]);
  }
  for (const idxs of topSlots.values()) {
    if (idxs.length >= 3) {
      comboCount += 1;
      basePoints += basePointsForSize(idxs.length);
      if (!fireMask) fireMask = new Array<boolean>(slots.length).fill(false);
      for (const j of idxs) fireMask[j] = true;
    }
  }
  if (!fireMask) return { newSlots: slots, comboCount: 0, basePoints: 0 };
  const mask = fireMask;
  return {
    newSlots: slots.map((st, j) => (mask[j] ? st.slice(0, -1) : st)),
    comboCount,
    basePoints,
  };
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
  // comboCount は 1 ターンの発火本数（1 解決につき高々 1 コンボ）・baseSoFar は基礎点の累計（≥V で
  // 短絡するため高々 V+最大コンボ点）でどちらも 16bit に余裕で収まる＝1 文字ずつ。全体 12 文字の単射キー。
  return packSlots(slots) + packCounts(deck) + packCounts(discard) + String.fromCharCode(comboCount, baseSoFar);
}

// ---------------------------------------------------------------------------
// 連鎖サブゲームのソルバ（q 本体 + GRM の連鎖中プレイで再利用）
// ---------------------------------------------------------------------------

/** reachesAtLeastBounded のノード上限到達を通知する内部センチネル。 */
class QueryCapExceeded extends Error {}

/** 決定ノードでの最適アクション。 */
export type ChainDecision =
  | { kind: 'draw' }
  | { kind: 'discard'; slot: number }
  | { kind: 'terminal' };

export interface ChainSolver {
  /** 解決ノード: 盤面をまず解決し、終端 or 追加アクション選択へ進む（= resolveChainStep）。 */
  resolveValue(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts): number;
  /**
   * 「resolveValue ≥ P か」だけを返す閾値判定（branch-and-bound）。確率の上下界で真偽が確定した時点で
   * 打ち切るため、厳密値を最後まで解くより大幅に速い。結果は `resolveValue(...) >= P` と完全一致する
   * （境界 P ちょうども含む）。GRM の G 判定（q≥P の真偽だけが必要な箇所）専用の高速経路。
   */
  reachesAtLeast(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts, P: number): boolean;
  /**
   * reachesAtLeast のノード上限つき版。境界的な盤面では真偽確定までの探索が数秒級になりうるため、
   * 解析推定のプローブ等「個々の判定の厳密さより呼び出し回数と有界性が重要な箇所」用に、
   * `nodeCap` ノードで打ち切って **null（未確定）** を返す。例外は投げない（呼び出し側が設計された
   * 既定値に倒す）。確定した場合の真偽は reachesAtLeast と同一。
   */
  reachesAtLeastBounded(slots: Color[][], comboCount: number, baseSoFar: number, deck: ColorCounts, discard: ColorCounts, P: number, nodeCap: number): boolean | null;
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
  // 閾値判定（reachesAtLeast）が得た部分情報（真値の区間 [lo, hi]）の memo。厳密値が出た場合は memo 側へ。
  const bmemo = new Map<string, { lo: number; hi: number }>();
  // ソルバ生涯（=1 decideAction）で q 評価をまたいで共有する memo の上限。無制限だと重い決定局面で
  // GB 級に成長しヒープが枯渇する（長時間ベンチで OOM 実測）。クリアは topLevel の評価間でのみ行い、
  // 評価中の再計算でノード予算 guard を誤超過させない。純メモ化なので結果は不変。
  const MEMO_CAP = 1_500_000;
  let nodes = 0;
  let depth = 0; // 公開メソッドの再帰深さ。最上位(=外部からの 1 回の q 評価)でノード予算をリセットする。
  let queryCap = Infinity; // reachesAtLeastBounded の 1 判定あたりノード上限（guard が参照）。

  function guard(): void {
    ++nodes;
    if (nodes > queryCap) throw new QueryCapExceeded(); // bounded 判定の打ち切り（呼び出し側が null 既定に倒す）
    if (nodes > maxNodes) {
      throw new Error(
        `createChainSolver: 1 回の q 評価の展開ノード数が上限 ${maxNodes} を超過（K=${K}, V=${V}）。` +
          `黙って打ち切らず例外で通知（§8-3）。K の縮小か枝刈りの導入が必要。`
      );
    }
  }

  // 公開メソッドの最上位呼び出しごとにノード予算をリセットする。上限は「1 回の q 評価の暴走」を捉えるための
  // もので、メモを共有したまま多数の q 評価を回すと累積して誤発火するため（内部再帰では維持＝リセットしない）。
  function topLevel<T>(fn: () => T): T {
    if (depth === 0) {
      nodes = 0;
      if (memo.size + bmemo.size >= MEMO_CAP) {
        memo.clear();
        bmemo.clear();
      }
    }
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

    const { newSlots, comboCount, basePoints } = resolveCombosColors(slots);
    if (comboCount === 0) {
      const res = base + comboCountBonus(cc) >= V ? 1 : 0;
      memo.set(key, res);
      return res;
    }
    const newCc = cc + comboCount;
    const newBase = base + basePoints;
    if (newBase + comboCountBonus(newCc) >= V) {
      memo.set(key, 1);
      return 1;
    }
    const res = decideValue(newSlots, newCc, newBase, deck, discard);
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

  // -------------------------------------------------------------------------
  // 閾値判定（reachesAtLeast）用の区間付き後退帰納（branch-and-bound）
  //
  // 各関数は真値 V* に対し lo ≤ V* ≤ hi の区間を返す。窓 (a, b)（a ≤ b）の契約:
  //   返り値は「hi < a」（V* < a 確定）か「lo ≥ b」（V* ≥ b 確定）か「lo === hi」（厳密値）を満たす。
  // max ノードは子で b に達した時点で打ち切り、chance ノードは「評価済みの下界和 ≥ b」または
  // 「上界和（未評価は 1 扱い）< a」で打ち切る。打ち切りが発生しなかった場合は厳密値に一致する
  // （和の累積順も drawExpectation と同一にして、ビット同一の値を memo に共有する）。
  // -------------------------------------------------------------------------

  interface Bounds {
    lo: number;
    hi: number;
  }

  function storeBounds(key: string, r: Bounds): void {
    if (r.lo === r.hi) {
      memo.set(key, r.lo);
      bmemo.delete(key);
      return;
    }
    const cur = bmemo.get(key);
    if (cur) {
      if (r.lo > cur.lo) cur.lo = r.lo;
      if (r.hi < cur.hi) cur.hi = r.hi;
    } else {
      bmemo.set(key, { lo: r.lo, hi: r.hi });
    }
  }

  function bResolve(slots: Color[][], cc: number, base: number, deck: ColorCounts, discard: ColorCounts, a: number, b: number): Bounds {
    if (base + comboCountBonus(cc) >= V) return { lo: 1, hi: 1 };
    const key = `R${makeKey(slots, cc, base, deck, discard)}`;
    const ex = memo.get(key);
    if (ex !== undefined) return { lo: ex, hi: ex };
    const bm = bmemo.get(key);
    if (bm && (bm.lo >= b || bm.hi < a)) return { lo: bm.lo, hi: bm.hi };
    guard();

    const { newSlots, comboCount, basePoints } = resolveCombosColors(slots);
    if (comboCount === 0) {
      const res = base + comboCountBonus(cc) >= V ? 1 : 0;
      memo.set(key, res);
      return { lo: res, hi: res };
    }
    const newCc = cc + comboCount;
    const newBase = base + basePoints;
    if (newBase + comboCountBonus(newCc) >= V) {
      memo.set(key, 1);
      return { lo: 1, hi: 1 };
    }
    const r = bDecide(newSlots, newCc, newBase, deck, discard, a, b);
    storeBounds(key, r);
    return r;
  }

  function bDecide(slots: Color[][], cc: number, base: number, deck: ColorCounts, discard: ColorCounts, a: number, b: number): Bounds {
    if (base + comboCountBonus(cc) >= V) return { lo: 1, hi: 1 };
    const key = `D${makeKey(slots, cc, base, deck, discard)}`;
    const ex = memo.get(key);
    if (ex !== undefined) return { lo: ex, hi: ex };
    const bm = bmemo.get(key);
    if (bm && (bm.lo >= b || bm.hi < a)) return { lo: bm.lo, hi: bm.hi };
    guard();

    const deckTotal = totalCount(deck);
    const discardTotal = totalCount(discard);
    const canDraw = deckTotal > 0 || discardTotal > 0;
    const canDiscard = slots.some((s) => s.length > 0);
    if (!canDraw && !canDiscard) {
      const res = base + comboCountBonus(cc) >= V ? 1 : 0;
      memo.set(key, res);
      return { lo: res, hi: res };
    }

    // max ノード。子の順序は decideValue と同一（削除ループ → ドロー）。
    let doneLo = 0;
    let doneHi = 0;
    if (canDiscard) {
      for (let j = 0; j < slots.length; j++) {
        const st = slots[j];
        if (st.length === 0) continue;
        const removed = st[st.length - 1];
        const childSlots = slots.map((s, idx) => (idx === j ? s.slice(0, -1) : s));
        const r = bResolve(childSlots, cc, base, deck, addCount(discard, removed, 1), Math.max(a, doneLo), b);
        if (r.lo > doneLo) doneLo = r.lo;
        if (r.hi > doneHi) doneHi = r.hi;
        if (doneLo >= b) {
          const out = { lo: doneLo, hi: 1 };
          storeBounds(key, out);
          return out;
        }
      }
    }
    if (canDraw) {
      const r = bDraw(slots, cc, base, deck, discard, deckTotal, discardTotal, Math.max(a, doneLo), b);
      if (r.lo > doneLo) doneLo = r.lo;
      if (r.hi > doneHi) doneHi = r.hi;
      if (doneLo >= b) {
        const out = { lo: doneLo, hi: 1 };
        storeBounds(key, out);
        return out;
      }
    }
    // 打ち切り無しで完走: 上界に寄与した certificate 子は contract 上 max(a, 当時のdoneLo) 未満なので
    // max を変えられない＝寄与最大の子が厳密なら厳密値。さもなくば全体が a 未満の certificate。
    const out = { lo: doneLo, hi: doneHi };
    if (out.lo !== out.hi && !(out.hi < a)) {
      // 契約上到達しない（防御）: 厳密側で解き直す。
      const v = decideValue(slots, cc, base, deck, discard);
      const exact = { lo: v, hi: v };
      storeBounds(key, exact);
      return exact;
    }
    storeBounds(key, out);
    return out;
  }

  /** chance ノード（ドロー 1 枚の期待値）。子の列挙順は drawExpectation と同一（COLORS 順）。 */
  function bDraw(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts,
    deckTotal: number,
    discardTotal: number,
    a: number,
    b: number
  ): Bounds {
    const fromDeck = deckTotal > 0;
    const pool = fromDeck ? deck : discard;
    const total = fromDeck ? deckTotal : discardTotal;
    let L = 0; // 下界和（未評価の子は 0 扱い）
    let U = 1; // 上界和（未評価の子は 1 扱い。pool の確率和は 1）
    let exactSum = 0;
    let allExact = true;
    for (const color of COLORS) {
      const n = pool[color];
      if (n <= 0) continue;
      const p = n / total;
      // この子が「親の真偽を左右しうる」範囲: 他を上界に置いて a を割るには hi < ca、
      // 他を下界に置いて b に届かせるには lo ≥ cb が必要。
      const ca = (a - (U - p)) / p;
      const cb = (b - L) / p;
      const child = fromDeck
        ? bPlace(slots, color, cc, base, addCount(deck, color, -1), discard, ca, cb)
        : bPlace(slots, color, cc, base, addCount(discard, color, -1), emptyCounts(), ca, cb);
      L += p * child.lo;
      U -= p * (1 - child.hi);
      if (child.lo === child.hi) exactSum += p * child.lo;
      else allExact = false;
      if (L >= b) return { lo: L, hi: U };
      if (U < a) return { lo: L, hi: U };
    }
    if (allExact) return { lo: exactSum, hi: exactSum };
    // 契約上到達しない（certificate 子は直後の打ち切り条件を必ず満たす）。防御: 厳密再計算。
    const v = drawExpectation(slots, cc, base, deck, discard, deckTotal, discardTotal);
    return { lo: v, hi: v };
  }

  /** max ノード（引いた 1 枚の最良配置）。子の順序は placeBest と同一。 */
  function bPlace(slots: Color[][], color: Color, cc: number, base: number, deck: ColorCounts, discard: ColorCounts, a: number, b: number): Bounds {
    let doneLo = 0;
    let doneHi = 0;
    for (let j = 0; j < slots.length; j++) {
      const r = bResolve(placeColorOnSlots(slots, j, color, K), cc, base, deck, discard, Math.max(a, doneLo), b);
      if (r.lo > doneLo) doneLo = r.lo;
      if (r.hi > doneHi) doneHi = r.hi;
      if (doneLo >= b) return { lo: doneLo, hi: 1 };
    }
    return { lo: doneLo, hi: doneHi };
  }

  function reachesAtLeast(slots: Color[][], cc: number, base: number, deck: ColorCounts, discard: ColorCounts, P: number): boolean {
    if (P <= 0) return true;
    if (P > 1) return false;
    const r = bResolve(slots, cc, base, deck, discard, P, P);
    if (r.lo >= P) return true;
    if (r.hi < P) return false;
    // 契約上到達しない（防御）: 厳密値で判定。
    return resolveValue(slots, cc, base, deck, discard) >= P;
  }

  function reachesAtLeastBounded(
    slots: Color[][],
    cc: number,
    base: number,
    deck: ColorCounts,
    discard: ColorCounts,
    P: number,
    nodeCap: number
  ): boolean | null {
    if (P <= 0) return true;
    if (P > 1) return false;
    queryCap = nodeCap;
    try {
      const r = bResolve(slots, cc, base, deck, discard, P, P);
      if (r.lo >= P) return true;
      if (r.hi < P) return false;
      return null; // 区間が閉じない防御ケースも未確定として返す（厳密再計算はしない）
    } catch (e) {
      if (e instanceof QueryCapExceeded) return null;
      throw e;
    } finally {
      queryCap = Infinity;
    }
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
    reachesAtLeast: (slots, cc, base, deck, discard, P) =>
      topLevel(() => reachesAtLeast(slots, cc, base, deck, discard, P)),
    reachesAtLeastBounded: (slots, cc, base, deck, discard, P, nodeCap) =>
      topLevel(() => reachesAtLeastBounded(slots, cc, base, deck, discard, P, nodeCap)),
    decideValue: (slots, cc, base, deck, discard) => topLevel(() => decideValue(slots, cc, base, deck, discard)),
    bestDecision: (slots, cc, base, deck, discard) => topLevel(() => bestDecision(slots, cc, base, deck, discard)),
    bestPlacementSlot: (slots, cc, base, deck, discard, color) =>
      topLevel(() => bestPlacementSlot(slots, cc, base, deck, discard, color)),
    bestDiscardSlot: (slots, cc, base, deck, discard) => topLevel(() => bestDiscardSlot(slots, cc, base, deck, discard)),
    nodesUsed: () => nodes,
  };
}

// ---------------------------------------------------------------------------
// q 本体
// ---------------------------------------------------------------------------

/**
 * GRM 内側関数 `q`。発火状態から最適連鎖で「ターン得点 ≥ V」となる最大確率を返す。
 *
 * @throws 入力が発火状態でない場合（§4 は fire(S)=true を前提とする）。
 */
export function reachQ(input: SubgameInput, V: number, opts: ReachQOptions = {}): number {
  const K = opts.K ?? DEFAULT_K;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const slots0 = input.slots.map((s) => truncTop(s.slice(), K));
  const deck0 = normalizeCounts(input.deck);
  const discard0 = normalizeCounts(input.discard);

  if (!Number.isFinite(V)) {
    throw new Error('reachQ: V は有限の数値でなければならない');
  }
  if (!fireSlots(slots0)) {
    throw new Error('reachQ: 入力は発火状態（最上段に同色 3 枚以上）でなければならない（§4 は fire(S)=true 前提）');
  }

  return createChainSolver(V, K, maxNodes).resolveValue(slots0, 0, 0, deck0, discard0);
}

// ---------------------------------------------------------------------------
// GameState からの入力組み立て
// ---------------------------------------------------------------------------

/**
 * 実際の山札・捨札が分かっている状況（テスト・自己対戦シミュレーション）で、
 * `GameState` から `q` の入力を直接組み立てる。山札の色分布は `state.deck` を実数えする。
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
 * されていない分（`turn.combosThisTurn` 等）。`q` のサブゲーム中はこれらも山札に存在しない。
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
 * 発火状態の `GameState`（自手番の連鎖開始局面）に対して `q(S, V)` を計算する便利関数。
 * 山札は実数え（`subgameInputFromState`）を使う。
 */
export function reachQFromState(
  state: GameState,
  V: number,
  playerId: number,
  opts: ReachQOptions = {}
): number {
  return reachQ(subgameInputFromState(state, playerId), V, opts);
}
