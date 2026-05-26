import type { Player } from '../game/types';
import { SlotView, type StackDirection } from './SlotView';

interface Props {
  player: Player;
  isCurrent: boolean;
  isYou: boolean;
  cardSize: number;
  stackOffset: number;
  orientation?: 'horizontal' | 'vertical';
  stackDirection?: StackDirection;
  interactiveSlotIndices?: number[];
  highlightedSlotIndices?: number[];
  onSlotClick?: (slotIndex: number) => void;
}

export function PlayerBoardView({
  player,
  isCurrent,
  isYou,
  cardSize,
  stackOffset,
  orientation = 'horizontal',
  stackDirection = 'down',
  interactiveSlotIndices,
  highlightedSlotIndices,
  onSlotClick,
}: Props) {
  return (
    <section
      className={`player-board player-board-${orientation}${isCurrent ? ' player-current' : ''}${isYou ? ' player-you' : ''}`}
      aria-label={`${player.name}のスロット`}
    >
      <div className={`slot-row slot-row-${orientation}`}>
        {player.board.slots.map((slot, idx) => (
          <SlotView
            key={idx}
            slot={slot}
            index={idx}
            cardSize={cardSize}
            stackOffset={stackOffset}
            direction={stackDirection}
            interactive={interactiveSlotIndices?.includes(idx) ?? false}
            highlighted={highlightedSlotIndices?.includes(idx) ?? false}
            onClick={() => onSlotClick?.(idx)}
          />
        ))}
      </div>
    </section>
  );
}
