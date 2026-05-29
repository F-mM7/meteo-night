import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { GameState } from '../game/types';
import { CardView } from './CardView';

interface Props {
  state: GameState;
  targets: (number | null)[];
  setTargets: React.Dispatch<React.SetStateAction<(number | null)[]>>;
}

// 高さを常に 2 行以内に抑えたいので、配布数 N に対して列数を
// `max(3, ceil(N / 2))` で導出する（N≤6 は 3 列、N=7,8 は 4 列、…）。
const GIFT_DEFAULT_COLS = 3;
const GIFT_MAX_ROWS = 2;

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

  const cols = Math.max(GIFT_DEFAULT_COLS, Math.ceil(queue.length / GIFT_MAX_ROWS));
  const barStyle = { '--gift-cols': cols } as CSSProperties;

  return (
    <div className="gift-bar" role="region" aria-label="星のかけらを渡す" style={barStyle}>
      {queue.map((combo, idx) => {
        const card = combo.cards[0];
        const unselected = targets[idx] == null;
        return (
          <div
            key={idx}
            className={`gift-bar-row${unselected ? ' gift-bar-row-unselected' : ''}`}
          >
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
