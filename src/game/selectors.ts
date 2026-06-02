import type { Action, Card, GameState, Phase } from './types';

/**
 * 「配置／取り除き」を待っているフェーズで、UI と AI が共通で必要とする 3 つの派生情報をまとめる。
 *
 * - `getCards(state)`: そのフェーズで手元に並ぶ「配置候補カード」のリスト。
 * - `getInteractiveSlots(state, actorId)`: その actor が操作できるスロットの index 群。
 * - `makeAction(state, slotIndex, selectedCardId)`: スロットがクリックされたときに発行する action。
 *
 * フェーズ単位で 1:1 対応しているため、ここに集約することで「フェーズが増減したときに 3 箇所
 * を手動同期する」コストを排除する。
 */
interface PlacementPhaseConfig {
  getCards: (state: GameState) => Card[];
  getInteractiveSlots: (state: GameState, actorId: number) => number[];
  makeAction: (state: GameState, slotIndex: number, selectedCardId: string | null) => Action | null;
}

function allSlotIndices(state: GameState, actorId: number): number[] {
  const player = state.players[actorId];
  if (!player) return [];
  return player.board.slots.map((_, i) => i);
}

function nonEmptySlotIndices(state: GameState, actorId: number): number[] {
  const player = state.players[actorId];
  if (!player) return [];
  return player.board.slots
    .map((s, i) => (s.stack.length > 0 ? i : -1))
    .filter((i) => i >= 0);
}

function pickCard(cards: Card[], selectedCardId: string | null): Card | null {
  if (cards.length === 0) return null;
  return cards.find((c) => c.id === selectedCardId) ?? cards[0];
}

const PLACEMENT_PHASES: Partial<Record<Phase, PlacementPhaseConfig>> = {
  awaitingPlaceDrawn: {
    getCards: (s) => s.turn.pendingDraw,
    getInteractiveSlots: allSlotIndices,
    makeAction: (s, slotIndex, selectedCardId) => {
      const card = pickCard(s.turn.pendingDraw, selectedCardId);
      if (!card) return null;
      return { type: 'PLACE_DRAWN', cardId: card.id, slotIndex };
    },
  },
  awaitingPlaceAdditionalDraw: {
    getCards: (s) => (s.turn.pendingAdditionalDraw ? [s.turn.pendingAdditionalDraw] : []),
    getInteractiveSlots: allSlotIndices,
    makeAction: (_, slotIndex) => ({ type: 'PLACE_ADDITIONAL_DRAW', slotIndex }),
  },
  // 流星魔法後の種類選択フェーズ。スロット最上段クリックを「取り除き」に直結させ、
  // ボタンを介さず 1 クリックで捨札できるようにする（山札クリック＝ドローは App 側で処理）。
  awaitingAdditionalActionChoice: {
    getCards: () => [],
    getInteractiveSlots: nonEmptySlotIndices,
    makeAction: (_, slotIndex) => ({ type: 'DISCARD_TOP', slotIndex }),
  },
  awaitingAdditionalDiscard: {
    getCards: () => [],
    getInteractiveSlots: nonEmptySlotIndices,
    makeAction: (_, slotIndex) => ({ type: 'DISCARD_TOP', slotIndex }),
  },
  awaitingGiftPlacement: {
    getCards: (s) => s.turn.pendingGiftBatches[0]?.cards ?? [],
    getInteractiveSlots: allSlotIndices,
    makeAction: (s, slotIndex, selectedCardId) => {
      const cards = s.turn.pendingGiftBatches[0]?.cards ?? [];
      const card = pickCard(cards, selectedCardId);
      if (!card) return null;
      return { type: 'PLACE_GIFT', cardId: card.id, slotIndex };
    },
  },
};

/** そのフェーズで「これから配置する」候補カードのリストを返す。配置不要フェーズでは空配列。 */
export function placeableCards(state: GameState): Card[] {
  const cfg = PLACEMENT_PHASES[state.phase];
  return cfg ? cfg.getCards(state) : [];
}

/** `actorId` の actor がそのフェーズで操作できるスロット index 群を返す。操作不能なフェーズでは空配列。 */
export function interactiveSlotsForActor(state: GameState, actorId: number): number[] {
  const cfg = PLACEMENT_PHASES[state.phase];
  return cfg ? cfg.getInteractiveSlots(state, actorId) : [];
}

/**
 * スロットクリック相当の操作で発行すべき action を作る。
 * `selectedCardId` は複数カード候補がある場合の選択。null や不一致 ID の場合は先頭のカードを使う。
 * 配置不要フェーズでは null を返す。
 */
export function makePlacementAction(
  state: GameState,
  slotIndex: number,
  selectedCardId: string | null
): Action | null {
  const cfg = PLACEMENT_PHASES[state.phase];
  return cfg ? cfg.makeAction(state, slotIndex, selectedCardId) : null;
}
