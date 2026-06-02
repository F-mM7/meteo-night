import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Card, Slot } from '../game/types';
import { CardView } from './CardView';
import { CARD_FADE_DURATION_MS, STACK_MAX_SPAN_RATIO } from '../hooks/boardLayout';

export type StackDirection = 'down' | 'up' | 'left' | 'right';

interface Props {
  slot: Slot;
  index: number;
  cardSize: number;
  stackOffset: number;
  direction?: StackDirection;
  interactive?: boolean;
  onClick?: () => void;
  /**
   * 「取り除き（追加アクションの捨札）」由来で消えたカードのID集合。
   * ここに含まれるカードは中央から離れる方向にフェード（現状仕様）し、
   * 含まれないカード（流星魔法発動由来）は中央方向に発光しながら吸い込まれる。
   */
  discardedCardIds?: ReadonlySet<string>;
}

type FadeReason = 'launch' | 'discard';

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
  reason: FadeReason;
  /**
   * フェードエントリごとに一意な連番。React key と片付けに用いる。
   * カード ID（`${color}-${i}`）はゲームごとに再生成され一意でないため、
   * リセット直後に同 ID のフェードが重なると key 衝突・誤った早期片付けが起きる。
   */
  seq: number;
}

const PLACE_DURATION_MS = 400;

export function SlotView({
  slot,
  index,
  cardSize,
  stackOffset,
  direction = 'down',
  interactive,
  onClick,
  discardedCardIds,
}: Props) {
  const stack = slot.stack;
  const top = stack[stack.length - 1];
  const isHorizontal = direction === 'left' || direction === 'right';
  const offset = stackOffset;
  const maxSpan = cardSize * STACK_MAX_SPAN_RATIO;
  const stackWidth = isHorizontal ? maxSpan : cardSize;
  const stackHeight = isHorizontal ? cardSize : maxSpan;

  const [fadingCards, setFadingCards] = useState<FadingCard[]>([]);
  const [placingCardIds, setPlacingCardIds] = useState<Set<string>>(() => new Set());
  const prevStackRef = useRef<Card[]>(stack);
  const isInitialMountRef = useRef(true);
  const fadeSeqRef = useRef(0);

  useLayoutEffect(() => {
    const prev = prevStackRef.current;
    prevStackRef.current = stack;

    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }

    const currentIds = new Set(stack.map((c) => c.id));
    const removed = prev.filter((c) => !currentIds.has(c.id));
    const prevIds = new Set(prev.map((c) => c.id));
    const added = stack.filter((c) => !prevIds.has(c.id));

    const timers: ReturnType<typeof setTimeout>[] = [];

    if (removed.length > 0) {
      const newFading: FadingCard[] = removed.map((card) => ({
        card,
        fromIdx: prev.indexOf(card),
        reason: discardedCardIds?.has(card.id) ? 'discard' : 'launch',
        seq: fadeSeqRef.current++,
      }));
      const newSeqs = new Set(newFading.map((f) => f.seq));
      setFadingCards((curr) => [...curr, ...newFading]);
      timers.push(
        setTimeout(() => {
          setFadingCards((curr) => curr.filter((f) => !newSeqs.has(f.seq)));
        }, CARD_FADE_DURATION_MS)
      );
    }

    if (added.length > 0) {
      const addedIds = added.map((c) => c.id);
      setPlacingCardIds((curr) => {
        const next = new Set(curr);
        addedIds.forEach((id) => next.add(id));
        return next;
      });
      timers.push(
        setTimeout(() => {
          setPlacingCardIds((curr) => {
            const next = new Set(curr);
            addedIds.forEach((id) => next.delete(id));
            return next;
          });
        }, PLACE_DURATION_MS)
      );
    }

    if (timers.length === 0) return;
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, [stack, discardedCardIds]);

  return (
    <button
      type="button"
      className={`slot${interactive ? ' slot-interactive' : ''}`}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={`スロット${index + 1}${top ? `: 最上段 ${top.color}, 計 ${stack.length} 枚` : ': 空'}`}
    >
      <div
        className={`slot-stack slot-stack-${direction}`}
        style={{ width: `${stackWidth}px`, height: `${stackHeight}px` }}
      >
        {stack.length === 0 && fadingCards.length === 0 ? (
          <div
            className="slot-empty"
            style={cardPositionStyle(direction, 0, offset)}
          />
        ) : (
          stack.map((card, i) => {
            const isTop = i === stack.length - 1;
            const isPlacing = placingCardIds.has(card.id);
            const placingClass = isPlacing
              ? ` slot-stack-placing slot-stack-place-${direction}`
              : '';
            return (
              <div
                key={card.id}
                className={`slot-stack-card${isTop ? ' slot-stack-top' : ''}${placingClass}`}
                style={{ ...cardPositionStyle(direction, i, offset), zIndex: i + 1 }}
              >
                <CardView card={card} />
              </div>
            );
          })
        )}
        {fadingCards.map((f) => {
          const animClass =
            f.reason === 'launch'
              ? `slot-stack-launching slot-stack-launch-${direction}`
              : `slot-stack-fading slot-stack-fade-${direction}`;
          return (
            <div
              key={`fade-${f.seq}`}
              className={`slot-stack-card ${animClass}`}
              style={{ ...cardPositionStyle(direction, f.fromIdx, offset), zIndex: 50 }}
            >
              <CardView card={f.card} />
            </div>
          );
        })}
      </div>
    </button>
  );
}
