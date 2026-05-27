import type { Player } from '../game/types';
import { SlotView, type StackDirection } from './SlotView';

export type SeatPosition = 'top' | 'bottom' | 'left' | 'right';
type Orientation = 'horizontal' | 'vertical';

const SEAT_LAYOUT: Record<SeatPosition, { orientation: Orientation; stackDirection: StackDirection }> = {
  top: { orientation: 'horizontal', stackDirection: 'up' },
  bottom: { orientation: 'horizontal', stackDirection: 'down' },
  left: { orientation: 'vertical', stackDirection: 'left' },
  right: { orientation: 'vertical', stackDirection: 'right' },
};

interface Props {
  player: Player;
  cardSize: number;
  stackOffset: number;
  seat: SeatPosition;
  interactiveSlotIndices?: number[];
  onSlotClick?: (slotIndex: number) => void;
  discardedCardIds?: ReadonlySet<string>;
}

export function PlayerBoardView({
  player,
  cardSize,
  stackOffset,
  seat,
  interactiveSlotIndices,
  onSlotClick,
  discardedCardIds,
}: Props) {
  const { orientation, stackDirection } = SEAT_LAYOUT[seat];
  return (
    <section
      className={`player-board player-board-${orientation}`}
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
            onClick={() => onSlotClick?.(idx)}
            discardedCardIds={discardedCardIds}
          />
        ))}
      </div>
    </section>
  );
}
