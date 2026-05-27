import { useMemo } from 'react';
import { useGameLogic, currentActorId, isHumanInteractive } from './hooks/useGameLogic';
import { useBoardLayout } from './hooks/useBoardLayout';
import { usePlacementSelection } from './hooks/usePlacementSelection';
import { PlayerBoardView } from './components/PlayerBoardView';
import { CenterArea } from './components/CenterArea';
import { ActionPanel } from './components/ActionPanel';
import { LogPanel } from './components/LogPanel';
import { AppHeader } from './components/AppHeader';
import { HandZone } from './components/HandZone';
import {
  placeableCards,
  interactiveSlotsForActor,
  makePlacementAction,
} from './game/selectors';

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
  const isYourActor = isHumanInteractive(state, you, autoPilot, 'actor');
  const isYourTurn = isHumanInteractive(state, you, autoPilot, 'turn');

  const interactiveSlotIndices = useMemo(
    () => (currentActorId(state) === you ? interactiveSlotsForActor(state, you) : []),
    [state, you]
  );

  const fieldInteractive = isYourTurn && state.phase === 'awaitingDraw';
  const interactivePairs = fieldInteractive
    ? state.field.map((p, i) => (p ? i : -1)).filter((i) => i >= 0)
    : [];

  const cardsToPlace = isYourActor ? placeableCards(state) : [];
  const { selectedCard, setSelectedCardId } = usePlacementSelection(cardsToPlace);

  const handleSlotClick = (slotIndex: number) => {
    if (!isYourActor) return;
    const action = makePlacementAction(state, slotIndex, selectedCard?.id ?? null);
    if (action) dispatch(action);
  };

  const handlePairClick = (index: 0 | 1) => {
    if (!isYourTurn || state.phase !== 'awaitingDraw') return;
    dispatch({ type: 'DRAW_FROM_FIELD', pairIndex: index });
  };

  const handleDeckClick = () => {
    if (!isYourTurn || state.phase !== 'awaitingDraw') return;
    dispatch({ type: 'DRAW_FROM_DECK' });
  };

  const seatedOpponents = useMemo(() => {
    const n = state.players.length;
    const at = (offset: number) =>
      n > 0 ? (state.players.find((p) => p.id === (you + offset) % n) ?? null) : null;
    return {
      left: at(1),
      top: at(2),
      right: at(3),
    };
  }, [state.players, you]);

  const handSelectable =
    isYourActor &&
    cardsToPlace.length > 1 &&
    (state.phase === 'awaitingPlaceDrawn' || state.phase === 'awaitingGiftPlacement');

  const showGiftModal =
    state.currentPlayerIndex === you && state.phase === 'awaitingGiftSelection' && !autoPilot;

  const { cardSize, layout, stackOffset, cssVars } = useBoardLayout(state);

  const discardedCardIdSet = useMemo(
    () => new Set(state.turn.discardedCardIds),
    [state.turn.discardedCardIds]
  );

  return (
    <div className={`app-shell layout-${layout}`} style={cssVars}>
      <div className="bg-stars" aria-hidden />
      <AppHeader
        cpuSpeed={cpuSpeed}
        setCpuSpeed={setCpuSpeed}
        autoPilot={autoPilot}
        setAutoPilot={setAutoPilot}
        onStartNewGame={() => startNewGame()}
      />

      <main className="app-main">
        <div className="board-area">
          <section className="seat seat-top">
            {seatedOpponents.top && (
              <PlayerBoardView
                player={seatedOpponents.top}
                isCurrent={state.currentPlayerIndex === seatedOpponents.top.id}
                isYou={false}
                cardSize={cardSize}
                stackOffset={stackOffset}
                seat="top"
                discardedCardIds={discardedCardIdSet}
              />
            )}
          </section>

          <section className="seat seat-left">
            {seatedOpponents.left && (
              <PlayerBoardView
                player={seatedOpponents.left}
                isCurrent={state.currentPlayerIndex === seatedOpponents.left.id}
                isYou={false}
                cardSize={cardSize}
                stackOffset={stackOffset}
                seat="left"
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
              topPlayer={seatedOpponents.top}
              leftPlayer={seatedOpponents.left}
              rightPlayer={seatedOpponents.right}
              bottomPlayer={player}
              currentPlayerIndex={state.currentPlayerIndex}
              startPlayerIndex={state.startPlayerIndex}
              youId={you}
            />
          </section>

          <section className="seat seat-right">
            {seatedOpponents.right && (
              <PlayerBoardView
                player={seatedOpponents.right}
                isCurrent={state.currentPlayerIndex === seatedOpponents.right.id}
                isYou={false}
                cardSize={cardSize}
                stackOffset={stackOffset}
                seat="right"
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
              seat="bottom"
              interactiveSlotIndices={interactiveSlotIndices}
              onSlotClick={handleSlotClick}
              discardedCardIds={discardedCardIdSet}
            />
          </section>
        </div>

        <aside className="action-area">
          <ActionPanel
            state={state}
            isYourTurn={isYourTurn}
            youId={you}
            dispatch={dispatch}
            onStartNewGame={() => startNewGame()}
          />
          <div className="hand-zone">
            <HandZone
              state={state}
              dispatch={dispatch}
              cardsToPlace={cardsToPlace}
              selectedCard={selectedCard}
              onSelectCard={setSelectedCardId}
              handSelectable={handSelectable}
              showGiftModal={showGiftModal}
            />
          </div>
        </aside>
        <aside className="log-area">
          <LogPanel entries={state.log} playerCount={state.players.length} />
        </aside>
      </main>
    </div>
  );
}
