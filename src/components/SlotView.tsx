import type { Slot } from '../game/types';
import { CardView } from './CardView';

interface Props {
  slot: Slot;
  index: number;
  size?: 'sm' | 'md' | 'lg';
  interactive?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
}

const CARD_HEIGHT: Record<NonNullable<Props['size']>, number> = {
  sm: 48,
  md: 72,
  lg: 96,
};

const STACK_OFFSET: Record<NonNullable<Props['size']>, number> = {
  sm: 14,
  md: 20,
  lg: 26,
};

export function SlotView({ slot, index, size = 'md', interactive, highlighted, onClick }: Props) {
  const stack = slot.stack;
  const top = stack[stack.length - 1];
  const offset = STACK_OFFSET[size];
  const cardH = CARD_HEIGHT[size];
  const stackHeight = stack.length === 0 ? cardH : cardH + (stack.length - 1) * offset;

  return (
    <button
      type="button"
      className={`slot slot-${size}${interactive ? ' slot-interactive' : ''}${highlighted ? ' slot-highlighted' : ''}`}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={`スロット${index + 1}${top ? `: 最上段 ${top.color}, 計 ${stack.length} 枚` : ': 空'}`}
    >
      <div
        className={`slot-stack slot-stack-${size}`}
        style={{ height: `${stackHeight}px` }}
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
                style={{ top: `${i * offset}px`, zIndex: i + 1 }}
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
