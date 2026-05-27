import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameState } from '../game/types';
import { computeStackOffset, STACK_MAX_SPAN_RATIO } from './boardLayout';

export interface BoardDims {
  boardSize: number;
  seatShort: number;
  seatLong: number;
  centerSize: number;
  cardSize: number;
  layout: 'vertical' | 'horizontal';
}

export interface BoardLayout extends BoardDims {
  stackOffset: number;
  cssVars: CSSProperties;
}

const HEADER_HEIGHT = 36;
const MIN_LOG_WIDTH = 260;
// app-main の周囲 padding（CSS の .app-main { padding } と揃える）
const APP_PADDING = 8;
// app-main grid 内の gap（board と action / log の間）
const APP_GAP = 4;
const MAX_BOARD = 1400;
// 盤面構成 (cardSize 単位):
//   board = STACK_MAX_SPAN_RATIO + SEAT_LONG_RATIO(=center) + STACK_MAX_SPAN_RATIO
// 席の短辺はスロットスタックが伸びる方向そのもの（席内に他の比率要素はない）なので、
// `STACK_MAX_SPAN_RATIO` をそのまま席の短辺比率として用いる。
const SEAT_LONG_RATIO = 5.4;
const BOARD_TOTAL_RATIO = SEAT_LONG_RATIO + STACK_MAX_SPAN_RATIO * 2;
// アクション領域に必要な高さ: ActionPanel + hand-zone + padding
//   = base(80) + cardSize * 1.2
//   gift-bar は 3 列 × 2 行（最大 6 個）を前提とし、2 行で約 162px。
//   ActionPanel(awaitingGiftSelection 中は action-buttons が空で約 24px) +
//   gap/padding(~18px) と合わせて約 204px を要するため、MIN を 220 に確保。
const ACTION_BASE_HEIGHT = 80;
const ACTION_CARD_RATIO = 1.2;
const MIN_ACTION_HEIGHT = 220;

function deriveSizes(boardSize: number) {
  const cardSize = Math.max(20, Math.floor(boardSize / BOARD_TOTAL_RATIO));
  const seatShort = Math.floor(cardSize * STACK_MAX_SPAN_RATIO);
  const seatLong = Math.floor(cardSize * SEAT_LONG_RATIO);
  const centerSize = boardSize - seatShort * 2;
  return { cardSize, seatShort, seatLong, centerSize };
}

function actionHeightFromBoard(boardSize: number): number {
  const cardSize = boardSize / BOARD_TOTAL_RATIO;
  return Math.max(MIN_ACTION_HEIGHT, ACTION_BASE_HEIGHT + cardSize * ACTION_CARD_RATIO);
}

// 縦の制約から最大 boardSize を求める。
// actionHeight は `max(MIN_ACTION_HEIGHT, BASE + cardSize * ACTION_RATIO)` の2分岐。
//   case1 (cardSize 大): board + (BASE + board/RATIO * ACTION_RATIO) + APP_GAP = availableH
//                        → board = (availableH - BASE - APP_GAP) * RATIO / (RATIO + ACTION_RATIO)
//   case2 (cardSize 小): board + MIN_ACTION_HEIGHT + APP_GAP = availableH
//                        → board = availableH - MIN_ACTION_HEIGHT - APP_GAP
// case1 解の cardSize で actionHeight が MIN 以上なら case1、そうでないなら case2 を採用。
function solveBoardByHeight(availableH: number): number {
  const case1 = Math.floor(
    ((availableH - ACTION_BASE_HEIGHT - APP_GAP) * BOARD_TOTAL_RATIO) /
      (BOARD_TOTAL_RATIO + ACTION_CARD_RATIO)
  );
  const case1CardSize = case1 / BOARD_TOTAL_RATIO;
  const case1Action = ACTION_BASE_HEIGHT + case1CardSize * ACTION_CARD_RATIO;
  if (case1Action >= MIN_ACTION_HEIGHT) {
    return case1;
  }
  return availableH - MIN_ACTION_HEIGHT - APP_GAP;
}

function calcDims(): BoardDims {
  if (typeof window === 'undefined') {
    const bs = 700;
    const sizes = deriveSizes(bs);
    return {
      boardSize: bs,
      ...sizes,
      layout: 'vertical',
    };
  }
  const w = window.innerWidth;
  const h = window.innerHeight;

  const availableW = w - APP_PADDING * 2;
  const availableH = h - HEADER_HEIGHT - APP_PADDING * 2;
  const layout: 'vertical' | 'horizontal' = w >= h ? 'horizontal' : 'vertical';

  const boardByH = solveBoardByHeight(availableH);
  const boardByW = layout === 'horizontal' ? availableW - MIN_LOG_WIDTH - APP_GAP : availableW;

  const boardLimit = Math.min(boardByH, boardByW);
  const boardSize = Math.min(MAX_BOARD, Math.max(280, boardLimit));
  const sizes = deriveSizes(boardSize);
  return { boardSize, ...sizes, layout };
}

function computeGlobalMaxStack(state: GameState): number {
  let max = 1;
  for (const p of state.players) {
    for (const s of p.board.slots) {
      if (s.stack.length > max) max = s.stack.length;
    }
  }
  return max;
}

/**
 * viewport（ウィンドウサイズ）と現在のゲーム状態から、UI 描画に必要な
 * 寸法・CSS 変数・スタックオフセットをまとめて導出するフック。
 *
 * - 寸法部分（`boardSize` 等）は state 非依存で、リサイズ時にのみ再計算する。
 * - `stackOffset` は全プレイヤーのスタック最大長から導出するため、state に依存する。
 *   2 種類の依存を 1 フックに同居させているのは、呼び出し側で
 *   `cssVars` をまとめて作る都合と、`cardSize` を共有させるため。
 */
export function useBoardLayout(state: GameState): BoardLayout {
  const [dims, setDims] = useState<BoardDims>(() => calcDims());
  useEffect(() => {
    const update = () => setDims(calcDims());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const globalMaxStack = useMemo(() => computeGlobalMaxStack(state), [state.players]);
  const stackOffset = computeStackOffset(dims.cardSize, globalMaxStack);

  // action-area は中身に応じた理論最大高さで固定する（画面サイズに依らず一定）。
  const actionAreaHeight = actionHeightFromBoard(dims.boardSize);
  const cssVars: CSSProperties = useMemo(
    () => ({
      '--card-size': `${dims.cardSize}px`,
      '--board-size': `${dims.boardSize}px`,
      '--seat-short': `${dims.seatShort}px`,
      '--gap': `${Math.max(4, Math.floor(dims.cardSize / 10))}px`,
      '--action-height': `${actionAreaHeight}px`,
    }) as CSSProperties,
    [dims.cardSize, dims.boardSize, dims.seatShort, actionAreaHeight]
  );

  return { ...dims, stackOffset, cssVars };
}
