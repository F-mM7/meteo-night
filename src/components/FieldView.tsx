import type { FieldPair } from '../game/types';
import { CardView } from './CardView';

interface Props {
  field: [FieldPair, FieldPair];
  deckSize: number;
  discardSize: number;
  interactivePairs?: number[];
  onPairClick?: (index: 0 | 1) => void;
  onDeckClick?: () => void;
  canDrawFromDeck?: boolean;
}

export function FieldView({
  field,
  deckSize,
  discardSize,
  interactivePairs,
  onPairClick,
  onDeckClick,
  canDrawFromDeck,
}: Props) {
  return (
    <section className="field" aria-label="場と山札">
      <div className="field-pairs">
        {field.map((pair, idx) => {
          const interactive = interactivePairs?.includes(idx) ?? false;
          return (
            <button
              key={idx}
              type="button"
              className={`field-pair${interactive ? ' field-pair-interactive' : ''}`}
              disabled={!interactive || !pair}
              onClick={() => onPairClick?.(idx as 0 | 1)}
              aria-label={`場のセット${idx + 1}`}
            >
              <span className="field-pair-label">セット{idx + 1}</span>
              {pair ? (
                <div className="field-pair-cards">
                  <CardView card={pair[0]} size="md" />
                  <CardView card={pair[1]} size="md" />
                </div>
              ) : (
                <div className="field-pair-empty">なし</div>
              )}
            </button>
          );
        })}
      </div>
      <div className="field-piles">
        <button
          type="button"
          className={`pile pile-deck${canDrawFromDeck ? ' pile-interactive' : ''}`}
          onClick={onDeckClick}
          disabled={!canDrawFromDeck}
          aria-label="山札"
        >
          <div className="pile-stack">
            <div className="card card-md card-facedown">
              <span className="card-back-symbol">星</span>
            </div>
          </div>
          <span className="pile-label">山札 {deckSize}</span>
        </button>
        <div className="pile pile-discard" aria-label="捨札">
          <div className="pile-stack">
            <div className="card card-md card-facedown card-faded">
              <span className="card-back-symbol">×</span>
            </div>
          </div>
          <span className="pile-label">捨札 {discardSize}</span>
        </div>
      </div>
    </section>
  );
}
