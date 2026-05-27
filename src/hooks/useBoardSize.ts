import { useEffect, useState } from 'react';

export interface BoardDims {
  boardSize: number;
  seatShort: number;
  seatLong: number;
  centerSize: number;
  cardSize: number;
  actionHeight: number;
  layout: 'vertical' | 'horizontal';
}

const HEADER_HEIGHT = 36;
const MIN_LOG_WIDTH = 260;
const PADDING = 2;
const MAX_BOARD = 1400;
// 盤面構成 (cardSize 単位):
//   board = seatShort(3.2) + center(5.4) + seatShort(3.2) = 11.8
const SEAT_SHORT_RATIO = 3.2;
const SEAT_LONG_RATIO = 5.4;
const BOARD_TOTAL_RATIO = SEAT_LONG_RATIO + SEAT_SHORT_RATIO * 2;
// アクション領域に必要な高さ: ActionPanel + hand-zone + padding
//   = base(80) + cardSize * 1.2
//   gift-bar (1行) は常に約 110px に収まるよう設計
const ACTION_BASE_HEIGHT = 80;
const ACTION_CARD_RATIO = 1.2;
const MIN_ACTION_HEIGHT = 190;

function deriveSizes(boardSize: number) {
  const cardSize = Math.max(20, Math.floor(boardSize / BOARD_TOTAL_RATIO));
  const seatShort = Math.floor(cardSize * SEAT_SHORT_RATIO);
  const seatLong = Math.floor(cardSize * SEAT_LONG_RATIO);
  const centerSize = boardSize - seatShort * 2;
  return { cardSize, seatShort, seatLong, centerSize };
}

// 与えられた boardSize から想定されるアクション領域の必要高さを返す
function actionHeightFromBoard(boardSize: number): number {
  const cardSize = boardSize / BOARD_TOTAL_RATIO;
  return Math.max(MIN_ACTION_HEIGHT, ACTION_BASE_HEIGHT + cardSize * ACTION_CARD_RATIO);
}

// 縦の制約から最大 boardSize を求める:
//   board + action(board) + PADDING = availableH
//   board + (BASE + board/RATIO * ACTION_RATIO) + PADDING = availableH
//   board * (1 + ACTION_RATIO/RATIO) = availableH - BASE - PADDING
function solveBoardByHeight(availableH: number): number {
  return Math.floor(
    ((availableH - ACTION_BASE_HEIGHT - PADDING) * BOARD_TOTAL_RATIO) /
      (BOARD_TOTAL_RATIO + ACTION_CARD_RATIO)
  );
}

function calc(): BoardDims {
  if (typeof window === 'undefined') {
    const bs = 700;
    const sizes = deriveSizes(bs);
    return {
      boardSize: bs,
      ...sizes,
      actionHeight: actionHeightFromBoard(bs),
      layout: 'vertical',
    };
  }
  const w = window.innerWidth;
  const h = window.innerHeight;

  const availableW = w - PADDING * 2;
  const availableH = h - HEADER_HEIGHT - PADDING * 2;
  const layout: 'vertical' | 'horizontal' = w >= h ? 'horizontal' : 'vertical';

  const boardByH = solveBoardByHeight(availableH);
  const boardByW = layout === 'horizontal' ? availableW - MIN_LOG_WIDTH - PADDING : availableW;

  const boardLimit = Math.min(boardByH, boardByW);
  const boardSize = Math.min(MAX_BOARD, Math.max(280, boardLimit));
  const actionHeight = Math.max(
    actionHeightFromBoard(boardSize),
    availableH - boardSize - PADDING
  );
  const sizes = deriveSizes(boardSize);
  return { boardSize, ...sizes, actionHeight, layout };
}

export function useBoardSize(): BoardDims {
  const [dims, setDims] = useState<BoardDims>(() => calc());
  useEffect(() => {
    const update = () => setDims(calc());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return dims;
}
