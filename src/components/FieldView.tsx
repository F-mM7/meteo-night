import type { FieldPair } from '../game/types';
import { CardView } from './CardView';

interface Props {
  field: [FieldPair, FieldPair];
  deckSize: number;
  interactivePairs?: number[];
  onPairClick?: (index: 0 | 1) => void;
  onDeckClick?: () => void;
  canDrawFromDeck?: boolean;
}

export function FieldView({
  field,
  deckSize,
  interactivePairs,
  onPairClick,
  onDeckClick,
  canDrawFromDeck,
}: Props) {
  const renderPair = (pair: FieldPair, idx: 0 | 1) => {
    const interactive = interactivePairs?.includes(idx) ?? false;
    return (
      <button
        type="button"
        className={`field-pair${interactive ? ' field-pair-interactive' : ''}`}
        disabled={!interactive || !pair}
        onClick={() => onPairClick?.(idx)}
        aria-label={`場のセット${idx + 1}`}
      >
        {pair ? (
          <div className="field-pair-cards">
            <CardView card={pair[0]} />
            <CardView card={pair[1]} />
          </div>
        ) : (
          <div className="field-pair-empty" />
        )}
      </button>
    );
  };

  return (
    <section className="field" aria-label="場と山札">
      {renderPair(field[0], 0)}
      <button
        type="button"
        className={`pile pile-deck${canDrawFromDeck ? ' pile-interactive' : ''}`}
        onClick={onDeckClick}
        disabled={!canDrawFromDeck}
        aria-label="山札"
      >
        <div className="pile-stack">
          <div className="card card-facedown">
            <span className="deck-count">{deckSize}</span>
          </div>
        </div>
      </button>
      {renderPair(field[1], 1)}
    </section>
  );
}
