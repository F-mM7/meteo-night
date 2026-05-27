import type { FieldPair, Player } from '../game/types';
import { FieldView } from './FieldView';
import { PlayerHeader } from './PlayerHeader';
import { StartPlayerMarker } from './StartPlayerMarker';

type SeatPosition = 'top' | 'left' | 'right' | 'bottom';

interface Props {
  field: [FieldPair, FieldPair];
  deckSize: number;
  interactivePairs?: number[];
  onPairClick?: (index: 0 | 1) => void;
  onDeckClick?: () => void;
  canDrawFromDeck?: boolean;
  topPlayer: Player | null;
  leftPlayer: Player | null;
  rightPlayer: Player | null;
  bottomPlayer: Player | null;
  currentPlayerIndex: number;
  startPlayerIndex: number;
  youId: number;
}

export function CenterArea(props: Props) {
  const {
    field,
    deckSize,
    interactivePairs,
    onPairClick,
    onDeckClick,
    canDrawFromDeck,
    topPlayer,
    leftPlayer,
    rightPlayer,
    bottomPlayer,
    currentPlayerIndex,
    startPlayerIndex,
    youId,
  } = props;

  const seats: Array<{ position: SeatPosition; player: Player | null }> = [
    { position: 'top', player: topPlayer },
    { position: 'left', player: leftPlayer },
    { position: 'right', player: rightPlayer },
    { position: 'bottom', player: bottomPlayer },
  ];

  return (
    <div className="center-area" aria-label="盤面中央エリア">
      {seats.map(({ position, player }) =>
        player ? (
          <PlayerHeader
            key={position}
            player={player}
            isCurrent={currentPlayerIndex === player.id}
            isYou={player.id === youId}
            position={position}
          />
        ) : null
      )}
      {seats.map(({ position, player }) =>
        player && startPlayerIndex === player.id ? (
          <StartPlayerMarker key={`sp-${position}`} position={position} />
        ) : null
      )}
      <div className="center-area-inner">
        <FieldView
          field={field}
          deckSize={deckSize}
          interactivePairs={interactivePairs}
          onPairClick={onPairClick}
          onDeckClick={onDeckClick}
          canDrawFromDeck={canDrawFromDeck}
        />
      </div>
    </div>
  );
}
