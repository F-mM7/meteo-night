import { useEffect, useMemo, useState } from 'react';
import { useGameLogic, currentActorId } from './hooks/useGameLogic';
import { useBoardSize } from './hooks/useBoardSize';
import { PlayerBoardView } from './components/PlayerBoardView';
import { CenterArea } from './components/CenterArea';
import { ActionPanel } from './components/ActionPanel';
import { LogPanel } from './components/LogPanel';
import { GiftModal } from './components/GiftModal';
import { CardView } from './components/CardView';
import { computeStackOffset } from './components/SlotView';
import type { Card, GameState } from './game/types';

interface SlotInteractivity {
  interactiveSlotIndices: number[];
  highlightedSlotIndices: number[];
}

function computeYourSlotInteractivity(state: GameState, you: number): SlotInteractivity {
  const actorId = currentActorId(state);
  if (actorId !== you) {
    return { interactiveSlotIndices: [], highlightedSlotIndices: [] };
  }
  const player = state.players[you];
  switch (state.phase) {
    case 'awaitingPlaceDrawn':
    case 'awaitingPlaceAdditionalDraw':
    case 'awaitingGiftPlacement':
      return {
        interactiveSlotIndices: player.board.slots.map((_, i) => i),
        highlightedSlotIndices: [],
      };
    case 'awaitingAdditionalDiscard': {
      const slots = player.board.slots
        .map((s, i) => (s.stack.length > 0 ? i : -1))
        .filter((i) => i >= 0);
      return { interactiveSlotIndices: slots, highlightedSlotIndices: [] };
    }
    default:
      return { interactiveSlotIndices: [], highlightedSlotIndices: [] };
  }
}

function placeableCards(state: GameState): Card[] {
  switch (state.phase) {
    case 'awaitingPlaceDrawn':
      return state.turn.pendingDraw;
    case 'awaitingPlaceAdditionalDraw':
      return state.turn.pendingAdditionalDraw ? [state.turn.pendingAdditionalDraw] : [];
    case 'awaitingGiftPlacement': {
      const batch = state.turn.pendingGiftBatches[0];
      return batch ? batch.cards : [];
    }
    default:
      return [];
  }
}

export default function App() {
  const {
    state,
    dispatch,
    startNewGame,
    autoPilot,
    setAutoPilot,
    cpuSpeed,
    setCpuSpeed,
  } = useGameLogic();
  const you = 0;
  const player = state.players[you];
  const actorId = currentActorId(state);
  const isYourActor = actorId === you && state.phase !== 'gameOver' && !autoPilot;
  const isYourTurn =
    state.currentPlayerIndex === you && state.phase !== 'gameOver' && !autoPilot;

  const slotInteractivity = useMemo(
    () => computeYourSlotInteractivity(state, you),
    [state, you]
  );

  const fieldInteractive = isYourTurn && state.phase === 'awaitingDraw';
  const interactivePairs = fieldInteractive
    ? state.field.map((p, i) => (p ? i : -1)).filter((i) => i >= 0)
    : [];

  const cardsToPlace = isYourActor ? placeableCards(state) : [];
  const [selectedHandCardId, setSelectedHandCardId] = useState<string | null>(null);

  useEffect(() => {
    if (cardsToPlace.length === 0) {
      if (selectedHandCardId !== null) setSelectedHandCardId(null);
      return;
    }
    if (!cardsToPlace.some((c) => c.id === selectedHandCardId)) {
      setSelectedHandCardId(cardsToPlace[0].id);
    }
  }, [cardsToPlace, selectedHandCardId]);

  const selectedCard =
    cardsToPlace.find((c) => c.id === selectedHandCardId) ?? cardsToPlace[0] ?? null;

  const handleSlotClick = (slotIndex: number) => {
    if (!isYourActor) return;
    switch (state.phase) {
      case 'awaitingPlaceDrawn': {
        const card = selectedCard ?? state.turn.pendingDraw[0];
        if (!card) return;
        dispatch({ type: 'PLACE_DRAWN', cardId: card.id, slotIndex });
        break;
      }
      case 'awaitingPlaceAdditionalDraw': {
        dispatch({ type: 'PLACE_ADDITIONAL_DRAW', slotIndex });
        break;
      }
      case 'awaitingAdditionalDiscard': {
        dispatch({ type: 'DISCARD_TOP', slotIndex });
        break;
      }
      case 'awaitingGiftPlacement': {
        const batch = state.turn.pendingGiftBatches[0];
        const card = selectedCard ?? batch?.cards[0];
        if (!card) return;
        dispatch({ type: 'PLACE_GIFT', cardId: card.id, slotIndex });
        break;
      }
      default:
        break;
    }
  };

  const handlePairClick = (index: 0 | 1) => {
    if (!isYourTurn || state.phase !== 'awaitingDraw') return;
    dispatch({ type: 'DRAW_FROM_FIELD', pairIndex: index });
  };

  const handleDeckClick = () => {
    if (!isYourTurn || state.phase !== 'awaitingDraw') return;
    dispatch({ type: 'DRAW_FROM_DECK' });
  };

  const opponents = state.players.filter((p) => p.id !== you);
  const handSelectable =
    isYourActor &&
    cardsToPlace.length > 1 &&
    (state.phase === 'awaitingPlaceDrawn' || state.phase === 'awaitingGiftPlacement');

  const showGiftModal =
    state.currentPlayerIndex === you && state.phase === 'awaitingGiftSelection' && !autoPilot;

  // 連鎖数が増えてもアクション領域は固定。代わりに列数を増やして常に1行に収める。
  const giftCombosCount = state.turn.giftQueue.length;
  const giftColumns = Math.max(1, giftCombosCount);

  const { boardSize, seatShort, cardSize, layout } = useBoardSize();

  const globalMaxStack = useMemo(() => {
    let max = 1;
    for (const p of state.players) {
      for (const s of p.board.slots) {
        if (s.stack.length > max) max = s.stack.length;
      }
    }
    return max;
  }, [state.players]);
  const stackOffset = computeStackOffset(cardSize, globalMaxStack);

  const discardedCardIdSet = useMemo(
    () => new Set(state.turn.discardedCardIds),
    [state.turn.discardedCardIds]
  );

  const cssVars = {
    '--card-size': `${cardSize}px`,
    '--board-size': `${boardSize}px`,
    '--seat-short': `${seatShort}px`,
    '--gap': `${Math.max(4, Math.floor(cardSize / 10))}px`,
  } as React.CSSProperties;

  return (
    <div className={`app-shell layout-${layout}`} style={cssVars}>
      <div className="bg-stars" aria-hidden />
      <header className="app-header">
        <h1 className="app-title">星を放つ夜</h1>
        <span className="app-subtitle">CPU対戦版</span>
        <div className="header-controls">
          <label className="header-control">
            <span className="header-control-label">CPU速度</span>
            <select
              className="header-select"
              value={cpuSpeed}
              onChange={(e) => setCpuSpeed(e.target.value as typeof cpuSpeed)}
            >
              <option value="fast">高速</option>
              <option value="normal">標準</option>
              <option value="slow">ゆっくり</option>
              <option value="verySlow">じっくり</option>
            </select>
          </label>
          <label className="header-control autopilot-toggle">
            <input
              type="checkbox"
              checked={autoPilot}
              onChange={(e) => setAutoPilot(e.target.checked)}
            />
            観戦モード
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-restart"
            onClick={() => startNewGame()}
          >
            新規ゲーム
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="board-area">
          <section className="seat seat-top">
            {opponents[1] && (
              <PlayerBoardView
                player={opponents[1]}
                isCurrent={state.currentPlayerIndex === opponents[1].id}
                isYou={false}
                cardSize={cardSize}
                stackOffset={stackOffset}
                stackDirection="up"
                discardedCardIds={discardedCardIdSet}
              />
            )}
          </section>

          <section className="seat seat-left">
            {opponents[0] && (
              <PlayerBoardView
                player={opponents[0]}
                isCurrent={state.currentPlayerIndex === opponents[0].id}
                isYou={false}
                cardSize={cardSize}
                stackOffset={stackOffset}
                orientation="vertical"
                stackDirection="left"
                discardedCardIds={discardedCardIdSet}
              />
            )}
          </section>

          <section className="seat seat-center">
            <CenterArea
              field={state.field}
              deckSize={state.deck.length}
              interactivePairs={interactivePairs}
              onPairClick={handlePairClick}
              onDeckClick={handleDeckClick}
              canDrawFromDeck={fieldInteractive}
              topPlayer={opponents[1]}
              leftPlayer={opponents[0]}
              rightPlayer={opponents[2]}
              bottomPlayer={player}
              currentPlayerIndex={state.currentPlayerIndex}
              startPlayerIndex={state.startPlayerIndex}
              youId={you}
            />
          </section>

          <section className="seat seat-right">
            {opponents[2] && (
              <PlayerBoardView
                player={opponents[2]}
                isCurrent={state.currentPlayerIndex === opponents[2].id}
                isYou={false}
                cardSize={cardSize}
                stackOffset={stackOffset}
                orientation="vertical"
                stackDirection="right"
                discardedCardIds={discardedCardIdSet}
              />
            )}
          </section>

          <section className="seat seat-bottom">
            <PlayerBoardView
              player={player}
              isCurrent={state.currentPlayerIndex === you}
              isYou
              cardSize={cardSize}
              stackOffset={stackOffset}
              stackDirection="down"
              interactiveSlotIndices={slotInteractivity.interactiveSlotIndices}
              highlightedSlotIndices={slotInteractivity.highlightedSlotIndices}
              onSlotClick={handleSlotClick}
              discardedCardIds={discardedCardIdSet}
            />
          </section>
        </div>

        <aside className="action-area">
          <ActionPanel
            state={state}
            isYourTurn={isYourTurn}
            dispatch={dispatch}
            onStartNewGame={() => startNewGame()}
          />
          <div className="hand-zone">
              {showGiftModal ? (
                <GiftModal state={state} dispatch={dispatch} columns={giftColumns} />
              ) : cardsToPlace.length > 0 ? (
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
                        onClick={() => setSelectedHandCardId(c.id)}
                        aria-label={`このカードを次に配置`}
                      >
                        <CardView card={c} emphasized={isSelected} />
                      </button>
                    ) : (
                      <CardView key={c.id} card={c} emphasized={isSelected} />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </aside>
        <aside className="log-area">
          <LogPanel entries={state.log} playerCount={state.players.length} />
        </aside>
      </main>
    </div>
  );
}
