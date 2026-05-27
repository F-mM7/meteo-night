import { useMemo } from 'react';
import type { GameState } from '../game/types';
import { CardView } from './CardView';

interface Props {
  state: GameState;
  targets: (number | null)[];
  setTargets: React.Dispatch<React.SetStateAction<(number | null)[]>>;
}

export function GiftBar({ state, targets, setTargets }: Props) {
  const queue = state.turn.giftQueue;
  const giverId = state.currentPlayerIndex;
  const otherPlayers = useMemo(
    () => state.players.filter((p) => p.id !== giverId),
    [state.players, giverId]
  );

  if (queue.length === 0) return null;

  const updateTarget = (idx: number, targetPlayerId: number) => {
    setTargets((prev) => prev.map((t, i) => (i === idx ? targetPlayerId : t)));
  };

  return (
    <div className="gift-bar" role="region" aria-label="星のかけらを渡す">
      {queue.map((combo, idx) => {
        const card = combo.cards[0];
        return (
          <div key={idx} className="gift-bar-row">
            <CardView card={card} />
            <div className="gift-bar-row-targets">
              {otherPlayers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn btn-target${targets[idx] === p.id ? ' selected' : ''}`}
                  onClick={() => updateTarget(idx, p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
