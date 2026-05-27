# リファクタリング方針（UI / ページ層）

- **対象**: `src/App.tsx`、`src/components/`、`src/hooks/`（ページを構成するソースコード）
- **スコープ外**: `src/game/`（reducer・engine・setup・combo・scoring）、`src/ai/`。`game/reducer.ts` は 483 行あり別途レビューの価値があるが今回は対象外。
- **検証**: 全項目の行番号・変数名・箇所数・state 構造・import 関係を実コードと照合済み（2026-05-27 時点）。本書の各項目は事実確認を経た上で、技術的妥当性と実装順を再評価したもの。

---

## 現状分析

UI / ページ層のファイル行数（実測）:

| ファイル | 行数 | 備考 |
|---|---|---|
| `src/App.tsx` | 336 | UI 層の責務集中点。盤面組み立て・設定UI・手札UI・配置ロジック・寸法導出が同居 |
| `src/components/SlotView.tsx` | 147 | フェード演出・スタック配置。`computeStackOffset` を host するが自身は未使用 |
| `src/hooks/useGameLogic.ts` | 116 | reducer 駆動 + AI 自動進行 + タイマー管理 |
| `src/components/ActionPanel.tsx` | 91 | フェーズ説明文・操作ボタン |
| `src/components/CenterArea.tsx` | 81 | 4 座席の PlayerHeader/StartPlayerMarker をベタ書き |
| `src/hooks/useBoardSize.ts` | 94 | viewport から寸法を導出（state 非依存） |
| `src/components/GiftModal.tsx` | 78 | 未コミット変更中。本書では原則触れない |
| `src/components/FieldView.tsx` | 62 | — |
| `src/components/CardView.tsx` | 62 | — |
| `src/components/PlayerBoardView.tsx` | 54 | `orientation` + `stackDirection` を別 prop で受ける |
| `src/components/LogPanel.tsx` | 42 | `formatHeading`（ターン→ラウンド変換のドメインロジック）を内包 |
| `src/components/PlayerHeader.tsx` | 20 | — |
| `src/components/StartPlayerMarker.tsx` | 17 | — |

**評価**: 行番号・名称の事実誤認はなく、提案された「どこを直すか」の認識は正確。改善の主眼は (1) App.tsx への責務集中の分解、(2) `state.phase` 分岐の重複（3 箇所）の集約、(3) 座席マッピングのハードコード解消、の 3 点。

---

## 項目

実装推奨順に連番。`旧` は元提案の記号。

### 1. ヘッダー UI を AppHeader に切り出す（旧 A1）

**問題**: `App.tsx:177-210` の `<header>` 配下に「CPU 速度セレクト」「観戦モードトグル」「新規ゲームボタン」がインライン。盤面組み立てと設定 UI の関心が同居している。

**案**: `src/components/AppHeader.tsx` を新設。props は `cpuSpeed / setCpuSpeed / autoPilot / setAutoPilot / onStartNewGame`（いずれも `useGameLogic` 由来で共有状態の問題なし）。App.tsx を約 33 行短縮し、設定 UI の拡張（音量・難易度など）を独立させられる。

**工数**: 小
**優先度**: 中
**リスク**: 最低（純粋に表示の切り出し）。最初に着手して App.tsx を軽くするのに適する。

### 2. CenterArea の 4 座席を配列ループ化（旧 A5）

**問題**: `CenterArea.tsx:41-78` で top / left / right / bottom ごとに `<PlayerHeader>` と `{startPlayerIndex === xxx && <StartPlayerMarker>}` を 4 回繰り返している。

**案**: `{ position, player }` の配列を `.map()` で展開。4 座席はすべて prop（`topPlayer`〜`bottomPlayer`）で均一なので変換は素直。約 38 行 → 約 15 行。

**工数**: 小
**優先度**: 中

### 3. ActionPanel の `you = 0` ハードコード解消（旧 B4）

**問題**: `ActionPanel.tsx:18` で `batch.recipientId === 0` と直値で「自分」を判定している。

**案**: `youId: number` prop を受け取る形にする。CenterArea は既に `youId` を受け取っている（`App.tsx:257`）ので、ActionPanel も揃えるだけ。将来 `you` が 0 以外になったとき（座席シャッフル等）のバグを防ぐ。

**工数**: 極小
**優先度**: 中

### 4. formatHeading を game/ 配下へ移動（旧 C3）

**問題**: `LogPanel.tsx:9-17` の `formatHeading` はターン→ラウンド/座席変換という純粋なドメインロジックで、UI コンポーネントに属していない。

**案**: `src/game/log.ts`（新規）または `game/scoring.ts` 付近へ移動。`game/__tests__` から呼べるようになり、ログ整形のテストが書ける。

**工数**: 極小
**優先度**: 低〜中

### 5. PlayerBoardView の orientation + stackDirection を seat に統合（旧 C1）

**問題**: 呼び出しは top→(horizontal, up) / bottom→(horizontal, down) / left→(vertical, left) / right→(vertical, right) の 4 通りに固定（`App.tsx:215-288`）。2 prop に分かれているため「意味のない組み合わせ（horizontal + left 等）」を渡せてしまう。

**案**: `seat: 'top' | 'bottom' | 'left' | 'right'` 1 prop に統合し、内部で `orientation` と `stackDirection` を導出。型安全性が上がる。

**工数**: 小
**優先度**: 低〜中

### 6. AI 駆動判定を関数に切り出す（旧 B2）

**問題**: `useGameLogic.ts:80` の `actor.isCPU || autoPilot` と `:103` の `actor?.isCPU || autoPilot` が同じ意味の判定を 2 箇所で行っている。

**案**: `isAIDriven(state, autoPilot)` を新設。**内部で** `currentActorId(state)` → actor 取得 → `!!actor && (actor.isCPU || autoPilot)` までを閉じ込める。`:80` は事前 null チェック後の直接アクセス、`:103` はオプショナルチェーンと文脈が異なるため、actor 取得ごと関数に含めて差異を吸収する。

**工数**: 極小
**優先度**: 中

### 7. timer 管理を useTimeout フックに切り出す（旧 B3）

**問題**: `useGameLogic.ts:55-94` で `timerRef` の「クリアしてからセット」が resolvingCombos 分岐と通常分岐の両方にあり、cleanup（`:69-74` と `:88-93`）も重複。さらに先頭の clear（`:55-59`）と cleanup が冗長。

**案**: `set()` が clear-then-set する `useTimeout()` フックを導入。useEffect 本体は「次に何を何 ms 後にするか」だけになり、`return clear` 一本で gameOver 経路の片付けも一貫する。

```ts
function useTimeout() {
  const ref = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (ref.current !== null) { window.clearTimeout(ref.current); ref.current = null; }
  }, []);
  const set = useCallback((cb: () => void, ms: number) => {
    clear();
    ref.current = window.setTimeout(() => { ref.current = null; cb(); }, ms);
  }, [clear]);
  return { set, clear };
}
```

**工数**: 小
**優先度**: 中

### 8. isYourTurn / isYourActor の関数化（旧 B5）

**問題**: `App.tsx:71-73` の 2 変数は共通部分式 `state.phase !== 'gameOver' && !autoPilot` を含み、意味の違い（actor は gift placement の recipient を含む / turn は手番のみ）がコメントなしで読み取りにくい。

**案**: 共通部分式を括り出す。または純粋ヘルパー `isHumanInteractive(state, you, autoPilot, kind)` に集約。`useGameLogic` 戻り値に含める案もあるが、両者は `you`（App 側定義）に依存するため、純粋ヘルパー化の方が結合が少ない。

**工数**: 極小
**優先度**: 低〜中

### 9. opponents の座席割り当て構造化 + CenterArea のガード統一（旧 B1 + 新規）

**問題**:
- `App.tsx:140` の `opponents = state.players.filter((p) => p.id !== you)` に対し、`opponents[1]`=top（`:215,251`）、`opponents[0]`=left（`:229,252`）、`opponents[2]`=right（`:262,253`）と添字で割り当て。並びの意図がコードから読めない。
- **ガードの非対称**: 座席（PlayerBoardView）側は `opponents[N] && (…)` でガードしている一方、CenterArea には素の `opponents[N]` を渡し（`:251-253`）、CenterArea は `topPlayer.id` を無ガードでアクセスしている（`CenterArea.tsx:43`）。

**案**: 座席→相対位置のルールを 1 箇所で表現する。マッピングは検証済みで `left=(you+1)%n` / `top=(you+2)%n` / `right=(you+3)%n`。

```ts
const seatedOpponents = useMemo(() => ({
  top:   state.players.find((p) => p.id === (you + 2) % state.players.length) ?? null,
  left:  state.players.find((p) => p.id === (you + 1) % state.players.length) ?? null,
  right: state.players.find((p) => p.id === (you + 3) % state.players.length) ?? null,
}), [state.players, you]);
```

CenterArea 側もガード方針を座席側と揃える（null 許容 or 4 人前提を型で固定）。

**工数**: 小〜中
**優先度**: 高
**補足**: undefined アクセスは「実バグ」ではなく**潜在リスク**。現状は常に 4 人固定（`setup.ts:69-70` の `playerNames` / `cpuFlags` が 4 要素デフォルト、UI に人数変更経路なし）でクラッシュは起きない。ただしガードの非対称は実在する不整合なので、ここで揃える。将来 2〜3 人対応する際の変更点をこの 1 箇所に集約する効果もある。

### 10. useBoardLayout への集約 + computeStackOffset の移動（旧 A4）

**問題**:
- `App.tsx:151-172` の `globalMaxStack`（useMemo）/ `stackOffset = computeStackOffset(...)` / `cssVars` 組み立ては「state と viewport から CSS 寸法を導出する」処理だが App 本体に置かれている。
- `computeStackOffset` は `SlotView.tsx:30` で export されているが **SlotView 自身は使っていない**（SlotView は `stackOffset` を prop で受け取る、`:73`）。App だけが import している（`App.tsx:10`）。コンポーネントの責務を超えた共有ロジックが置かれている。

**案**: `computeStackOffset` を共有レイアウト util へ移動し、`useBoardSize` を `useBoardLayout(state)` に拡張して `{ boardSize, cardSize, layout, stackOffset, cssVars }` を返す。App 側は受け取るだけにする。

**工数**: 小〜中
**優先度**: 中
**注意**:
- `STACK_MAX_SPAN_RATIO` は SlotView の描画（`:74-76` の stackWidth/Height）でも使う。関数だけ移すと定数が分断されるので、**定数ごと共有 util に置き、SlotView から再 import** する。
- 現状 `useBoardSize` は state 非依存。`globalMaxStack`（state.players 依存）を取り込むとフックが state 依存になる。useMemo で実害は小さいが、「viewport 由来 dims」と「state 由来 stackOffset」を 1 フックに混ぜる設計判断であることは認識する。
- **他項目はこの項目に依存しない**。元提案は「土台だから最初」としていたが依存元ではないので、着手順は中盤で良い。

### 11. 配置フェーズのテーブル統合 + placeableCards を selectors へ（旧 A3 + C4）

**問題**: `state.phase` 分岐が **3 箇所**にある。
- `placeableCards`（`App.tsx:43-56`）: 配置候補カードのリストを返す（3 phase）
- `computeYourSlotInteractivity`（`App.tsx:18-41`）: 操作可能スロットを返す（4 phase、`awaitingAdditionalDiscard` のみ stack>0 に限定）
- `handleSlotClick`（`App.tsx:101-128`）: スロットクリック時のアクションを発行（4 phase）

phase が増減するたびに 3 箇所を手で同期する必要がある。`placeableCards` は純粋関数で、現状 `game/selectors.ts` は存在しない。

**案**: 1 つのテーブルに統合する。`awaitingAdditionalDiscard` がカード無し＆スロット限定であることから、`getInteractiveSlots` フィールドが必須。

```ts
type PlacementPhaseConfig = {
  getCards: (state: GameState) => Card[];
  getInteractiveSlots: (state: GameState) => number[];
  makeAction: (state: GameState, slotIndex: number, selected: Card | null) => Action | null;
};
const PLACEMENT_PHASES: Partial<Record<Phase, PlacementPhaseConfig>> = {
  awaitingPlaceDrawn: { ... },
  awaitingPlaceAdditionalDraw: { ... },
  awaitingAdditionalDiscard: { ... },
  awaitingGiftPlacement: { ... },
};
```

テーブルと `placeableCards` 相当を `game/selectors.ts`（新規）に置けば、項目 12（HandZone）からも参照できる。

**工数**: 中
**優先度**: 高
**注意**:
- `awaitingAdditionalDiscard` が `placeableCards` に無い「非対称」は**バグではなく設計**（捨札はカードリスト不要・スロット直接指定）。ただし 3 関数を手動同期するコストは実在するため、テーブル化の価値は高い。
- 中核の操作ロジックなので **`game/__tests__` にテストを書きながら**進める。
- 「AI（`actionSpace.ts`）から再利用できる」という再利用根拠は弱い（actionSpace はアクション空間生成で目的が別）。selectors への移動はあくまでレイヤリングと項目 12 への供給が目的。

### 12. 「あなたの手元」を HandZone に切り出す（旧 A2）

**問題**: `App.tsx:299-327` の `<div className="hand-zone">` 配下は GiftModal か手札表示かを分岐し、`selectedHandCardId` の state（`:86`）・同期 useEffect（`:88-96`）・`selectedCard` 派生（`:98-99`）を抱える。手札 UI だけで独立した小モジュールになっている。

**案**: `src/components/HandZone.tsx` を新設し、**表示と選択ボタンの発火**を受け持たせる。

**工数**: 中
**優先度**: 中
**注意（重要）**: `selectedHandCardId` / `selectedCard` は手札表示だけの状態ではない。**盤面のスロットクリック** `handleSlotClick` が選択カードを使う（`:105` の `PLACE_DRAWN`、`:120` の `PLACE_GIFT`）。スロットは盤面側（PlayerBoardView 経由）が持つため、選択状態を HandZone 内に閉じ込めると盤面クリック側から参照できなくなる。
→ `selectedCard` は cross-cutting state として **App か専用フック（例 `usePlacementSelection(state)`）に残し（lift）**、HandZone と handleSlotClick の両方へ配る。元提案の「状態を内側に閉じ込める」は逆。項目 11 の selectors 経由で `cardsToPlace` を供給する形にすると整理しやすいので、**項目 11 の後**に着手する。

### 13. SlotView のフェード管理を id ベースに（旧 C2）— 見送り推奨

**問題（として挙げられたもの）**: `SlotView.tsx:89` の `prev.indexOf(card)` がカード参照同一性に依存している、という指摘。

**評価**: **前提が成立しない**。該当の `card` は同じ関数内で `prev.filter(...)` から取り出した要素（`:85`）で、それを同一配列 `prev` 内で `indexOf` している。`card ∈ prev` が保証されるため参照は常に一致し、reducer / immer 由来の参照差では破綻しない。`removed` 判定（`:85`）・cleanup（`:95`）・key（`:136`）は既に id ベース。id 化しても堅牢性は上がらず、Map 化（O(n)→O(1)）もスタック最大 3〜4 枚（`STACK_OFFSET_RATIO` / `STACK_MAX_SPAN_RATIO`）では無意味。

**案**: 実施するなら理由を「可読性のみ」に限定。**優先度最下位、または見送り**。

**工数**: 極小
**優先度**: 低（見送り推奨）

---

## まとめ

| # | 項目 | 旧 | 工数 | 優先度 | 依存 / 備考 |
|---|---|---|---|---|---|
| 1 | AppHeader 切り出し | A1 | 小 | 中 | 独立・最低リスク。最初に App.tsx を軽くする |
| 2 | CenterArea 座席配列化 | A5 | 小 | 中 | 独立 |
| 3 | ActionPanel youId プロップ化 | B4 | 極小 | 中 | 独立。CenterArea の youId と揃える |
| 4 | formatHeading を game/ へ | C3 | 極小 | 低〜中 | 独立。テスト可能化 |
| 5 | PlayerBoardView seat 統合 | C1 | 小 | 低〜中 | 独立 |
| 6 | AI 駆動判定の関数化 | B2 | 極小 | 中 | useGameLogic 内 |
| 7 | timer の useTimeout 化 | B3 | 小 | 中 | useGameLogic 内 |
| 8 | isYourTurn/isYourActor 整理 | B5 | 極小 | 低〜中 | 独立 |
| 9 | opponents 構造化 + ガード統一 | B1+新規 | 小〜中 | 高 | 座席マッピング 1 箇所化。潜在リスクとガード非対称を解消 |
| 10 | useBoardLayout 集約 | A4 | 小〜中 | 中 | 定数の SlotView 再 import に注意。依存元ではない |
| 11 | 配置 phase テーブル統合 + selectors | A3+C4 | 中 | 高 | **テスト必須**。3 関数を集約 |
| 12 | HandZone 切り出し | A2 | 中 | 中 | **→ 項目 11 の後**。selectedCard は lift して共有 |
| 13 | SlotView フェード id 化 | C2 | 極小 | 低 | **見送り推奨**（前提が成立しない） |

**依存関係**: 11 → 12（配置セレクタ確定後に HandZone）。9 は CenterArea のガードと一体。10 は独立（他項目の前提ではない）。1〜8 は相互に独立で任意順。

---

## 不採用とした指摘（記録）

発見フェーズで挙がったが、精査の結果、項目化しないもの（再提起防止のため記録）:

- **useEffect 依存配列（`App.tsx:88-96`）から `selectedHandCardId` を外す**: 誤り。外すと stale closure 化する。実体は「`cardsToPlace` が毎レンダー新参照で effect が毎回走るがガードで setState されず無害」。整理するなら項目 12 で選択ロジックごと隔離する。
- **key={idx}（`PlayerBoardView.tsx:39` / `LogPanel.tsx:32`）**: 本コードでは問題なし。スロットは固定 5 枚・順序不変、ログは追記のみ。フェードは SlotView 内で `card.id` を key にしている（`:136`）。
- **useBoardSize の calc 二重呼び出し（`:89`）**: マウント後に寸法を確定させる意図的な呼び出しで実害なし。
- **GiftModal の `targets[i]!`（`:37`）**: `allReady`（`:30`）でガード済み。かつ当該ファイルは未コミット変更中のため今は触らない。
- **handleSlotClick のクロージャ陳腐化**: `useCallback` でラップされず毎レンダー再生成されるため常に最新 `selectedCard` を見る。非問題。
