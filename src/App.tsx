import { useEffect, useMemo, useState } from 'react';
import { useGameLogic, currentActorId, isHumanInteractive } from './hooks/useGameLogic';
import { useBoardLayout } from './hooks/useBoardLayout';
import { usePlacementSelection } from './hooks/usePlacementSelection';
import { PlayerBoardView } from './components/PlayerBoardView';
import { CenterArea } from './components/CenterArea';
import { ActionPanel } from './components/ActionPanel';
import { LogPanel } from './components/LogPanel';
import { AppHeader } from './components/AppHeader';
import { HandZone } from './components/HandZone';
import { GiftBar } from './components/GiftBar';
import { BgStars } from './components/BgStars';
import type { GiftAssignment } from './game/types';
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
    effectDelay,
    setEffectDelay,
    logVisible,
    setLogVisible,
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

  const showGiftBar =
    state.currentPlayerIndex === you && state.phase === 'awaitingGiftSelection' && !autoPilot;

  const giftQueue = state.turn.giftQueue;
  const [giftTargets, setGiftTargets] = useState<(number | null)[]>([]);
  useEffect(() => {
    if (showGiftBar) {
      setGiftTargets(giftQueue.map(() => null));
    } else {
      setGiftTargets([]);
    }
  }, [showGiftBar, giftQueue]);

  const giftSelectedCount = giftTargets.filter((t) => t !== null).length;
  const giftTotalCount = giftQueue.length;
  const allGiftTargetsReady =
    showGiftBar && giftTargets.length === giftTotalCount && giftSelectedCount === giftTotalCount;

  const handleConfirmGifts = () => {
    if (!allGiftTargetsReady) return;
    const assignments: GiftAssignment[] = giftQueue.map((combo, i) => ({
      comboIndex: i,
      cardId: combo.cards[0].id,
      targetPlayerId: giftTargets[i]!,
    }));
    dispatch({ type: 'CONFIRM_GIFTS', assignments });
  };

  // 既存の選択状態に関わらず、全件をランダムに割り当てて即座に配布する。
  const handleRandomDistribute = () => {
    if (!showGiftBar || giftQueue.length === 0) return;
    const otherIds = state.players.filter((p) => p.id !== you).map((p) => p.id);
    if (otherIds.length === 0) return;
    const assignments: GiftAssignment[] = giftQueue.map((combo, i) => ({
      comboIndex: i,
      cardId: combo.cards[0].id,
      targetPlayerId: otherIds[Math.floor(Math.random() * otherIds.length)],
    }));
    dispatch({ type: 'CONFIRM_GIFTS', assignments });
  };

  const giftConfirmSlot = showGiftBar ? (
    <div className="gift-confirm-actions">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={handleRandomDistribute}
      >
        ランダムに配布
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!allGiftTargetsReady}
        onClick={handleConfirmGifts}
        aria-label={
          allGiftTargetsReady
            ? '決定'
            : `配布先を選択してください (${giftSelectedCount}/${giftTotalCount})`
        }
      >
        決定 ({giftSelectedCount}/{giftTotalCount})
      </button>
    </div>
  ) : null;

  const { cardSize, layout, stackOffset, cssVars } = useBoardLayout(state, logVisible);

  const discardedCardIdSet = useMemo(
    () => new Set(state.turn.discardedCardIds),
    [state.turn.discardedCardIds]
  );

  return (
    <div
      className={`app-shell layout-${layout}${logVisible ? '' : ' log-hidden'}`}
      style={cssVars}
    >
      <BgStars />
      <AppHeader
        effectDelay={effectDelay}
        setEffectDelay={setEffectDelay}
        autoPilot={autoPilot}
        setAutoPilot={setAutoPilot}
        logVisible={logVisible}
        setLogVisible={setLogVisible}
        onStartNewGame={() => startNewGame()}
      />

      <main className="app-main">
        <div className="board-area">
          <section className="seat seat-top">
            {seatedOpponents.top && (
              <PlayerBoardView
                player={seatedOpponents.top}
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
            />
          </section>

          <section className="seat seat-right">
            {seatedOpponents.right && (
              <PlayerBoardView
                player={seatedOpponents.right}
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
            rightSlot={giftConfirmSlot}
          />
          {showGiftBar ? (
            <GiftBar state={state} targets={giftTargets} setTargets={setGiftTargets} />
          ) : (
            <div className="hand-zone">
              <HandZone
                cardsToPlace={cardsToPlace}
                selectedCard={selectedCard}
                onSelectCard={setSelectedCardId}
                handSelectable={handSelectable}
              />
            </div>
          )}
        </aside>
        {logVisible && (
          <aside className="log-area">
            <LogPanel entries={state.log} playerCount={state.players.length} />
          </aside>
        )}
      </main>
    </div>
  );
}
