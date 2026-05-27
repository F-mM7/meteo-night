import type { Action, Card, GameState } from '../game/types';
import { CardView } from './CardView';
import { GiftModal } from './GiftModal';

interface Props {
  state: GameState;
  dispatch: (action: Action) => void;
  cardsToPlace: Card[];
  selectedCard: Card | null;
  onSelectCard: (id: string) => void;
  handSelectable: boolean;
  showGiftModal: boolean;
}

export function HandZone({
  state,
  dispatch,
  cardsToPlace,
  selectedCard,
  onSelectCard,
  handSelectable,
  showGiftModal,
}: Props) {
  if (showGiftModal) {
    return <GiftModal state={state} dispatch={dispatch} />;
  }
  if (cardsToPlace.length === 0) return null;

  return (
    <div className="your-hand">
      <h3>あなたの手元</h3>
      <div className="hand-cards">
        <span className="hand-label">
          {handSelectable ? 'クリックで配置するカードを選択' : '配置するカード'}
        </span>
        {cardsToPlace.map((c) => {
          const isSelected = selectedCard?.id === c.id;
          return handSelectable ? (
            <button
              key={c.id}
              type="button"
              className={`hand-card-btn${isSelected ? ' selected' : ''}`}
              onClick={() => onSelectCard(c.id)}
              aria-label="このカードを次に配置"
            >
              <CardView card={c} emphasized={isSelected} />
            </button>
          ) : (
            <CardView key={c.id} card={c} emphasized={isSelected} />
          );
        })}
      </div>
    </div>
  );
}
