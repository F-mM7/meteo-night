import type { FieldPair, Player } from '../game/types';
import { FieldView } from './FieldView';
import { PlayerHeader } from './PlayerHeader';
import { StartPlayerMarker } from './StartPlayerMarker';

interface Props {
  field: [FieldPair, FieldPair];
  deckSize: number;
  interactivePairs?: number[];
  onPairClick?: (index: 0 | 1) => void;
  onDeckClick?: () => void;
  canDrawFromDeck?: boolean;
  topPlayer: Player;
  leftPlayer: Player;
  rightPlayer: Player;
  bottomPlayer: Player;
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

  return (
    <div className="center-area" aria-label="盤面中央エリア">
      <PlayerHeader
        player={topPlayer}
        isCurrent={currentPlayerIndex === topPlayer.id}
        isYou={topPlayer.id === youId}
        position="top"
      />
      {startPlayerIndex === topPlayer.id && <StartPlayerMarker position="top" />}
      <PlayerHeader
        player={leftPlayer}
        isCurrent={currentPlayerIndex === leftPlayer.id}
        isYou={leftPlayer.id === youId}
        position="left"
      />
      {startPlayerIndex === leftPlayer.id && <StartPlayerMarker position="left" />}
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
      <PlayerHeader
        player={rightPlayer}
        isCurrent={currentPlayerIndex === rightPlayer.id}
        isYou={rightPlayer.id === youId}
        position="right"
      />
      {startPlayerIndex === rightPlayer.id && <StartPlayerMarker position="right" />}
      <PlayerHeader
        player={bottomPlayer}
        isCurrent={currentPlayerIndex === bottomPlayer.id}
        isYou={bottomPlayer.id === youId}
        position="bottom"
      />
      {startPlayerIndex === bottomPlayer.id && <StartPlayerMarker position="bottom" />}
    </div>
  );
}
