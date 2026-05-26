import { useEffect, useMemo, useState } from 'react';
import type { Action, ComboRecord, GameState } from '../game/types';
import { CardView } from './CardView';

interface Props {
  state: GameState;
  dispatch: (action: Action) => void;
}

const COLOR_LABEL: Record<string, string> = {
  red: '赤',
  green: '緑',
  yellow: '黄',
  purple: '紫',
  blue: '青',
};

export function GiftModal({ state, dispatch }: Props) {
  const player = state.players[state.currentPlayerIndex];
  const queue = state.turn.giftQueue;
  const current: ComboRecord | undefined = queue[0];
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  const otherPlayers = useMemo(
    () => state.players.filter((p) => p.id !== player.id),
    [state.players, player.id]
  );

  useEffect(() => {
    setSelectedCardId(null);
  }, [queue.length]);

  if (!current) return null;

  const cardToGive = selectedCardId
    ? current.cards.find((c) => c.id === selectedCardId)
    : current.cards[0];

  const totalCombos = state.turn.combosThisTurn.length;
  const currentIndex = totalCombos - queue.length + 1;

  return (
    <div className="gift-bar" role="region" aria-label="星のかけらを渡す">
      <div className="gift-bar-info">
        <h2>連鎖完了 - 星のかけらを渡す</h2>
        <p className="gift-bar-sub">
          コンボ {currentIndex} / {totalCombos}（{COLOR_LABEL[current.color]}・{current.cards.length}枚残）から1枚を選び、渡す相手を指定
        </p>
      </div>
      <div className="gift-bar-cards">
        <span className="gift-bar-label">渡すカード</span>
        <div className="combo-cards">
          {current.cards.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`combo-card-btn${cardToGive?.id === c.id ? ' selected' : ''}`}
              onClick={() => setSelectedCardId(c.id)}
              aria-label={`${COLOR_LABEL[c.color]}を選択`}
            >
              <CardView card={c} size="sm" />
            </button>
          ))}
        </div>
      </div>
      <div className="gift-bar-targets">
        <span className="gift-bar-label">渡す相手</span>
        <div className="modal-targets">
          {otherPlayers.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-target"
              onClick={() => {
                if (!cardToGive) return;
                dispatch({
                  type: 'GIVE_CARD',
                  comboIndex: 0,
                  cardId: cardToGive.id,
                  targetPlayerId: p.id,
                });
                setSelectedCardId(null);
              }}
            >
              {p.name}
              <span className="btn-sub">{p.score}点</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
