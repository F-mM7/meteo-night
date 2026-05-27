import { useEffect, useMemo, useState } from 'react';
import type { Action, GameState, GiftAssignment } from '../game/types';
import { CardView } from './CardView';

interface Props {
  state: GameState;
  dispatch: (action: Action) => void;
  columns: number;
}

export function GiftModal({ state, dispatch, columns }: Props) {
  const queue = state.turn.giftQueue;
  const giverId = state.currentPlayerIndex;
  const otherPlayers = useMemo(
    () => state.players.filter((p) => p.id !== giverId),
    [state.players, giverId]
  );

  const [targets, setTargets] = useState<(number | null)[]>(() => queue.map(() => null));

  useEffect(() => {
    setTargets(queue.map(() => null));
  }, [queue]);

  if (queue.length === 0) return null;

  const updateTarget = (idx: number, targetPlayerId: number) => {
    setTargets((prev) => prev.map((t, i) => (i === idx ? targetPlayerId : t)));
  };

  const allReady = targets.every((t) => t !== null);

  const handleConfirm = () => {
    if (!allReady) return;
    const assignments: GiftAssignment[] = queue.map((combo, i) => ({
      comboIndex: i,
      cardId: combo.cards[0].id,
      targetPlayerId: targets[i]!,
    }));
    dispatch({ type: 'CONFIRM_GIFTS', assignments });
  };

  return (
    <div className="gift-bar" role="region" aria-label="星のかけらを渡す">
      <div
        className="gift-bar-rows"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
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
      <div className="gift-bar-confirm">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!allReady}
          onClick={handleConfirm}
        >
          決定
        </button>
      </div>
    </div>
  );
}
