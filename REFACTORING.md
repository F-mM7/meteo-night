# リファクタリング方針（UI / ページ層）

## 不採用とした指摘（記録）

発見フェーズで挙がったが、精査の結果、項目化しないもの（再提起防止のため記録）:

- **useEffect 依存配列（`App.tsx:88-96`）から `selectedHandCardId` を外す**: 誤り。外すと stale closure 化する。実体は「`cardsToPlace` が毎レンダー新参照で effect が毎回走るがガードで setState されず無害」。整理するなら項目 12 で選択ロジックごと隔離する。
- **key={idx}（`PlayerBoardView.tsx:39` / `LogPanel.tsx:32`）**: 本コードでは問題なし。スロットは固定 5 枚・順序不変、ログは追記のみ。フェードは SlotView 内で `card.id` を key にしている（`:136`）。
- **useBoardSize の calc 二重呼び出し（`:89`）**: マウント後に寸法を確定させる意図的な呼び出しで実害なし。
- **GiftModal の `targets[i]!`（`:37`）**: `allReady`（`:30`）でガード済み。かつ当該ファイルは未コミット変更中のため今は触らない。
- **handleSlotClick のクロージャ陳腐化**: `useCallback` でラップされず毎レンダー再生成されるため常に最新 `selectedCard` を見る。非問題。
