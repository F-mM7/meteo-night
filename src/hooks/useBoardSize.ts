import { useEffect, useState } from 'react';

export interface BoardDims {
  boardSize: number;
  seatSize: number;
  centerSize: number;
  cardSize: number;
  actionHeight: number;
}

const HEADER_HEIGHT = 36;
const MIN_ACTION_HEIGHT = 170;
const PADDING = 2;
const MAX_BOARD = 1400;
const SEAT_RATIO = 1 / 3;
const CARDS_PER_SEAT_LONG = 5.4;

function calc(): BoardDims {
  if (typeof window === 'undefined') {
    const bs = 700;
    const ss = Math.floor(bs * SEAT_RATIO);
    return {
      boardSize: bs,
      seatSize: ss,
      centerSize: bs - ss * 2,
      cardSize: Math.floor(ss / CARDS_PER_SEAT_LONG),
      actionHeight: 200,
    };
  }
  const w = window.innerWidth;
  const h = window.innerHeight;

  const availableW = w - PADDING * 2;
  const availableH = h - HEADER_HEIGHT - PADDING * 2;

  const boardLimit = Math.min(availableW, availableH - MIN_ACTION_HEIGHT - PADDING);
  const boardSize = Math.min(MAX_BOARD, Math.max(280, boardLimit));
  const actionHeight = Math.max(MIN_ACTION_HEIGHT, availableH - boardSize - PADDING);

  const seatSize = Math.floor(boardSize * SEAT_RATIO);
  const centerSize = boardSize - seatSize * 2;
  const cardSize = Math.max(20, Math.floor(seatSize / CARDS_PER_SEAT_LONG));

  return { boardSize, seatSize, centerSize, cardSize, actionHeight };
}

export function useBoardSize(): BoardDims {
  const [dims, setDims] = useState<BoardDims>(calc);
  useEffect(() => {
    const update = () => setDims(calc());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return dims;
}
