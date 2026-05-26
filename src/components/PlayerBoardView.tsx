import type { Player } from '../game/types';
import { CardView } from './CardView';
import { SlotView } from './SlotView';

interface Props {
  player: Player;
  isCurrent: boolean;
  isYou: boolean;
  size?: 'sm' | 'md' | 'lg';
  orientation?: 'horizontal' | 'vertical';
  interactiveSlotIndices?: number[];
  highlightedSlotIndices?: number[];
  onSlotClick?: (slotIndex: number) => void;
}

export function PlayerBoardView({
  player,
  isCurrent,
  isYou,
  size = 'md',
  orientation = 'horizontal',
  interactiveSlotIndices,
  highlightedSlotIndices,
  onSlotClick,
}: Props) {
  return (
    <section
      className={`player-board player-board-${orientation}${isCurrent ? ' player-current' : ''}${isYou ? ' player-you' : ''}`}
      aria-label={`${player.name}のボード`}
    >
      <header className="player-header">
        <span className="player-name">
          {isYou ? '★ ' : ''}
          {player.name}
        </span>
        <span className="player-score">{player.score}点</span>
      </header>
      <div className={`slot-row slot-row-${size} slot-row-${orientation}`}>
        {player.board.slots.map((slot, idx) => (
          <SlotView
            key={idx}
            slot={slot}
            index={idx}
            size={size}
            interactive={interactiveSlotIndices?.includes(idx) ?? false}
            highlighted={highlightedSlotIndices?.includes(idx) ?? false}
            onClick={() => onSlotClick?.(idx)}
          />
        ))}
      </div>
      {player.pendingGifts.length > 0 && (
        <div className="pending-gifts">
          <span className="pending-gifts-label">贈られた</span>
          <div className="pending-gifts-list">
            {player.pendingGifts.map((c) => (
              <CardView key={c.id} card={c} size="sm" />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
