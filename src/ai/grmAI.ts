/**
 * GRM（目標到達確率最大化法）のプレイ可能 CPU。`ai/REACHABILITY.md` の §6 主方策を実装する。
 *
 * 中核は内側関数 `q`（`grmReachQ.ts`）。判断は2段で行う:
 *  - 取得チャネル `a`（場ペア / 山札）× 積み方 `d` を、得られる状態 S' の価値 `gValue` で最大化（§6.2）。
 *  - 連鎖が始まったら（自分のターンで発火）、`q` の後退帰納に従って最適アクションを打つ（§4）。
 *
 * `gValue(S')`:
 *  - 発火状態（即解決）→ q(S',V)。q ≥ P なら目標集合 G に到達＝成功（最優先）。
 *    q < P の小〜中発火は「無駄撃ち」＝最悪扱い（§6.3: 小発火の能動的排除）。
 *  - 非発火 → 「G 到達までの期待ターン数」の見積りの符号反転（少ないターンほど高評価）。
 *    全状態の値反復は状態数（~10^17）から不可能なので、候補盤面ごとに「各色を貪欲に積んで厳密 q が
 *    P 以上になるまでの枚数 needed_c ÷ その色のドロー率 2·d_c」で期待ターン数を推定する（§6.1）。
 *    実スタックと厳密 q を使うので連鎖の順序依存を保つ。相手は読まない。
 *  - 終盤モード（§6.6）: 他者が先に 20 点到達済みなら V を必要追加得点に更新し、P 閾値を無効化
 *    （argmax q）。非発火枝は 0（今ターンが最後の前提）。
 *
 * 連鎖中・配り・受領配置も `q` / `gValue` の枠組みで統一的に扱う。
 */
import type { Action, Color, FieldPair, GameState, GiftAssignment, Player } from '../game/types';
import { COLORS } from '../game/types';
import { legalActionIds, actionIdToAction } from './actionSpace';
import {
  createChainSolver,
  fireSlots,
  colorCounts,
  totalCount,
  addCount,
  placeColorOnSlots,
  type ChainSolver,
  type ColorCounts,
} from './grmReachQ';

export interface GrmOptions {
  /** 目標点（基本 20）。終盤は必要追加得点に動的更新（§3 / §6.6）。 */
  V?: number;
  /** 目標確率（G を切り出す閾値、§3）。終盤は無効化。 */
  P?: number;
  /** 旧・先読みホライズン。現在は未使用（期待ターン数ヒューリスティックへ移行）。後方互換で受理のみ。 */
  H?: number;
  /** スタック切り詰め K（§2.1。既定 6）。 */
  K?: number;
  /** q ソルバの展開ノード上限。 */
  maxNodes?: number;
  /**
   * 1 決定（decideAction 1 回）の壁時計予算（ms）。省略時は無制限（従来挙動・ベンチ互換）。
   * 期限超過後は「設計された劣化」＝期待ターン数の精密化（深さ1後退帰納）を省き、二段推定の
   * 一段目（解析推定）だけで残り候補を順位付けする。劣化の発生は `budgetStats()` で追跡できる。
   */
  timeBudgetMs?: number;
}

interface ResolvedOptions {
  V: number;
  P: number;
  H: number;
  K: number;
  maxNodes: number;
  timeBudgetMs: number;
}

interface Ctx {
  solver: ChainSolver;
  V: number;
  P: number;
  H: number;
  K: number;
  endgame: boolean;
  /** tHat のメモ（同一 (盤面, 山札, 捨札) は同値。配置の合流を畳んで深い展開を実用化）。 */
  memoT: Map<string, number>;
  /** この決定の壁時計期限（エポック ms）。無制限なら Infinity。超過後は精密化を省く（設計された劣化）。 */
  deadline: number;
}

/** 色は先頭1文字が一意（red/green/purple/yellow/blue → r/g/p/y/b）。盤面・色分布を文字列化する。 */
function serializeBoard(slots: Color[][]): string {
  return slots.map((s) => s.map((c) => c[0]).join('')).join('|');
}
function serializeCounts(counts: ColorCounts): string {
  return COLORS.map((c) => counts[c]).join(',');
}

const DEFAULTS: ResolvedOptions = {
  V: 20,
  P: 0.8,
  H: 0, // 未使用（旧・先読みホライズン。期待ターン数ヒューリスティックへ移行し不要になった）。
  K: 6, // スタック切り詰め（§2.1。上から6枚）。
  maxNodes: 2_000_000,
  timeBudgetMs: Infinity, // 無制限＝従来挙動（ベンチ互換）。ブラウザ等は明示指定する。
};

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

function myColors(state: GameState, me: number): Color[][] {
  return state.players[me].board.slots.map((s) => s.stack.map((c) => c.color));
}

function sumBasePoints(state: GameState): number {
  return state.turn.combosThisTurn.reduce((s, c) => s + c.basePoints, 0);
}

/** プレイヤーの最上段が `color` であるスロット数（相手の連鎖準備度の簡易指標、§6.5）。 */
function topColorCount(player: Player, color: Color): number {
  let n = 0;
  for (const slot of player.board.slots) {
    const top = slot.stack[slot.stack.length - 1];
    if (top && top.color === color) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 価値関数 gValue / T̂
// ---------------------------------------------------------------------------

/** 発火状態なら q、非発火なら 0（その状態を「いま発火させた場合」の P(≥V)）。 */
function qOf(ctx: Ctx, slots: Color[][], deck: ColorCounts, discard: ColorCounts): number {
  return ctx.solver.resolveValue(slots, 0, 0, deck, discard);
}

// 期待ターン数スケールの罰（単位: 自手番）。値が大きいほど「G から遠い／悪い」。
const EXHAUST_TURNS = 50; // 深さ上限内に G へ届かない／小発火しか作れない＝到達困難＝最悪
const SMALL_FIRE_TURNS = 50; // G未満の小〜中発火＝setup を潰す＝最悪（§6.3）

/**
 * 候補状態 S' の価値（大きいほど良い ＝「G までの期待ターン数」が少ない）。
 *   発火 ∧ q≥P : ≈0（G に到達＝最短。q×1e-3 でタイブレーク）
 *   発火 ∧ q<P : −SMALL_FIRE_TURNS（小発火は setup を無駄にする＝最悪。§6.3）
 *   非発火     : −tHat（G 到達までの期待自手番数の見積り。少ないほど高評価）
 * 終盤モードでは q を直接最大化（非発火＝0、今ターンが最後の前提 §6.6）。
 */
function gValue(ctx: Ctx, slots: Color[][], deck: ColorCounts, discard: ColorCounts): number {
  if (fireSlots(slots)) {
    if (ctx.endgame) return qOf(ctx, slots, deck, discard);
    // まず閾値判定で q<P（不採用側）を速く弾き、G 到達のときだけタイブレーク用の厳密 q を解く。
    if (!qGeqP(ctx, slots, deck, discard)) return -SMALL_FIRE_TURNS;
    return qOf(ctx, slots, deck, discard) * 1e-3;
  }
  if (ctx.endgame) return 0;
  return -tHat(ctx, slots, deck, discard);
}

/**
 * 非発火盤面 S から G（発火して q≥P）に到達するまでの **期待自手番数の見積り**（ヒューリスティック）。
 *
 * 全状態の値反復は状態数（K=6・色/スロット対称性込みでも ~10^17）から不可能なので、候補盤面ごとに
 * **深さ制限つき期待ターン数の後退帰納**（小型の値反復）で推定する（§6.1 / §6.2）。各ターン「山札から 2 枚を
 * i.i.d. に引いて最適配置する」という実プロセスを直接展開する:
 *   T(S) = 1 + E_{2枚}[ min_配置 cost(S') ]   （cost: G なら 0 / 非発火なら T(S') / 小発火は不採用）
 * 厳密ベンチ（`ai/scripts/_tstar-bench.ts`）の真値計算と同じ漸化式を、実スタック・厳密 q の上で回す。
 *
 * 旧実装は色ごとに単色で貪欲に積む（各色独立に needed_c 枚）方式だったが、これは「既存スタックを活かした
 * **複数色混在の決定的連鎖**」（例: 空き2スロットへ赤を置きつつ別色の山を露出させて 2 枚で G 到達）を見落とし、
 * `|||rg|rg` 型の盤面で +0.75 程度の過大評価を生んでいた。本実装は配置を色で縛らず最適化するため、混在経路を
 * 自然に拾う。
 *
 * 速度の二段構え:
 *  1. まず旧・単色貪欲の解析推定 `analyticTurns`（軽量）で G からの距離を測る。
 *  2. 距離が GRM_REFINE_GATE 以下の近距離盤面だけ、深さ制限つき後退帰納で混在経路を厳密に拾い精緻化する
 *     （遠い盤面は HORIZON 内で G 不能＝改善余地が無いので解析推定で打ち切る）。後退帰納は値を下げる方向にしか
 *     効かないので、解析推定を上界として min を取る。
 * これにより厳密ベンチで MAE 0.145→0.012（約12倍改善）・相関 0.85→0.99 を、定常コスト ~1.8 倍で達成する。
 */
function tHat(ctx: Ctx, slots: Color[][], deck: ColorCounts, discard: ColorCounts): number {
  const totalAvail = totalCount(deck) + totalCount(discard);
  if (totalAvail < 1) return EXHAUST_TURNS;
  const key = `${serializeBoard(slots)}#${serializeCounts(deck)}#${serializeCounts(discard)}`;
  const cached = ctx.memoT.get(key);
  if (cached !== undefined) return cached;
  // 時間予算の期限超過: 精密化（深さ1後退帰納）を省き、二段推定の一段目（解析推定）で返す。
  // 劣化値は memoT に書かない（純粋な値だけを memo する）。
  if (pastDeadline(ctx)) {
    markDegraded();
    return analyticTurns(ctx, slots, deck, discard);
  }

  // まず軽量な解析推定で G からの距離を見る。後退帰納は混在連鎖を厳密に拾って値を **下げる** 方向にしか効かず、
  // しかも HORIZON 内で G に届ける近距離でしか改善しない。距離が GRM_REFINE_GATE を超える遠い盤面は 1〜数ターン
  // 先まで G 不能で改善余地が無いので、高価な後退帰納を省いて解析推定をそのまま返す（速度のため）。
  const approx = analyticTurns(ctx, slots, deck, discard);
  if (approx > GRM_REFINE_GATE) {
    ctx.memoT.set(key, approx);
    return approx;
  }

  // 1 枚引いて色 c である確率 p_c。候補（上位 GRM_DRAW_COLORS 色）以外はまとめて「無駄引き」(q) 扱い。
  const drawColors = COLORS.filter((c) => deck[c] + discard[c] > 0)
    .map((c) => ({ c, p: (deck[c] + discard[c]) / totalAvail }))
    .sort((a, b) => b.p - a.p);
  const cand = drawColors.slice(0, GRM_DRAW_COLORS);
  const qWaste = Math.max(0, 1 - cand.reduce((s, x) => s + x.p, 0)); // 候補外を引く確率（盤面を進めない）

  // 後退帰納は改善（下げる）方向のみ有効なので、解析推定を上界として min を取る。
  const refined = expTurnsRec(ctx, slots, deck, discard, cand, qWaste, 0, new Map<string, number>());
  const result = Math.min(approx, refined);
  ctx.memoT.set(key, result);
  return result;
}

// 後退帰納（1ターン展開）のパラメータ。厳密ベンチ（`ai/scripts/_tstar-bench.ts`）で精度（MAE）と速度の
// 釣り合いから決めた既定値。
const GRM_DRAW_COLORS = 3; // 1 ターンで「引いて使う」候補色数（上位のみ。残りは無駄引き q に集約）
const GRM_HORIZON = 1; // 期待ターン数の後退帰納の深さ上限（H=1 が精度/速度の最適点。H≥2 は精度ほぼ同じで急激に遅い）
const GRM_TARGET_SLOTS = 5; // 1 枚の配置先候補スロット数（上位のみ。全列挙の組合せ爆発を抑える）
// 精緻化ゲートは解析推定の**スケールに依存**する: v1 移植で解析値が正確（小さく）なり、旧スケールで
// 調整された 3 のままだと精密化対象が激増して budget=3000ms の劣化率が 4.4%→41-51% に悪化した
// （v2=ゲート 6 はさらに悪化で撤回）。新スケールでは 2 に再較正する（2026-06-11 プローブ実測で調整）。
const GRM_REFINE_GATE = 0; // 解析推定がこの値を超える遠い盤面は後退帰納を省く（HORIZON 内で G 不能＝改善余地なし）

/**
 * 期待ターン数の後退帰納（深さ制限つき値反復）。
 *  T(S) = 1 + Σ_{2枚の色組} P · min_配置 cost(S')
 * 配置は色で縛らず両順序・候補スロットで最適化し、小発火（q<P の発火）は採らない（§6.3）。山札が空なら
 * 捨札がプール化される実ルールに合わせ、引いた色の分だけ山札を減らして q を評価する（連鎖の順序依存を保つ）。
 *
 * 深さ上限に達したら、その盤面から先は **単色貪欲の解析フォールバック** `analyticTurns` で見積もる。展開で
 * G に届かなかった遠い盤面に一律 EXHAUST_TURNS を返すと、`rg||||` 型（数ターン先で到達）の値が深さ崖で大きく
 * 過大評価される。解析推定は「各色を単色で積む needed_c ÷ ドロー率」で滑らかに距離を表すため、近距離は本展開
 * が混在経路を厳密に拾い、遠距離は解析推定が滑らかに埋める二段構えになる。
 */
function expTurnsRec(
  ctx: Ctx,
  slots: Color[][],
  deck: ColorCounts,
  discard: ColorCounts,
  cand: { c: Color; p: number }[],
  qWaste: number,
  depth: number,
  memo: Map<string, number>
): number {
  if (depth >= GRM_HORIZON) return analyticTurns(ctx, slots, deck, discard);
  if (pastDeadline(ctx)) {
    markDegraded();
    return analyticTurns(ctx, slots, deck, discard);
  }
  const key = serializeBoard(slots);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  // 再帰中の同一盤面（無駄引きで自己ループ）の暫定値で発散を防ぐ。自己ループは無駄引き（qWaste>0）でしか
  // 起きないので、その時だけ解析推定を上界として置く（qWaste=0 なら参照されないので EXHAUST_TURNS で十分）。
  memo.set(key, qWaste > 1e-12 ? analyticTurns(ctx, slots, deck, discard) : EXHAUST_TURNS);

  // 1 枚を「候補色 c（確率 p_c）」または「無駄引き（確率 qWaste、盤面を進めない）」として展開。
  const draws: { c: Color | null; p: number }[] = cand.map((x) => ({ c: x.c, p: x.p }));
  if (qWaste > 1e-12) draws.push({ c: null, p: qWaste });

  let exp = 0;
  for (const d1 of draws) {
    for (const d2 of draws) {
      const prob = d1.p * d2.p;
      if (prob <= 0) continue;
      const cost = bestTwoCardCost(ctx, slots, deck, discard, d1.c, d2.c, cand, qWaste, depth, memo);
      exp += prob * cost;
    }
  }
  const result = 1 + exp;
  memo.set(key, result);
  return result;
}

/**
 * このターンに引いた 2 枚（色 c1, c2。null は無駄引き＝配置しない）を最適配置したときの最小 cost。
 * 両順序・候補スロットを試し、G に届けば 0、非発火なら次ターンの T(S')、小発火は不採用（除外）。
 * 両方とも無駄引きなら盤面据え置きで次ターンへ（自己ループは memo の暫定値で有界）。
 */
function bestTwoCardCost(
  ctx: Ctx,
  slots: Color[][],
  deck: ColorCounts,
  discard: ColorCounts,
  c1: Color | null,
  c2: Color | null,
  cand: { c: Color; p: number }[],
  qWaste: number,
  depth: number,
  memo: Map<string, number>
): number {
  const useful = [c1, c2].filter((c): c is Color => c !== null);
  if (useful.length === 0) {
    // 2 枚とも候補外 → 盤面据え置きで 1 ターン消費（自己ループ）。
    return expTurnsRec(ctx, slots, deck, discard, cand, qWaste, depth + 1, memo);
  }
  if (useful.length === 1) {
    return bestPlaceCost(ctx, slots, deck, discard, useful[0], cand, qWaste, depth, memo);
  }
  // 2 枚: 両順序 × 候補スロット の全組合せで配置後ボードを集め、重複（対称な空きスロット等で同型になる盤面）を
  // 除いてから評価する。どの配置も採れなければ解析推定でフォールバック（遅延評価: 改善が見つかれば解析を呼ばない）。
  const seen = new Set<string>();
  let best = EXHAUST_TURNS;
  const orders: [Color, Color][] = useful[0] === useful[1] ? [[useful[0], useful[1]]] : [[useful[0], useful[1]], [useful[1], useful[0]]];
  for (const [x, y] of orders) {
    for (const a of targetSlots(slots, x)) {
      const b1 = placeColorOnSlots(slots, a, x, ctx.K);
      for (const b of targetSlots(b1, y)) {
        if (pastDeadline(ctx)) {
          // 期限超過: 評価済みの最良（無ければ解析推定）で打ち切る（設計された劣化）。
          markDegraded();
          return best >= EXHAUST_TURNS ? analyticTurns(ctx, slots, deck, discard) : best;
        }
        const b2 = placeColorOnSlots(b1, b, y, ctx.K);
        const sig = serializeBoard(b2);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const cost = leafCost(ctx, b2, deck, discard, [x, y], cand, qWaste, depth, memo);
        if (cost < best) best = cost;
        if (best <= 0) return 0;
      }
    }
  }
  return best >= EXHAUST_TURNS ? analyticTurns(ctx, slots, deck, discard) : best;
}

/**
 * 1 枚 c を最適配置したときの最小 cost（候補スロットで列挙、配置後ボードは重複除去）。どの配置も採れなければ
 * 解析推定でフォールバック（遅延評価）。
 */
function bestPlaceCost(
  ctx: Ctx,
  slots: Color[][],
  deck: ColorCounts,
  discard: ColorCounts,
  c: Color,
  cand: { c: Color; p: number }[],
  qWaste: number,
  depth: number,
  memo: Map<string, number>
): number {
  const seen = new Set<string>();
  let best = EXHAUST_TURNS;
  for (const a of targetSlots(slots, c)) {
    if (pastDeadline(ctx)) {
      markDegraded();
      return best >= EXHAUST_TURNS ? analyticTurns(ctx, slots, deck, discard) : best;
    }
    const b1 = placeColorOnSlots(slots, a, c, ctx.K);
    const sig = serializeBoard(b1);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const cost = leafCost(ctx, b1, deck, discard, [c], cand, qWaste, depth, memo);
    if (cost < best) best = cost;
    if (best <= 0) return 0;
  }
  return best >= EXHAUST_TURNS ? analyticTurns(ctx, slots, deck, discard) : best;
}

/**
 * 配置後の盤面 S' の cost: 発火して q≥P なら 0（G 到達）/ 小発火（q<P）は不採用（EXHAUST_TURNS）/
 * 非発火なら次ターンの期待ターン数 T(S')。q 評価には構築に使った色の分だけ減らした山札を渡す。
 */
function leafCost(
  ctx: Ctx,
  board: Color[][],
  deck: ColorCounts,
  discard: ColorCounts,
  placed: Color[],
  cand: { c: Color; p: number }[],
  qWaste: number,
  depth: number,
  memo: Map<string, number>
): number {
  if (fireSlots(board)) {
    const deckForQ: ColorCounts = { ...deck };
    for (const c of placed) deckForQ[c] = Math.max(0, deckForQ[c] - 1); // 構築に使った分だけ山札を減らす
    return qReachesG(ctx, board, deckForQ, discard) ? 0 : EXHAUST_TURNS;
  }
  return expTurnsRec(ctx, board, deck, discard, cand, qWaste, depth + 1, memo);
}

/**
 * 発火盤面が G（q≥P）に届くかの判定をモジュールレベルでキャッシュする。判定は (盤面, 山札, 捨札, V, P, K) の
 * 純関数で、後退帰納の多数の発火葉や複数の決定局面・複数ゲームをまたいで同一引数が頻出する。ctx 内ソルバメモは
 * ctx を作り直すと失われるため、最終判定（真偽）だけを薄く共有する（ソルバ内部状態には触れない）。
 */
const FIRE_G_CACHE = new Map<string, boolean>();
/** モジュール共有キャッシュの上限。無制限だと長時間ベンチ（数十ゲーム）でヒープが枯渇する。 */
const SHARED_CACHE_CAP = 1_000_000;
/**
 * 等価性検証用スイッチ: 環境変数 GRM_EXACT_Q=1 で閾値探索（reachesAtLeast）を使わず常に厳密 q 値で
 * 判定する。判断同一性プローブ（`ai/scripts/_grm_equiv_probe.ts`）が新旧経路を別プロセスで走らせて
 * 全着手の一致を確認するためのもの。既定（未設定）は高速な閾値探索。
 */
const EXACT_Q_ONLY =
  typeof process !== 'undefined' && process.env != null && process.env.GRM_EXACT_Q === '1';

/** q ≥ P の真偽（thresholded）。EXACT_Q_ONLY 時は厳密値比較（結果は同一、速度のみ異なる）。 */
function qGeqP(ctx: Ctx, board: Color[][], deck: ColorCounts, discard: ColorCounts): boolean {
  return EXACT_Q_ONLY
    ? ctx.solver.resolveValue(board, 0, 0, deck, discard) >= ctx.P
    : ctx.solver.reachesAtLeast(board, 0, 0, deck, discard, ctx.P);
}

function qReachesG(ctx: Ctx, board: Color[][], deckForQ: ColorCounts, discard: ColorCounts): boolean {
  const key = `${ctx.V},${ctx.P},${ctx.K}#${serializeBoard(board)}#${serializeCounts(deckForQ)}#${serializeCounts(discard)}`;
  const cached = FIRE_G_CACHE.get(key);
  if (cached !== undefined) return cached;
  const res = qGeqP(ctx, board, deckForQ, discard);
  if (FIRE_G_CACHE.size >= SHARED_CACHE_CAP) FIRE_G_CACHE.clear();
  FIRE_G_CACHE.set(key, res);
  return res;
}

/**
 * 色 c を置く候補スロット（上位 GRM_TARGET_SLOTS 個）。混在連鎖を拾うため「最上段が c の山（まとめる）」と
 * 「空き／低いスロット（新たな山・露出）」の両方を含め、低いスロットを優先する。さらに **スタック内容が同一の
 * スロットは交換可能**（置いた結果が同型）なので 1 つに縮約し、無駄な配置試行を省く。
 */
function targetSlots(board: Color[][], c: Color): number[] {
  const idxs = board.map((_, j) => j);
  // c の山を最優先（h 小）、次に他色スロットを h 小順。重複露出経路を網羅するため最低でも空き1つは含む。
  idxs.sort((j, k) => {
    const hj = board[j].length;
    const hk = board[k].length;
    const cj = board[j][hj - 1] === c ? 0 : 1; // c の山を前に
    const ck = board[k][hk - 1] === c ? 0 : 1;
    if (cj !== ck) return cj - ck;
    return hj - hk;
  });
  // スタック内容が同一のスロットは結果が同型 → 先頭の 1 つだけ残す（特に複数の空きスロット）。
  const out: number[] = [];
  const seenStacks = new Set<string>();
  for (const j of idxs) {
    const stackSig = board[j].map((x) => x[0]).join('');
    if (seenStacks.has(stackSig)) continue;
    seenStacks.add(stackSig);
    out.push(j);
    if (out.length >= GRM_TARGET_SLOTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 解析フォールバック（深さ上限・到達不能枝の見積り）
// ---------------------------------------------------------------------------

const BUILD_CAP = 14; // 単色構築コスト探索の上限枚数（~2-3層）。これを超えたらその色は到達不能扱い。
const GREEDY_EARLY_CAP = 5; // greedy の前半線形走査の上限（有望色はこの範囲で決まる。詳細は関数内コメント）。
// greedy プローブ 1 回のノード上限。境界的な盤面の閾値判定は確定までに数秒級になりうるため
// （ノード予算 200 万 ≈ 秒。レイテンシ実測でこの裾が T̂ コストの正体だった）、解析推定のプローブは
// 有界に打ち切り「届かない」扱いに倒す（設計近似: needed を高め＝無駄色側へ＝保守的）。
const GREEDY_PROBE_NODE_CAP = 30_000;
/** greedy プローブ（上限つき判定）の共有キャッシュ。打ち切り＝false を含むため FIRE_G_CACHE とは分ける。 */
const GREEDY_G_CACHE = new Map<string, boolean>();

/** greedy 用の G 判定（ノード上限つき・未確定は false 扱い）。 */
function greedyProbeG(ctx: Ctx, board: Color[][], deckForQ: ColorCounts, discard: ColorCounts): boolean {
  const key = `${ctx.V},${ctx.P},${ctx.K}#${serializeBoard(board)}#${serializeCounts(deckForQ)}#${serializeCounts(discard)}`;
  const cached = GREEDY_G_CACHE.get(key);
  if (cached !== undefined) return cached;
  const res = EXACT_Q_ONLY
    ? ctx.solver.resolveValue(board, 0, 0, deckForQ, discard) >= ctx.P
    : (ctx.solver.reachesAtLeastBounded(board, 0, 0, deckForQ, discard, ctx.P, GREEDY_PROBE_NODE_CAP) ?? false);
  if (GREEDY_G_CACHE.size >= SHARED_CACHE_CAP) GREEDY_G_CACHE.clear();
  GREEDY_G_CACHE.set(key, res);
  return res;
}
// レースに乗せる色数（優先度上位のみ greedy で needed を計測。残りは無駄色質量としてレース式へ）。
// tstar v1 は全色だが、実サイズでは見込み薄の色の greedy（BUILD_CAP まで q プローブ）が支配的コストになり
// budget=3000ms の劣化率が 4.4%→50% に悪化したため、上位 3 色で打ち切る（旧実装は 2 色で、かつ
// 無駄色を確率質量として扱わない簡易和だった。3 色＋厳密閉形式で過大評価バイアスの大半を除く）。
const GRM_RACE_COLORS = 3;

/**
 * `analyticTurns` のプロセス内共有キャッシュ。解析推定は (盤面, 山札, 捨札, V, P, K) の純関数で、後退帰納の
 * 多数の葉や複数の決定局面・複数ゲームをまたいで同一盤面が頻繁に再評価される。ctx 単位のメモでは ctx を作り
 * 直すたびに失われるため、純関数性を利用してモジュールレベルで共有する（同じカード構成・目標なら常に同値）。
 */
const ANALYTIC_CACHE = new Map<string, number>();

/**
 * 単色貪欲の解析的な期待ターン数（後退帰納の深さ上限・行き止まり枝のフォールバック）。
 * 各色 c を実盤面に単色で貪欲に積み、厳密 q≥P になるまでの枚数 needed_c を求め、「どれか早い色で G に到達」
 * する期待ターン数 E[min_c τ_c]（多項分布の裾）を返す。後退帰納本体が混在連鎖を厳密に拾うのに対し、これは
 * 遠距離で滑らかに距離を表す軽量推定。
 */
function analyticTurns(ctx: Ctx, slots: Color[][], deck: ColorCounts, discard: ColorCounts): number {
  const totalAvail = totalCount(deck) + totalCount(discard);
  if (totalAvail < 1) return EXHAUST_TURNS;
  const memoKey = `${ctx.V},${ctx.P},${ctx.K}#${serializeBoard(slots)}#${serializeCounts(deck)}#${serializeCounts(discard)}`;
  const cachedA = ANALYTIC_CACHE.get(memoKey);
  if (cachedA !== undefined) return cachedA;
  // v1（tstar 移植, UPSTREAM.md 2026-06-10）: 旧・候補 2 色の簡易和は残りの色のドローを無駄引き扱いし、
  // 色数が増えるほど系統的過大評価を生む（tstar 厳密ベンチ: m=3 でバイアス +0.49、実サイズ空盤面
  // T̂=23.1 vs 真値 ≤~14.5）。過大評価は取得チャネル比較（deckChannelValue = 1−T vs 場ペア）を歪める。
  // → 優先度上位 GRM_RACE_COLORS 色の needed を greedy で測り、厳密閉形式のレースで評価する
  //   （上位以外と未到達色は無駄色質量 q としてレース式に正しく入れる）。
  const prio = COLORS.filter((c) => deck[c] + discard[c] > 0)
    .map((c) => ({ c, pr: topCountOnBoard(slots, c) * 100 + deck[c] + discard[c] }))
    .sort((a, b) => b.pr - a.pr);
  const cands: { p: number; needed: number }[] = [];
  let qWasteRace = 0;
  for (let i = 0; i < prio.length; i++) {
    const color = prio[i].c;
    const p = (deck[color] + discard[color]) / totalAvail;
    if (i >= GRM_RACE_COLORS) {
      qWasteRace += p; // 優先度下位はレース対象外＝無駄色質量
      continue;
    }
    const needed = greedyCardsToReachG(ctx, slots, color, deck, discard);
    if (needed < 0) qWasteRace += p; // BUILD_CAP 以内で未到達＝無駄色質量
    else cands.push({ p, needed });
  }
  const res = cands.length === 0 ? EXHAUST_TURNS : expectedRaceTurns(cands, qWasteRace);
  if (ANALYTIC_CACHE.size >= SHARED_CACHE_CAP) ANALYTIC_CACHE.clear();
  ANALYTIC_CACHE.set(memoKey, res);
  return res;
}

/** 最上段が `color` であるスロット数（レース候補色の優先度づけに使う）。 */
function topCountOnBoard(slots: Color[][], color: Color): number {
  let n = 0;
  for (const s of slots) if (s[s.length - 1] === color) n += 1;
  return n;
}

/** c を積むスロット選択: 最上段が c でない最も低いスロット → 無ければ最も低いスロット（深さを稼ぐ）。 */
function pickBuildSlot(board: Color[][], c: Color): number {
  let nonCSlot = -1;
  let nonCH = Infinity;
  let anySlot = 0;
  let anyH = Infinity;
  for (let j = 0; j < board.length; j++) {
    const h = board[j].length;
    if (h < anyH) {
      anyH = h;
      anySlot = j;
    }
    if (board[j][h - 1] !== c && h < nonCH) {
      nonCH = h;
      nonCSlot = j;
    }
  }
  return nonCSlot >= 0 ? nonCSlot : anySlot;
}

/**
 * 実盤面に色 c を貪欲に積み、厳密 q(盤面,V) ≥ P（＝G）に達するまでの枚数を返す（未達なら -1）。
 * 1 枚置くごとに厳密 q を判定し、**G になった最小枚数で止める**（size5 まで積み過ぎない）。実スタックを保つ
 * ので連鎖の順序依存を反映する。
 */
function greedyCardsToReachG(ctx: Ctx, slots: Color[][], c: Color, deck: ColorCounts, discard: ColorCounts): number {
  // 各 count の盤面列を先に作る（順序は従来と同一の貪欲 pickBuildSlot 連鎖）。
  const boards: Color[][][] = [slots.map((s) => s.slice())];
  for (let count = 1; count <= BUILD_CAP; count++) {
    const prev = boards[count - 1];
    boards.push(placeColorOnSlots(prev, pickBuildSlot(prev, c), c, ctx.K));
  }
  const probe = (count: number): boolean => {
    const board = boards[count];
    if (!fireSlots(board)) return false;
    const deckForQ: ColorCounts = { ...deck };
    deckForQ[c] = Math.max(0, deck[c] - count); // 構築に使った c の分だけ山札を減らす
    return greedyProbeG(ctx, board, deckForQ, discard);
  };
  // プローブ順はコスト非対称性に合わせる:
  //  1. 前半（count ≤ GREEDY_EARLY_CAP）は低い盤面の線形走査。有望色はここで真証明が即決する
  //     （q≥P の真証明は閾値 B&B が速い側。旧実装の実効コストはこれと同じ）。
  //  2. 見つからなければ上限 BUILD_CAP の盤面 1 回で「そもそも届く色か」を判定し、届かない色は
  //     即 -1。q<P の偽証明は高価で、見込みのない色に対し中間の発火形ごとに偽証明を繰り返すのが
  //     解析推定の支配的コストだった（プローブ実測）。「材料を積むほど q は下がらない」単調性を
  //     仮定した近似（needed はもともと貪欲プランのヒューリスティック量。稀な非単調ケースは
  //     その色を無駄色側に倒すだけ＝保守的）。
  for (let count = 0; count <= GREEDY_EARLY_CAP; count++) {
    if (probe(count)) return count;
  }
  if (!probe(BUILD_CAP)) return -1;
  for (let count = GREEDY_EARLY_CAP + 1; count < BUILD_CAP; count++) {
    if (probe(count)) return count;
  }
  return BUILD_CAP;
}

/** log(n!) のメモ化テーブル。 */
const LOG_FACT: number[] = [0];
function logFact(n: number): number {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}

/**
 * 「どれか早い色で G に到達」する期待ターン数 E[min_c τ_c]。毎ターン 2 枚を i.i.d. に引き（色 c は確率 p_c、
 * 無駄引きは確率 q）、色 c を needed_c 枚集めたらその色で G に届くとみなす。`E[τ] = Σ_t P(2t 枚で未達)`。
 * 色は draw を共有するため負相関で、これが「単色 min より速い」効果を表す。
 *
 * tstar リポジトリ v1 の `expectedRaceTurns`（切断指数の積＝指数型母関数による**厳密閉形式**）を
 * 非一様レート p_c に一般化した移植（UPSTREAM.md 2026-06-10。一様版は独立 DP と 1e-9 一致のテスト済み、
 * 本一般化も `grmRace.test.ts` で分布 DP と突き合わせ）。候補数は任意（旧実装は 2 色限定の明示和だった）:
 *   P(全候補 c で count_c < needed_c | n 枚) = n! Σ_{j≤n} q^{n−j}/(n−j)! · [y^j] Π_c Σ_{r<needed_c} (p_c y)^r / r!
 */
export function expectedRaceTurns(cands: { p: number; needed: number }[], qWaste: number): number {
  if (cands.length === 0) return EXHAUST_TURNS;
  if (cands.some((c) => c.needed <= 0)) return 0; // 必要枚数 0 の色がある＝既に達成済み
  // 多項式 Π_c Σ_{r<needed_c} (p_c)^r y^r / r! を係数配列で構築
  let poly: number[] = [1];
  for (const c of cands) {
    const next = new Array<number>(poly.length + c.needed - 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      const pi = poly[i];
      if (pi === 0) continue;
      let term = 1; // p^r / r!
      for (let r = 0; r < c.needed; r++) {
        if (r > 0) term *= c.p / r;
        next[i + r] += pi * term;
      }
    }
    poly = next;
  }
  const D = poly.length - 1;
  const logA = poly.map((a) => (a > 0 ? Math.log(a) : -Infinity));
  const logQ = qWaste > 1e-15 ? Math.log(qWaste) : -Infinity;
  let E = 0;
  for (let t = 0; t <= 200; t++) {
    const n2 = 2 * t;
    let pnot = 0;
    if (logQ === -Infinity) {
      if (n2 > D) break;
      if (logA[n2] !== -Infinity) pnot = Math.exp(logFact(n2) + logA[n2]);
    } else {
      const jmax = Math.min(n2, D);
      for (let j = 0; j <= jmax; j++) {
        if (logA[j] === -Infinity) continue;
        const rest = n2 - j;
        pnot += Math.exp(logFact(n2) - logFact(rest) + rest * logQ + logA[j]);
      }
    }
    E += pnot;
    if (n2 > D && pnot < 1e-12) break;
  }
  return E;
}

/**
 * 遅延精密化のマージン Δ。非発火候補の真の価値 −T は −max(1, analytic − Δ) を上回らない、という
 * 仮定で候補を枝刈りする（T = min(analytic, refined)、refined ≥ 1、解析推定の過大評価は実測 +0.75 が
 * 最悪＝Δ はその 2 倍を確保）。仮定が破れた場合のみ判断が変わりうる（quasi-zero-loss）。検証は
 * `_grm_equiv_probe.ts`（GRM_NO_LAZY=1 比較）と GRM_LAZY_AUDIT=1（全評価との突き合わせ＋gap 計測）。
 */
const GRM_LAZY_DELTA = 1.5;
/** 検証用: GRM_NO_LAZY=1 で遅延精密化を無効化し全候補を厳密評価する。 */
const NO_LAZY = typeof process !== 'undefined' && process.env != null && process.env.GRM_NO_LAZY === '1';
/** 検証用: GRM_LAZY_AUDIT=1 で全候補を厳密評価しつつ、遅延打ち切りが選んだはずの手と比較・計数する。 */
const LAZY_AUDIT = typeof process !== 'undefined' && process.env != null && process.env.GRM_LAZY_AUDIT === '1';
let lazyAuditDecisions = 0;
let lazyAuditMismatches = 0;
let lazyAuditMaxGap = 0;
/** GRM_LAZY_AUDIT=1 実行の集計（プローブが読む）。 */
export function lazyAuditStats(): { decisions: number; mismatches: number; maxGap: number } {
  return { decisions: lazyAuditDecisions, mismatches: lazyAuditMismatches, maxGap: lazyAuditMaxGap };
}

interface PlacementCand {
  board: Color[][];
  firstColor: Color;
  slot: number;
  /** 従来の全探索の列挙順（同値タイブレークを従来と一致させるため保存）。 */
  idx: number;
  fired: boolean;
  /** 非発火候補の解析推定（楽観上界の材料）。発火候補は 0。 */
  aTurns: number;
  /** 楽観上界（この候補の真の gValue はこれを超えない）。 */
  opt: number;
}

/** 期限超過時の縮約列挙で 1 枚あたり試すスロット数（targetSlots の先頭＝選好順）。
 * 1 に絞る: v1 移植で解析推定 1 回が重く（上限つきプローブ ×~15）、2 だと期限後に最大 8 盤面 ×
 * 解析で数秒の超過源になっていた（プローブ実測）。 */
const GRM_LATE_TARGET_SLOTS = 1;

/**
 * 期限超過後の配置決定（第 2 段の設計劣化）: targetSlots の選好順で候補を少数に絞り、
 * 発火候補は閾値ゲート（G なら最優先）、非発火候補は解析推定で順位付けする。
 */
function lateBestPlacement(
  ctx: Ctx,
  slots: Color[][],
  colors: Color[],
  deck: ColorCounts,
  discard: ColorCounts
): { value: number; firstColor: Color | null; slot: number } {
  let bestVal = -Infinity;
  let bestColor: Color | null = colors[0];
  let bestSlot = 0;
  const seen = new Set<string>();
  const tried = new Set<Color>();
  const evalBoard = (board: Color[][], firstColor: Color, slot: number): void => {
    const sig = serializeBoard(board);
    if (seen.has(sig)) return;
    seen.add(sig);
    let v: number;
    if (fireSlots(board)) {
      // ゲートも上限つき判定（greedyProbeG）にする: 期限超過後に無上限の偽証明（数秒級）を
      // 走らせないため。打ち切り未確定は非 G 扱い＝この最深劣化層では許容する。
      v = ctx.endgame
        ? qOf(ctx, board, deck, discard)
        : greedyProbeG(ctx, board, deck, discard)
          ? 1e-3 // G 到達（タイブレークの厳密 q は省略＝劣化）
          : -SMALL_FIRE_TURNS;
    } else {
      v = ctx.endgame ? 0 : -analyticTurns(ctx, board, deck, discard);
    }
    if (v > bestVal) {
      bestVal = v;
      bestColor = firstColor;
      bestSlot = slot;
    }
  };
  for (let ci = 0; ci < colors.length; ci++) {
    const color = colors[ci];
    if (tried.has(color)) continue;
    tried.add(color);
    const rest = colors.filter((_, k) => k !== ci);
    for (const j of targetSlots(slots, color).slice(0, GRM_LATE_TARGET_SLOTS)) {
      const b1 = placeColorOnSlots(slots, j, color, ctx.K);
      if (rest.length === 0) {
        evalBoard(b1, color, j);
      } else {
        for (const j2 of targetSlots(b1, rest[0]).slice(0, GRM_LATE_TARGET_SLOTS)) {
          evalBoard(placeColorOnSlots(b1, j2, rest[0], ctx.K), color, j);
        }
      }
    }
  }
  return { value: bestVal, firstColor: bestColor, slot: bestSlot };
}

/**
 * 取得したカード列 `colors`（通常 2 枚）の最適配置を、**どのカードを先に置くかも含めて全候補で**探す。
 * 別スロットなら順序は無関係だが、**同一スロットに重ねる場合は上下の順（例 [緑,赤] と [赤,緑]）で別の盤面**
 * になるため、両方を網羅する。最初に置くべき色 `firstColor` とそのスロット `slot`、その時の価値を返す。
 * （同色のカードは交換可能なので 1 回だけ試す。）
 *
 * 速度（遅延精密化）: 候補盤面ごとの厳密評価（gValue → 近距離は深さ1後退帰納）が重いので、まず全候補の
 * 楽観上界（発火=+∞[ゲートは安価] / 非発火=−max(1, analytic−Δ)）を安価に出し、上界の降順に厳密評価して
 * 「確定 best > 残り候補の上界」になったら打ち切る。同値タイは従来の列挙順を保存（idx 優先）するため、
 * Δ の仮定の下で従来の全探索と同じ手を返す。
 */
function bestDrawnPlacement(
  ctx: Ctx,
  slots: Color[][],
  colors: Color[],
  deck: ColorCounts,
  discard: ColorCounts
): { value: number; firstColor: Color | null; slot: number } {
  if (colors.length === 0) {
    return { value: gValue(ctx, slots, deck, discard), firstColor: null, slot: 0 };
  }
  // 入口時点で既に期限超過（前の評価が予算を使い切った）: 候補を targetSlots の選好ヒューリスティックで
  // 少数（≤2 スロット/枚）に縮約し、解析推定（＋発火は閾値ゲート）だけで順位付けする（第 2 段の設計劣化。
  // 全候補 ~50 盤面の解析推定を期限後に回さないための上限）。
  if (pastDeadline(ctx)) {
    markDegraded();
    return lateBestPlacement(ctx, slots, colors, deck, discard);
  }
  if (colors.length > 2) {
    // 実ゲームでは 1〜2 枚のみ。想定外の枚数は従来の全探索で安全に処理する。
    let bestVal = -Infinity;
    let bestColor: Color | null = colors[0];
    let bestSlot = 0;
    const tried = new Set<Color>();
    for (let ci = 0; ci < colors.length; ci++) {
      const color = colors[ci];
      if (tried.has(color)) continue;
      tried.add(color);
      const rest = colors.slice(0, ci).concat(colors.slice(ci + 1));
      for (let j = 0; j < slots.length; j++) {
        const v = placeAllValue(ctx, placeColorOnSlots(slots, j, color, ctx.K), rest, deck, discard);
        if (v > bestVal) {
          bestVal = v;
          bestColor = color;
          bestSlot = j;
        }
      }
    }
    return { value: bestVal, firstColor: bestColor, slot: bestSlot };
  }

  // --- 候補列挙（従来の探索順を idx に保存。同一盤面は初出のみ評価＝値は同じで初出が勝つ規約どおり） ---
  const cands: PlacementCand[] = [];
  const seen = new Set<string>();
  let idx = 0;
  const tried = new Set<Color>();
  for (let ci = 0; ci < colors.length; ci++) {
    const color = colors[ci];
    if (tried.has(color)) continue;
    tried.add(color);
    const rest = colors.filter((_, k) => k !== ci); // 0 or 1 枚
    for (let j = 0; j < slots.length; j++) {
      const b1 = placeColorOnSlots(slots, j, color, ctx.K);
      if (rest.length === 0) {
        const sig = serializeBoard(b1);
        if (!seen.has(sig)) {
          seen.add(sig);
          cands.push({ board: b1, firstColor: color, slot: j, idx, fired: false, aTurns: 0, opt: 0 });
        }
        idx++;
      } else {
        for (let j2 = 0; j2 < slots.length; j2++) {
          const b2 = placeColorOnSlots(b1, j2, rest[0], ctx.K);
          const sig = serializeBoard(b2);
          if (!seen.has(sig)) {
            seen.add(sig);
            cands.push({ board: b2, firstColor: color, slot: j, idx, fired: false, aTurns: 0, opt: 0 });
          }
          idx++;
        }
      }
    }
  }

  // --- 楽観上界（安価）: 発火=+∞（ゲートは閾値判定で安価・G なら非発火を常に上回る）/ 非発火=−max(1, analytic−Δ) ---
  for (const c of cands) {
    c.fired = fireSlots(c.board);
    if (c.fired) {
      c.opt = Infinity;
    } else if (ctx.endgame) {
      c.opt = 0; // 終盤モードの非発火は gValue=0 固定（そのまま厳密値）
    } else if (pastDeadline(ctx)) {
      // 期限がこのフェーズ中に来た: 残り候補は解析推定も省いて考慮外に落とす（設計劣化）。
      markDegraded();
      c.aTurns = EXHAUST_TURNS;
      c.opt = -Infinity;
    } else {
      c.aTurns = analyticTurns(ctx, c.board, deck, discard);
      c.opt = -Math.max(1, c.aTurns - GRM_LAZY_DELTA);
    }
  }
  cands.sort((a, b) => (a.opt === b.opt ? a.idx - b.idx : b.opt - a.opt));

  // --- 上界の降順に厳密評価し、確定 best が残りの上界を厳密に上回ったら打ち切る ---
  let bestVal = -Infinity;
  let bestIdx = Infinity;
  let bestColor: Color | null = colors[0];
  let bestSlot = 0;
  const auditVals: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!NO_LAZY && !LAZY_AUDIT && bestVal > c.opt) break; // 降順なので以降すべて上界 < bestVal
    // 期限超過: 非発火候補は二段推定の一段目（解析推定）の値で比較する（設計された劣化）。
    // 発火候補は閾値ゲートが安価＆G を取りこぼすと致命的なので常に厳密評価。
    const degraded = !c.fired && !ctx.endgame && pastDeadline(ctx);
    if (degraded) markDegraded();
    const v = degraded ? -c.aTurns : gValue(ctx, c.board, deck, discard);
    if (LAZY_AUDIT) {
      auditVals.push(v);
      if (!c.fired && !ctx.endgame) {
        const gap = c.aTurns + v; // analytic − 厳密コスト（>Δ なら上界仮定の破れ）
        if (gap > lazyAuditMaxGap) lazyAuditMaxGap = gap;
      }
    }
    if (v > bestVal || (v === bestVal && c.idx < bestIdx)) {
      bestVal = v;
      bestIdx = c.idx;
      bestColor = c.firstColor;
      bestSlot = c.slot;
    }
  }

  if (LAZY_AUDIT) {
    // 遅延打ち切りが選んだはずの手を再現し、全評価の選択と突き合わせる。
    lazyAuditDecisions++;
    let lv = -Infinity;
    let lidx = Infinity;
    let lc: Color | null = colors[0];
    let ls = 0;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (lv > c.opt) break;
      const v = auditVals[i];
      if (v > lv || (v === lv && c.idx < lidx)) {
        lv = v;
        lidx = c.idx;
        lc = c.firstColor;
        ls = c.slot;
      }
    }
    if (lc !== bestColor || ls !== bestSlot) {
      lazyAuditMismatches++;
      console.error(`[lazy-audit] mismatch: lazy=(${lc},${ls}) full=(${bestColor},${bestSlot})`);
    }
  }

  return { value: bestVal, firstColor: bestColor, slot: bestSlot };
}

/** 残りの `colors` を最適に積んだときの価値（**置く順も含めて全探索**。葉で gValue）。同色は 1 回だけ試す。 */
function placeAllValue(ctx: Ctx, slots: Color[][], colors: Color[], deck: ColorCounts, discard: ColorCounts): number {
  if (colors.length === 0) return gValue(ctx, slots, deck, discard);
  let best = -Infinity;
  const tried = new Set<Color>();
  for (let ci = 0; ci < colors.length; ci++) {
    const color = colors[ci];
    if (tried.has(color)) continue;
    tried.add(color);
    const rest = colors.slice(0, ci).concat(colors.slice(ci + 1));
    for (let j = 0; j < slots.length; j++) {
      const v = placeAllValue(ctx, placeColorOnSlots(slots, j, color, ctx.K), rest, deck, discard);
      if (v > best) best = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 取得チャネルの評価（§6.2 の max_a E_ω[max_d ...]）
// ---------------------------------------------------------------------------

// 取得チャネルの評価は、**実配置と同じ厳密な最適配置**（`bestDrawnPlacement`: どのカードを先にどのスロットへ、
// 積み順込み）で行う。チャネル間の比較を公平にするため、場ペアも山札も同一の厳密配置で評価する。

/** 場ペア（既知 2 色）の取得チャネル値: 厳密な最適配置の価値（場のカードは山札由来でないので山札は不変）。 */
function fieldChannelValue(ctx: Ctx, slots: Color[][], pairColors: Color[], deck: ColorCounts, discard: ColorCounts): number {
  return bestDrawnPlacement(ctx, slots, pairColors, deck, discard).value;
}

/**
 * 山札ドローの取得チャネル値。山札は「山札・捨札の色分布に従う i.i.d. ランダムな 2 枚」とみなすが、これは
 * `tHat` が積み増し見積りで **既に前提・計算している**ものそのもの。「山札から引いて最適に積み、
 * 以降最適に打つ」価値は、現盤面の期待 G 到達ターン数 T(S) からそのまま導ける:
 *
 *   T(S) = 1 + E_draw[ min_配置 T(S') ]   ⟹   E_draw[ max_配置 gValue(S') ] = 1 − T(S)
 *
 * （T(S) は今ターンのドローを含むので、ドロー後の残り＝T(S)−1。`gValue=−T`）。全色組の列挙も配置探索も不要で、
 * 現盤面の T(S)（`tHat` のメモ/キャッシュ＝前計算）を 1 回使うだけ。サンプリングのノイズも無く、
 * 積み増し評価と完全に整合する。発火盤面（取得局面では通常起きない）は gValue にフォールバック。
 */
function deckChannelValue(ctx: Ctx, slots: Color[][], deck: ColorCounts, discard: ColorCounts): number {
  if (totalCount(deck) + totalCount(discard) < 1) return -Infinity; // 引くカードが無い
  if (fireSlots(slots)) return gValue(ctx, slots, deck, discard); // 念のため（取得局面は非発火のはず）
  return 1 - tHat(ctx, slots, deck, discard);
}

// ---------------------------------------------------------------------------
// 終盤モード（§6.6）
// ---------------------------------------------------------------------------

/** 勝つために必要な最終累計（computeWinner のタイブレークに従う）。 */
function requiredFinalScore(state: GameState, me: number): number {
  const n = state.players.length;
  const myDist = (me - state.startPlayerIndex + n) % n;
  let req = 0;
  for (const opp of state.players) {
    if (opp.id === me) continue;
    const oppDist = (opp.id - state.startPlayerIndex + n) % n;
    // 手番が先（dist 小）の相手には同点で負ける → 厳密に上回る必要（+1）。後の相手は同点で勝てる。
    const need = oppDist < myDist ? opp.score + 1 : opp.score;
    if (need > req) req = need;
  }
  return req;
}

/** このターンの目標 (V, P, endgame) を決める。 */
function effectiveTarget(state: GameState, me: number, opt: ResolvedOptions): { V: number; P: number; endgame: boolean } {
  // 他者が引き金で最終ラウンドに突入済みか
  if (state.endTriggered && state.endTriggerPlayerId !== null && state.endTriggerPlayerId !== me) {
    const need = requiredFinalScore(state, me) - state.players[me].score;
    if (need > 0) {
      // 追い込み: V=必要追加得点、P 無効化（argmax q）
      return { V: need, P: 0, endgame: true };
    }
    // すでに暫定勝者 → 通常運用に戻す（無理な大連鎖は狙わない、§6.6a）
  }
  return { V: opt.V, P: opt.P, endgame: false };
}

// ---------------------------------------------------------------------------
// 配り（§6.5）
// ---------------------------------------------------------------------------

function buildGiftAssignments(state: GameState, me: number): GiftAssignment[] {
  const queue = state.turn.giftQueue;
  const opponents = state.players.filter((p) => p.id !== me);
  if (opponents.length === 0) {
    // 相手不在は理論上起きないが、安全に最初のカードを自分以外不可のため空配り不可。
    return queue.map((combo, comboIndex) => ({ comboIndex, cardId: combo.cards[0].id, targetPlayerId: me }));
  }
  return queue.map((combo, comboIndex) => {
    // 相手の連鎖準備度を最も上げない (card, target) を選ぶ。同等なら弱い相手（低スコア）へ。
    let bestCardId = combo.cards[0].id;
    let bestTarget = opponents[0].id;
    let bestHarm = Infinity;
    for (const card of combo.cards) {
      for (const op of opponents) {
        const harm = topColorCount(op, card.color) * 1000 + op.score;
        if (harm < bestHarm) {
          bestHarm = harm;
          bestCardId = card.id;
          bestTarget = op.id;
        }
      }
    }
    return { comboIndex, cardId: bestCardId, targetPlayerId: bestTarget };
  });
}

// ---------------------------------------------------------------------------
// フォールバック（例外時にシミュレーションを止めないため）
// ---------------------------------------------------------------------------

function fallbackAction(state: GameState, me: number): Action | null {
  if (state.phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== me) return null;
    const queue = state.turn.giftQueue;
    const opp = state.players.filter((p) => p.id !== me);
    if (queue.length === 0) return { type: 'CONFIRM_GIFTS', assignments: [] };
    const targetId = opp.length > 0 ? opp[0].id : me;
    return {
      type: 'CONFIRM_GIFTS',
      assignments: queue.map((combo, comboIndex) => ({ comboIndex, cardId: combo.cards[0].id, targetPlayerId: targetId })),
    };
  }
  const ids = legalActionIds(state, me);
  if (ids.length === 0) return null;
  return actionIdToAction(state, me, ids[0]);
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

export function decideAction(
  state: GameState,
  playerId: number,
  _seed?: number, // GRM は決定論的なので未使用（AI 共通シグネチャに合わせて受理のみ）
  options: GrmOptions = {}
): Action | null {
  const opt: ResolvedOptions = {
    V: options.V ?? DEFAULTS.V,
    P: options.P ?? DEFAULTS.P,
    H: options.H ?? DEFAULTS.H,
    K: options.K ?? DEFAULTS.K,
    maxNodes: options.maxNodes ?? DEFAULTS.maxNodes,
    timeBudgetMs: options.timeBudgetMs ?? Infinity,
  };
  try {
    const a = decideInner(state, playerId, opt);
    if (a) return a;
  } catch {
    // q の展開上限超過などは握りつぶしてフォールバック（シミュレーション継続を優先）
  }
  return fallbackAction(state, playerId);
}

function decideInner(state: GameState, me: number, opt: ResolvedOptions): Action | null {
  const phase = state.phase;

  // --- プレゼント配り（自分のコンボの配り先決定）---
  if (phase === 'awaitingGiftSelection') {
    if (state.currentPlayerIndex !== me) return null;
    return { type: 'CONFIRM_GIFTS', assignments: buildGiftAssignments(state, me) };
  }

  // --- プレゼント受領配置（§6.4。発火しないので「仕込み」として価値最大化）---
  if (phase === 'awaitingGiftPlacement') {
    const batch = state.turn.pendingGiftBatches[0];
    if (!batch || batch.recipientId !== me) return null;
    const card = batch.cards[0];
    if (!card) return null;
    const ctx = makeCtx(opt, opt.V, opt.P, false);
    const slots = myColors(state, me);
    const { slot } = bestDrawnPlacement(ctx, slots, [card.color], colorCounts(state.deck), colorCounts(state.discardPile));
    return { type: 'PLACE_GIFT', cardId: card.id, slotIndex: slot };
  }

  if (state.currentPlayerIndex !== me) return null;

  const tgt = effectiveTarget(state, me, opt);
  const ctx = makeCtx(opt, tgt.V, tgt.P, tgt.endgame);
  const slots = myColors(state, me);
  const deck = colorCounts(state.deck);
  const discard = colorCounts(state.discardPile);
  const cc = state.turn.combosThisTurn.length;
  const base = sumBasePoints(state);

  switch (phase) {
    case 'awaitingDraw': {
      let bestVal = -Infinity;
      let bestAction: Action | null = null;
      const consider = (action: Action, value: number) => {
        if (value > bestVal) {
          bestVal = value;
          bestAction = action;
        }
      };
      // チャネル列挙。同色構成の場ペアは値が同一になるはずなので 1 回だけ評価して共有する
      // （順次評価の予算劣化で同色ペアの値が割れて無駄な再評価に予算を使うのを防ぐ。
      //   tie は consider の > 比較＝先勝ちのままなので、共有しても選択規約は不変）。
      const pairVals = new Map<string, number>();
      const channels: { action: Action; evalFn: () => number }[] = [];
      for (const pi of [0, 1] as const) {
        const pair = state.field[pi];
        if (!pair) continue;
        const key = [pair[0].color, pair[1].color].sort().join(',');
        channels.push({
          action: { type: 'DRAW_FROM_FIELD', pairIndex: pi },
          evalFn: () => {
            const hit = pairVals.get(key);
            if (hit !== undefined) return hit;
            const v = fieldChannelValue(ctx, slots, [pair[0].color, pair[1].color], deck, discard);
            pairVals.set(key, v);
            return v;
          },
        });
      }
      if (totalCount(deck) > 0 || totalCount(discard) > 0) {
        channels.push({ action: { type: 'DRAW_FROM_DECK' }, evalFn: () => deckChannelValue(ctx, slots, deck, discard) });
      }
      // 予算のチャネル別チェックポイント（累積 (i+1)/n）。一本の期限だと前段が予算を使い切ったとき
      // 後段チャネルだけが縮約評価に劣化し、比較が系統的に歪む（同色ペアで値割れを実測）。
      // 小期限を順に課すことで公平化する（早く終わった分は自然に後段へ繰り越し）。
      const globalDeadline = ctx.deadline;
      if (opt.timeBudgetMs !== Infinity && channels.length > 1) {
        const t0 = Date.now();
        channels.forEach((ch, i) => {
          ctx.deadline = Math.min(globalDeadline, t0 + (opt.timeBudgetMs * (i + 1)) / channels.length);
          consider(ch.action, ch.evalFn());
        });
        ctx.deadline = globalDeadline;
      } else {
        for (const ch of channels) consider(ch.action, ch.evalFn());
      }
      return bestAction;
    }

    case 'awaitingPlaceDrawn': {
      const pending = state.turn.pendingDraw;
      if (pending.length === 0) return null;
      // どのカードを先にどのスロットへ置くか（同一スロット積みの上下順も含めて）最適化する。
      const { firstColor, slot } = bestDrawnPlacement(ctx, slots, pending.map((c) => c.color), deck, discard);
      const card = pending.find((c) => c.color === firstColor) ?? pending[0];
      return { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: slot };
    }

    case 'awaitingAdditionalActionChoice': {
      // 連鎖中: q の後退帰納に従う（このターンの P(得点 ≥ V) を最大化）
      const dec = ctx.solver.bestDecision(slots, cc, base, deck, discard);
      if (dec.kind === 'discard') return { type: 'CHOOSE_ADDITIONAL_DISCARD' };
      return { type: 'CHOOSE_ADDITIONAL_DRAW' };
    }

    case 'awaitingPlaceAdditionalDraw': {
      const card = state.turn.pendingAdditionalDraw;
      if (!card) return null;
      const slot = ctx.solver.bestPlacementSlot(slots, cc, base, deck, discard, card.color);
      return { type: 'PLACE_ADDITIONAL_DRAW', slotIndex: slot };
    }

    case 'awaitingAdditionalDiscard': {
      let slot = ctx.solver.bestDiscardSlot(slots, cc, base, deck, discard);
      // 念のため非空スロットを保証
      if (!slots[slot] || slots[slot].length === 0) {
        slot = slots.findIndex((s) => s.length > 0);
        if (slot < 0) return null;
      }
      return { type: 'DISCARD_TOP', slotIndex: slot };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 診断: 人間の手番で、実装した q / GRM 評価をコンソールに出力する（確率検証用）
// ---------------------------------------------------------------------------

const PAIR = (p: FieldPair): string => (p ? `${p[0].color[0]}${p[1].color[0]}` : '-');

/**
 * 現在の局面（主に人間プレイヤーの手番）を、実装した q / GRM 評価でコンソールに出力する。
 * 連鎖局面では各候補手の「このターン得点 ≥ V となる確率」（＝ q の後退帰納値）を直接表示する。
 * 確率が正しく計算されているかを実プレイで確認するための診断専用（ゲーム進行には影響しない）。
 */
export function logHumanEvaluation(state: GameState, playerId: number, options: GrmOptions = {}): void {
  const opt: ResolvedOptions = {
    V: options.V ?? DEFAULTS.V,
    P: options.P ?? DEFAULTS.P,
    H: options.H ?? DEFAULTS.H,
    K: options.K ?? DEFAULTS.K,
    maxNodes: options.maxNodes ?? DEFAULTS.maxNodes,
    timeBudgetMs: options.timeBudgetMs ?? Infinity,
  };
  const slots = myColors(state, playerId);
  const deck = colorCounts(state.deck);
  const discard = colorCounts(state.discardPile);
  const tgt = effectiveTarget(state, playerId, opt);
  const ctx = makeCtx(opt, tgt.V, tgt.P, tgt.endgame);
  const cc = state.turn.combosThisTurn.length;
  const base = sumBasePoints(state);

  const lines: string[] = [];
  lines.push(
    `turn=${state.turnNumber} phase=${state.phase} | 目標 V=${tgt.V}${tgt.endgame ? '(終盤モード)' : ''} P=${tgt.P}` +
      ` | 既出コンボ ${cc}本 基礎${base}点 | 山札${totalCount(deck)}枚 捨札${totalCount(discard)}枚`
  );
  lines.push(`自盤面(下→上): ${slots.map((s, i) => `#${i}[${s.map((c) => c[0]).join('') || '·'}]`).join(' ')}`);

  // 現盤面そのものを「いま発火させた場合」の q（V を変えて分布を見る）
  if (fireSlots(slots)) {
    const fs = [10, 15, 20]
      .map((V) => `q(≥${V})=${createChainSolver(V, opt.K, opt.maxNodes).resolveValue(slots, 0, 0, deck, discard).toFixed(3)}`)
      .join('  ');
    lines.push(`現盤面は発火状態 → ${fs}`);
  } else {
    lines.push('現盤面は非発火（最上段に同色3枚以上なし）→ q は適用外');
  }

  // フェーズ別: 各候補手の評価
  const moveLines = evaluateMovesForLog(ctx, state, slots, deck, discard, opt, cc, base);
  lines.push(...moveLines.map((l) => '  ' + l));

  // ブラウザ devtools / Node どちらでも見やすいよう装飾付きで1回出力
  /* eslint-disable no-console */
  if (typeof window !== 'undefined') {
    console.log('%c[GRM eval]', 'color:#5cf;font-weight:bold', '\n' + lines.join('\n'));
  } else {
    console.log('[GRM eval]\n' + lines.join('\n'));
  }
  /* eslint-enable no-console */
}

function evaluateMovesForLog(
  ctx: Ctx,
  state: GameState,
  slots: Color[][],
  deck: ColorCounts,
  discard: ColorCounts,
  opt: ResolvedOptions,
  cc: number,
  base: number
): string[] {
  const star = (v: number, best: number) => (v >= best - 1e-12 ? ' ←最良' : '');
  // gValue（=−G到達期待ターン数）を人間向けに言い換える。0付近=G到達可、負=期待ターン数。
  const turnsLabel = (v: number): string => {
    if (ctx.endgame) return `q=${v.toFixed(3)}`;
    if (v >= -1e-3) return 'G到達可(勝負手)';
    if (-v >= EXHAUST_TURNS) return `到達困難(>${EXHAUST_TURNS}ターン)`;
    return `期待約${(-v).toFixed(1)}ターンでG`;
  };
  switch (state.phase) {
    case 'awaitingDraw': {
      // 表示の注意 2 点: (1) 同色ペアは値が同一になるはずなので 1 回だけ評価して共有する
      // （順番に評価すると後の方だけ時間予算の劣化を受け、同色なのに値が違って見える）。
      // (2) 評価開始時点で予算が尽きていたチャネルは縮約評価＝概算なので「（概算）」を付す。
      const items: { d: string; v: number; approx: boolean }[] = [];
      const seenPair = new Map<string, number>();
      const fieldVal = (pair: NonNullable<FieldPair>): { v: number; approx: boolean } => {
        const key = [pair[0].color, pair[1].color].sort().join(',');
        const hit = seenPair.get(key);
        if (hit !== undefined) return { v: hit, approx: false };
        const approx = pastDeadline(ctx);
        const v = fieldChannelValue(ctx, slots, [pair[0].color, pair[1].color], deck, discard);
        seenPair.set(key, v);
        return { v, approx };
      };
      if (state.field[0]) items.push({ d: `場0(${PAIR(state.field[0])})`, ...fieldVal(state.field[0]) });
      if (state.field[1]) items.push({ d: `場1(${PAIR(state.field[1])})`, ...fieldVal(state.field[1]) });
      if (totalCount(deck) > 0 || totalCount(discard) > 0) {
        const approx = pastDeadline(ctx);
        items.push({ d: '山札ドロー', v: deckChannelValue(ctx, slots, deck, discard), approx });
      }
      const best = Math.max(...items.map((i) => i.v));
      return [
        '取得チャネル別の見込み（G到達までの期待ターン数。少ないほど良い）:',
        ...items.map((i) => `${i.d}: ${turnsLabel(i.v)}${i.approx ? '（概算: 予算超過で縮約評価）' : ''}${star(i.v, best)}`),
      ];
    }
    case 'awaitingPlaceDrawn': {
      const pend = state.turn.pendingDraw.map((c) => c.color);
      if (pend.length === 0) return [];
      // 全角フォントで列幅が崩れないよう、セル値は ASCII のみ（∞ ではなく >50 表記）。
      const compact = (v: number) => (v >= -1e-3 ? 'G' : -v >= EXHAUST_TURNS ? `>${EXHAUST_TURNS}` : (-v).toFixed(1));
      // 列ずれ防止: 値は表全体の最大幅へ右寄せし、最良印の 1 文字分は印が付かないセルにも常に確保する。
      const table = (rows: { label: string; vals: number[] }[]): string[] => {
        const best = Math.max(...rows.flatMap((r) => r.vals));
        const w = Math.max(...rows.flatMap((r) => r.vals.map((v) => compact(v).length)));
        return rows.map(
          (r) => `${r.label}: ${r.vals.map((v, j) => `#${j}=${compact(v).padStart(w)}${v >= best - 1e-12 ? '*' : ' '}`).join(' ')}`
        );
      };
      if (pend.length === 2) {
        // 全積み方を列挙: 「1枚目の色@スロット → 2枚目のスロット別」（同一スロット重ねは上下順で別経路。
        // 同色 2 枚は交換可能なので片順のみ）。各行 5 値 × 最大 10 行 = 50 通りの完全表示。
        const distinct: Color[] = [];
        for (const c of pend) if (!distinct.includes(c)) distinct.push(c);
        const rows: { label: string; vals: number[] }[] = [];
        for (const c of distinct) {
          const idx = pend.indexOf(c);
          const other = pend.slice(0, idx).concat(pend.slice(idx + 1))[0];
          for (let j = 0; j < slots.length; j++) {
            const b1 = placeColorOnSlots(slots, j, c, opt.K);
            rows.push({
              label: `${c[0]}@#${j}→${other[0]}`,
              vals: slots.map((_, j2) => gValue(ctx, placeColorOnSlots(b1, j2, other, opt.K), deck, discard)),
            });
          }
        }
        return [
          `手札[${pend.map((c) => c[0]).join(',')}] を配置（1枚目@スロット → 2枚目スロット別の G到達期待ターン数。同一スロット重ねは上下順で別経路。G=到達, >${EXHAUST_TURNS}=到達困難, *=全体最良）:`,
          ...table(rows),
        ];
      }
      // 1 枚（2 枚目の配置決定）: スロット別の値をそのまま表示。
      const distinct: Color[] = [];
      for (const c of pend) if (!distinct.includes(c)) distinct.push(c);
      const rows = distinct.map((c) => {
        const idx = pend.indexOf(c);
        const rest = pend.slice(0, idx).concat(pend.slice(idx + 1));
        return { c, vals: slots.map((_, j) => placeAllValue(ctx, placeColorOnSlots(slots, j, c, opt.K), rest, deck, discard)) };
      });
      return [
        `手札[${pend.map((c) => c[0]).join(',')}] を配置（スロット別の G到達期待ターン数。G=到達, >${EXHAUST_TURNS}=到達困難, *=最良）:`,
        ...table(rows.map((r) => ({ label: r.c[0], vals: r.vals }))),
      ];
    }
    case 'awaitingAdditionalActionChoice': {
      const out: string[] = [`連鎖中の追加アクション別 P(このターン得点 ≥ ${ctx.V}):`];
      const cand: number[] = [];
      slots.forEach((s, j) => {
        if (s.length > 0) {
          const removed = s[s.length - 1];
          const cs = slots.map((x, i) => (i === j ? x.slice(0, -1) : x));
          const v = ctx.solver.resolveValue(cs, cc, base, deck, addCount(discard, removed, 1));
          cand.push(v);
          out.push(`削除 #${j}(${removed[0]}): ${v.toFixed(3)}`);
        }
      });
      const decVal = ctx.solver.decideValue(slots, cc, base, deck, discard);
      const dec = ctx.solver.bestDecision(slots, cc, base, deck, discard);
      out.push(`最適手=${dec.kind === 'discard' ? `削除#${dec.slot}` : dec.kind === 'draw' ? 'ドロー&配置' : '終端'} で P(≥${ctx.V})=${decVal.toFixed(3)}`);
      return out;
    }
    case 'awaitingPlaceAdditionalDraw': {
      const card = state.turn.pendingAdditionalDraw;
      if (!card) return [];
      const vals = slots.map((_, j) => ctx.solver.resolveValue(placeColorOnSlots(slots, j, card.color, opt.K), cc, base, deck, discard));
      const best = Math.max(...vals);
      return [`引いた ${card.color} の置き場所別 P(このターン得点 ≥ ${ctx.V}):`, ...vals.map((v, j) => `#${j}: ${v.toFixed(3)}${star(v, best)}`)];
    }
    case 'awaitingAdditionalDiscard': {
      const out: string[] = [`削除スロット別 P(このターン得点 ≥ ${ctx.V}):`];
      const cand: { j: number; v: number }[] = [];
      slots.forEach((s, j) => {
        if (s.length > 0) {
          const removed = s[s.length - 1];
          const cs = slots.map((x, i) => (i === j ? x.slice(0, -1) : x));
          cand.push({ j, v: ctx.solver.resolveValue(cs, cc, base, deck, addCount(discard, removed, 1)) });
        }
      });
      const best = Math.max(...cand.map((c) => c.v));
      cand.forEach((c) => out.push(`#${c.j}(${slots[c.j][slots[c.j].length - 1][0]}): ${c.v.toFixed(3)}${star(c.v, best)}`));
      return out;
    }
    default:
      return [];
  }
}

function makeCtx(opt: ResolvedOptions, V: number, P: number, endgame: boolean): Ctx {
  decisionCount++;
  return {
    solver: createChainSolver(V, opt.K, opt.maxNodes),
    V,
    P,
    H: opt.H,
    K: opt.K,
    endgame,
    memoT: new Map<string, number>(),
    deadline: opt.timeBudgetMs === Infinity ? Infinity : Date.now() + opt.timeBudgetMs,
  };
}

// --- 時間予算の劣化追跡（フォールバックを黙らせない）---
let decisionCount = 0;
let degradedDecisionCount = 0;
let degradedMarker = -1; // 劣化を計上済みの decision 番号（1 決定 1 カウント）
/** 期限超過の劣化が起きたことを記録する（同一決定内は 1 回だけ数える）。 */
function markDegraded(): void {
  if (degradedMarker !== decisionCount) {
    degradedMarker = decisionCount;
    degradedDecisionCount++;
  }
}
/** 期限超過か（無制限なら常に false）。 */
function pastDeadline(ctx: Ctx): boolean {
  return ctx.deadline !== Infinity && Date.now() >= ctx.deadline;
}
/** 時間予算による劣化の発生状況（ベンチ・プローブが読む）。 */
export function budgetStats(): { decisions: number; degraded: number } {
  return { decisions: decisionCount, degraded: degradedDecisionCount };
}

/**
 * ベンチ用: 非発火盤面の「G 到達までの期待ターン数」の見積り（T̂ ヒューリスティック本体）を外部から呼ぶ。
 * 小盤面で厳密 T* と突き合わせて近似誤差を測るために公開する（§6.1.2 / §8-7）。
 */
export function estimateTHat(
  slots: Color[][],
  deck: ColorCounts,
  discard: ColorCounts,
  options: GrmOptions = {}
): number {
  const opt: ResolvedOptions = {
    V: options.V ?? DEFAULTS.V,
    P: options.P ?? DEFAULTS.P,
    H: options.H ?? DEFAULTS.H,
    K: options.K ?? DEFAULTS.K,
    maxNodes: options.maxNodes ?? DEFAULTS.maxNodes,
    timeBudgetMs: options.timeBudgetMs ?? Infinity,
  };
  return tHat(makeCtx(opt, opt.V, opt.P, false), slots, deck, discard);
}
