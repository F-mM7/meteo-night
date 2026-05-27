import { useEffect, useState } from 'react';
import type { Card } from '../game/types';

/**
 * 「これから配置する候補カード」のうち、UI で現在選ばれているカードを管理するフック。
 *
 * - 候補が 1 枚以下になったら選択は自動でリセット／先頭固定になる。
 * - 候補のリストが入れ替わって現在の選択 ID が無くなった場合、先頭カードを暗黙選択する。
 *
 * 選択結果は盤面のスロットクリック側（`makePlacementAction` 呼び出し）でも参照されるため、
 * フック化して 1 か所に閉じ込めつつ、選択カードを呼び出し側で読めるようにしている。
 */
export function usePlacementSelection(cardsToPlace: Card[]) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  useEffect(() => {
    if (cardsToPlace.length === 0) {
      if (selectedCardId !== null) setSelectedCardId(null);
      return;
    }
    if (!cardsToPlace.some((c) => c.id === selectedCardId)) {
      setSelectedCardId(cardsToPlace[0].id);
    }
  }, [cardsToPlace, selectedCardId]);

  const selectedCard =
    cardsToPlace.find((c) => c.id === selectedCardId) ?? cardsToPlace[0] ?? null;

  return { selectedCard, selectedCardId, setSelectedCardId };
}
