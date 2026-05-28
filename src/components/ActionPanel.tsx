import type { ReactNode } from 'react';
import type { Action, GameState } from '../game/types';

interface Props {
  state: GameState;
  isYourTurn: boolean;
  youId: number;
  dispatch: (action: Action) => void;
  rightSlot?: ReactNode;
}

function describePhase(state: GameState, isYourTurn: boolean, youId: number): string {
  const cur = state.players[state.currentPlayerIndex];
  if (state.phase === 'gameOver') {
    const w = state.players.find((p) => p.id === state.winnerId);
    return `ゲーム終了！ 勝者: ${w?.name ?? '不明'}`;
  }
  if (state.phase === 'awaitingGiftPlacement') {
    const batch = state.turn.pendingGiftBatches[0];
    if (batch && batch.recipientId === youId) {
      if (batch.cards.length > 1) {
        return '贈られたカードから1枚を選び、配置するスロットを指定してください';
      }
      return '贈られたカードを置くスロットを選んでください';
    }
    const recipient = batch ? state.players[batch.recipientId]?.name : '';
    return `${recipient} が贈られたカードを配置中...`;
  }
  if (!isYourTurn) {
    return `${cur.name} の手番`;
  }
  switch (state.phase) {
    case 'awaitingDraw':
      return '場のセット または 山札を選んでください';
    case 'awaitingPlaceDrawn':
      return '引いたカードを置くスロットを選んでください';
    case 'resolvingCombos':
      return '連鎖判定中...';
    case 'awaitingAdditionalActionChoice':
      return '流星魔法発動！ 追加アクションを選んでください';
    case 'awaitingPlaceAdditionalDraw':
      return '引いたカードを置くスロットを選んでください';
    case 'awaitingAdditionalDiscard':
      return '取り除くスロットを選んでください';
    case 'awaitingGiftSelection':
      return 'カードを渡す相手を選んでください';
    default:
      return '';
  }
}

export function ActionPanel({
  state,
  isYourTurn,
  youId,
  dispatch,
  rightSlot,
}: Props) {
  const message = describePhase(state, isYourTurn, youId);
  // 山札と捨札が両方空のときはドロー不可（補充元が無いため）。
  const canDrawAdditional = state.deck.length > 0 || state.discardPile.length > 0;
  // 全スロットが空のときは取り除き不可。smartAI / actionSpace と同じガード条件。
  const canDiscard = state.players[youId].board.slots.some((s) => s.stack.length > 0);

  return (
    <section className="action-panel" aria-label="操作パネル">
      <div className="action-message">
        {state.endTriggered && <span className="badge badge-warning">最終ラウンド</span>}
        <span className="action-message-text">{message}</span>
        {rightSlot}
      </div>
      <div className="action-buttons">
        {state.phase === 'awaitingAdditionalActionChoice' && isYourTurn && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => dispatch({ type: 'CHOOSE_ADDITIONAL_DRAW' })}
              disabled={!canDrawAdditional}
            >
              山札から1枚引いて配置
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => dispatch({ type: 'CHOOSE_ADDITIONAL_DISCARD' })}
              disabled={!canDiscard}
            >
              スロット最上段を1枚捨札
            </button>
          </>
        )}
      </div>
    </section>
  );
}
