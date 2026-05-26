import type { CSSProperties } from 'react';
import type { Slot } from '../game/types';
import { CardView } from './CardView';

export type StackDirection = 'down' | 'up' | 'left' | 'right';

interface Props {
  slot: Slot;
  index: number;
  size?: 'sm' | 'md' | 'lg';
  direction?: StackDirection;
  interactive?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
}

const CARD_SIZE: Record<NonNullable<Props['size']>, number> = {
  sm: 48,
  md: 72,
  lg: 96,
};

const STACK_OFFSET: Record<NonNullable<Props['size']>, number> = {
  sm: 14,
  md: 20,
  lg: 26,
};

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

export function SlotView({
  slot,
  index,
  size = 'md',
  direction = 'down',
  interactive,
  highlighted,
  onClick,
}: Props) {
  const stack = slot.stack;
  const top = stack[stack.length - 1];
  const offset = STACK_OFFSET[size];
  const cardSize = CARD_SIZE[size];
  const isHorizontal = direction === 'left' || direction === 'right';
  const stackLen = Math.max(1, stack.length);
  const longSide = cardSize + (stackLen - 1) * offset;
  const stackWidth = isHorizontal ? longSide : cardSize;
  const stackHeight = isHorizontal ? cardSize : longSide;

  return (
    <button
      type="button"
      className={`slot slot-${size}${interactive ? ' slot-interactive' : ''}${highlighted ? ' slot-highlighted' : ''}`}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={`スロット${index + 1}${top ? `: 最上段 ${top.color}, 計 ${stack.length} 枚` : ': 空'}`}
    >
      <div
        className={`slot-stack slot-stack-${direction}`}
        style={{ width: `${stackWidth}px`, height: `${stackHeight}px` }}
      >
        {stack.length === 0 ? (
          <div className={`slot-empty card-${size}`}>
            <span className="slot-empty-text">空</span>
          </div>
        ) : (
          stack.map((card, i) => {
            const isTop = i === stack.length - 1;
            return (
              <div
                key={card.id}
                className={`slot-stack-card${isTop ? ' slot-stack-top' : ''}`}
                style={{ ...cardPositionStyle(direction, i, offset), zIndex: i + 1 }}
              >
                <CardView card={card} size={size} emphasized={isTop && interactive} />
              </div>
            );
          })
        )}
      </div>
    </button>
  );
}
