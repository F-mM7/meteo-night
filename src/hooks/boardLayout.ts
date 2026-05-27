/**
 * スロットのスタック描画に関する共有定数・純粋関数。
 *
 * - `STACK_MAX_SPAN_RATIO`: スタックが取れる最大の総長（カード幅比）。
 *   `SlotView`（描画）と `useBoardLayout`（CSS 寸法導出 = 席の短辺）の双方が共有するため、
 *   コンポーネント側ではなく hook 層のニュートラルな場所に置く。
 *   この値を小さくすると、席の短辺が縮んで盤面 cardSize が拡大される一方、
 *   ベースオフセット（`STACK_OFFSET_RATIO`）で重ねられる最大枚数が減るため、
 *   スタックが多いときの密度が増す。
 */
const STACK_OFFSET_RATIO = 0.28;
export const STACK_MAX_SPAN_RATIO = 2;

/**
 * スタック内枚数 `stackLen` に応じて、各カード間のオフセットを返す。
 * 枚数が増えすぎても最大スパンに収まるよう、基本オフセットと
 * 最大スパン由来オフセットの小さい方を採用する。
 */
export function computeStackOffset(cardSize: number, stackLen: number): number {
  if (stackLen <= 1) return cardSize * STACK_OFFSET_RATIO;
  const baseOffset = cardSize * STACK_OFFSET_RATIO;
  const maxSpan = cardSize * STACK_MAX_SPAN_RATIO;
  const maxOffset = (maxSpan - cardSize) / (stackLen - 1);
  return Math.min(baseOffset, maxOffset);
}
