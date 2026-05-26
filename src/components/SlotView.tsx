import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Card, Slot } from '../game/types';
import { CardView } from './CardView';

export type StackDirection = 'down' | 'up' | 'left' | 'right';

interface Props {
  slot: Slot;
  index: number;
  cardSize: number;
  stackOffset: number;
  direction?: StackDirection;
  interactive?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
}

export const STACK_OFFSET_RATIO = 0.28;
export const STACK_MAX_SPAN_RATIO = 3.2;

export function computeStackOffset(cardSize: number, stackLen: number): number {
  if (stackLen <= 1) return cardSize * STACK_OFFSET_RATIO;
  const baseOffset = cardSize * STACK_OFFSET_RATIO;
  const maxSpan = cardSize * STACK_MAX_SPAN_RATIO;
  const maxOffset = (maxSpan - cardSize) / (stackLen - 1);
  return Math.min(baseOffset, maxOffset);
}

function cardPositionStyle(direction: StackDirection, i: number, offset: number): CSSProperties {
  switch (direction) {
    case 'down':
      return { top: `${i * offset}px`, left: 0 };
    case 'up':
      return { bottom: `${i * offset}px`, left: 0 };
    case 'left':
      return { right: `${i * offset}px`, top: 0 };
    case 'right':
      return { left: `${i * offset}px`, top: 0 };
  }
}

interface FadingCard {
  card: Card;
  fromIdx: number;
}

const FADE_DURATION_MS = 700;

export function SlotView({
  slot,
  index,
  cardSize,
  stackOffset,
  direction = 'down',
  interactive,
  highlighted,
  onClick,
}: Props) {
  const stack = slot.stack;
  const top = stack[stack.length - 1];
  const isHorizontal = direction === 'left' || direction === 'right';
  const offset = stackOffset;
  const maxSpan = cardSize * STACK_MAX_SPAN_RATIO;
  const stackWidth = isHorizontal ? maxSpan : cardSize;
  const stackHeight = isHorizontal ? cardSize : maxSpan;

  const [fadingCards, setFadingCards] = useState<FadingCard[]>([]);
  const prevStackRef = useRef<Card[]>(stack);

  useEffect(() => {
    const prev = prevStackRef.current;
    prevStackRef.current = stack;
    const currentIds = new Set(stack.map((c) => c.id));
    const removed = prev.filter((c) => !currentIds.has(c.id));
    if (removed.length === 0) return;
    const newFading: FadingCard[] = removed.map((card) => ({
      card,
      fromIdx: prev.indexOf(card),
    }));
    setFadingCards((curr) => [...curr, ...newFading]);
    const timer = setTimeout(() => {
      setFadingCards((curr) =>
        curr.filter((f) => !newFading.some((nf) => nf.card.id === f.card.id))
      );
    }, FADE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [stack]);

  return (
    <button
      type="button"
      className={`slot${interactive ? ' slot-interactive' : ''}${highlighted ? ' slot-highlighted' : ''}`}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={`スロット${index + 1}${top ? `: 最上段 ${top.color}, 計 ${stack.length} 枚` : ': 空'}`}
    >
      <div
        className={`slot-stack slot-stack-${direction}`}
        style={{ width: `${stackWidth}px`, height: `${stackHeight}px` }}
      >
        {stack.length === 0 && fadingCards.length === 0 ? (
          <div className="slot-empty" />
        ) : (
          stack.map((card, i) => {
            const isTop = i === stack.length - 1;
            return (
              <div
                key={card.id}
                className={`slot-stack-card${isTop ? ' slot-stack-top' : ''}`}
                style={{ ...cardPositionStyle(direction, i, offset), zIndex: i + 1 }}
              >
                <CardView card={card} emphasized={isTop && interactive} />
              </div>
            );
          })
        )}
        {fadingCards.map((f) => (
          <div
            key={`fade-${f.card.id}`}
            className={`slot-stack-card slot-stack-fading slot-stack-fade-${direction}`}
            style={{ ...cardPositionStyle(direction, f.fromIdx, offset), zIndex: 50 }}
          >
            <CardView card={f.card} />
          </div>
        ))}
      </div>
    </button>
  );
}
