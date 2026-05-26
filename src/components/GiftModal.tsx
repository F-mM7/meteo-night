import { useEffect, useMemo, useState } from 'react';
import type { Action, GameState, GiftAssignment } from '../game/types';
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
    <div className="gift-bar" role="region" aria-label="星のかけらをまとめて渡す">
      <div className="gift-bar-header">
        <h2>連鎖完了 - 星のかけらを渡す</h2>
        <p className="gift-bar-sub">
          各コンボのカードを渡す相手を指定してください。
        </p>
      </div>
      <div className="gift-bar-rows">
        {queue.map((combo, idx) => {
          const card = combo.cards[0];
          return (
            <div key={idx} className="gift-bar-row">
              <div className="gift-bar-row-cards">
                <CardView card={card} />
                <span className="gift-bar-row-label">
                  コンボ{idx + 1}（{COLOR_LABEL[combo.color]}）
                </span>
              </div>
              <div className="gift-bar-row-targets">
                {otherPlayers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`btn btn-target btn-target-sm${targets[idx] === p.id ? ' selected' : ''}`}
                    onClick={() => updateTarget(idx, p.id)}
                  >
                    {p.name}
                    <span className="btn-sub">{p.score}点</span>
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
          まとめて渡す
        </button>
      </div>
    </div>
  );
}
