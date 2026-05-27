# リファクタリング方針

## 現状分析

- **規模**: `src/` 43 ファイル（`.ts`/`.tsx`、うちテスト 4、4,608 行）、`ai/scripts/` 9 ファイル（2,318 行）、合計 6,926 行。※新規追加（未コミット）の `src/ai/neuralAI.ts`(367 行・ブラウザ NN 推論) と肥大化した `src/ai/index.ts`(29 行) を含む。未追跡の一時/補助ファイル `ai/scripts/_profile-hotpath.ts`(93)・`nn/_smoke-gpu.ts`(29)・`nn/make-dummy.ts`(42) は集計外。
- **最大ファイル**: `src/game/reducer.ts`(504), `src/ai/mctsAI.ts`(447), `ai/scripts/nn/neuralMcts.ts`(433), `src/ai/neuralAI.ts`(367), `ai/scripts/tune-es.ts`(331), `ai/scripts/nn/dataset.ts`(307)
- **構成**: UI(`src/components` + `src/hooks` + `src/App.tsx`) / ゲーム(`src/game`) / AI(`src/ai`、ブラウザ用) / 学習基盤(`ai/scripts`、Node 用)
- **直近の動き**: UI 層は表示調整が継続（スロット表示長・カード描画スケール・盤面レイアウト）。AI 側は Gen-3-K8 で NN-MCTS に virtual loss を導入したが検証の結果 default off に戻した（`ade42a5`）。さらに直近（未コミット、`0178861` 以降の作業ツリー）で**ブラウザ NN 統合**が着地：`src/ai/neuralAI.ts`（tfjs ブラウザ版 NN-guided MCTS + mctsAI フォールバック）、`loadNeuralAI` を `index.ts` に追加、`public/models/dummy/` 配置、`train.ts --copy-to-public` 対応。ブラウザ DEFAULT は引き続き Gen-3-F (89.5%) を維持。

主要な負債は **「ゲーム / AI / 学習スクリプトの三層に同一ロジックがコピーされている」** こと（ブラウザ NN 統合で `neuralAI.ts` が加わり重複箇所がさらに増えた。特に IS-MCTS フレームワークは mctsAI / neuralMcts / neuralAI の**3 実装**に増殖し、seed 導出は既に乖離している＝項目 22・34）、**「UI が一部のルール（プレゼントのカード選択）を実装し切れていない」** こと、そして **評価関数 `evaluateState` の得点二重計上窓**（項目 3）。

---

## 実質的なバグ・機能欠落（最優先）

### 1. 追加アクション「取り除き」ボタンに空スロットガードがない

**問題**: `src/components/ActionPanel.tsx:81-87` の `CHOOSE_ADDITIONAL_DISCARD` ボタンに `disabled` が付いていない。全スロット空のとき押すと `awaitingAdditionalDiscard` に遷移するが操作可能スロットがなく、画面上で詰む。
ドロー側（`:73-80`）は `disabled={!canDrawAdditional}` でガードしており、`smartAI`(`smartAI.ts:69-71`) と `actionSpace`(`actionSpace.ts:75-78`) も同条件でフィルタしている。UI だけが穴空き。

**案**:

```tsx
const canDiscard = state.players[youId].board.slots.some((s) => s.stack.length > 0);
// ...
<button ... disabled={!canDiscard}>スロット最上段を1枚捨札</button>
```

**工数**: 極小
**優先度**: 高

### 2. `randomAI` が空山札・空捨札でも `DRAW_FROM_DECK` を返しうる

**問題**: `src/ai/randomAI.ts:38-46` の `awaitingDraw` 分岐で、場ドロー確率(0.6)を外したときは無条件で `{ type: 'DRAW_FROM_DECK' }` を返す。`state.deck.length === 0 && state.discardPile.length === 0` でも返してしまうため、`stepGame` が state 不変を返し、対戦ループは `state === before` で break。`finished: false` の打ち切り局となり、ベンチ・self-play の集計に汚れた結果が混じる。

**案**:

```ts
case 'awaitingDraw': {
  const fieldOpts: Array<0 | 1> = [];
  if (state.field[0]) fieldOpts.push(0);
  if (state.field[1]) fieldOpts.push(1);
  const canDeck = state.deck.length > 0 || state.discardPile.length > 0;
  if (fieldOpts.length > 0 && (rand() < 0.6 || !canDeck)) {
    return { type: 'DRAW_FROM_FIELD', pairIndex: pickRand(fieldOpts, rand) };
  }
  if (canDeck) return { type: 'DRAW_FROM_DECK' };
  return null;
}
```

**工数**: 極小
**優先度**: 高

### 3. `evaluateState` がギフトフェーズで当該ターンの得点を二重計上する

**問題**: `src/game/reducer.ts:103-134` の `finalizeTurnAfterCombos` は `player.score += total`（`:110-112`）で当ターンの combo 得点を**確定**したあと、`turn.combosThisTurn` を**クリアせずに** `giftQueue` へコピーし（`:130`）、`awaitingGiftSelection` へ遷移する。`combosThisTurn` が空になるのは `endTurn`（`:157`）。
一方 `src/ai/evaluator.ts:155-158` は `state.currentPlayerIndex === playerId` のとき `totalScoreForTurn(state.turn.combosThisTurn).total * pendingMult` を加点する。このため `awaitingGiftSelection` / `awaitingGiftPlacement` フェーズの状態を評価すると、`me.score`（既に combo 分を含む）に加えて pending 分（同じ combo）が**二重加算**される。`smartAI` / `mctsAI` がこれらフェーズの `nextState` を `evaluateState` する経路で発生する。

**案**: `pendingMult` は「得点未確定の pending combo を先取り評価する」意図なので、(a) `finalizeTurnAfterCombos` で `combosThisTurn` をクリアする（pending は `giftQueue` で持つ）、または (b) `evaluateState` の pending 加点を得点未反映フェーズ（`resolvingCombos` 等）に限定する。**現挙動で重みが学習・チューニング済みのため、修正時は再チューニング（tune-es / NN 再学習）が必須**。先に二重計上の影響度を計測してから着手するのが安全。

**工数**: 小〜中（修正自体は小、再チューニング込みで中）
**優先度**: 中（AI 評価の歪みだが、現状は学習が適応しており即時破綻はしない）

### 4. `smartAI.evaluateUnknownDraw` が山札枯渇時にサンプリング無効・無駄ループ

**問題**: `src/ai/smartAI.ts:116-133` は `DRAW_FROM_DECK` / `CHOOSE_ADDITIONAL_DRAW` の期待値を 4 サンプルで推定するため `shuffle(state.deck, rand)`（`:127`）で山札順を変えてから `stepGame` する。だが**山札が空（`state.deck.length === 0`）で捨札にカードがある**場合、`shuffle([])` は空配列を返し、実際のドローは `engine` 側の `reshuffleDiscardIntoDeck`（固定 seed）で決まる。結果、4 サンプルすべてが**同一状態**になり、`for` ループは無駄に 4 回同じ計算を繰り返す（分散推定にならない）。終盤の山札枯渇時に「引く」手の評価が決定論的に偏る。

**案**: `state.deck.length === 0 && state.discardPile.length > 0` のときは捨札もシャッフル対象に含めて determinize するか、サンプル数を 1 に落として無駄ループを省く。

**工数**: 小
**優先度**: 中

### 5. プレゼント UI が各コンボの「渡すカード」を常に先頭固定

**問題**: `docs/RULES.md:117-120` では「各コンボから1枚を**選んで**渡す」と仕様化されているが、`src/components/GiftBar.tsx:37` は `const card = combo.cards[0]` を表示し、`src/App.tsx:101` も `cardId: combo.cards[0].id` を送る。`reducer` の `validateAssignments`(`reducer.ts:312`) は任意の `combo.cards.find` を受け付ける設計なので、UI が機能を提供していない欠落。3 枚以上の同色コンボでも、現状はユーザーが渡すカードを選べない（同色だが ID は別物なのでゲーム上の影響は限定的だが、ルール準拠の観点と「将来 NN ヘッドを差し替えるとき」の整合性として要修正）。

**案**: `GiftBar` の行ごとに「コンボ内のどのカードを渡すか」の選択 state を持たせ、`handleConfirmGifts` で選択 ID を `assignments` に反映する。

**工数**: 小〜中
**優先度**: 中（同色なら効果は同等のため、ルール表現の問題として中）

---

## 過剰な防御コード・デッドコードの排除（極小工数）

### 6. `smartAI` tie-break の `?? top` フォールバックがデッド

**問題**: `src/ai/smartAI.ts:177-179` の `const tied = scored.filter((s) => s.score >= topScore - 0.5)` は必ず `top` 自身（`top.score >= topScore - 0.5`）を含むため `tied.length >= 1`。`tieRand()` は `[0, 1)` を返すので `tied[Math.floor(tieRand() * tied.length)]` は常に有効要素を返し、末尾の `?? top` は到達不能。全アクションが例外で `-Infinity` でも `-Infinity >= -Infinity - 0.5` は true なので tied に入る。ロジックミス隠蔽の不要フォールバック。

**案**: `?? top` を削除する。

**工数**: 極小
**優先度**: 中

### 7. `evaluateState` の終局加点が呼び出し元によって生死が変わる

**問題**: `src/ai/evaluator.ts:163-164` の `winnerBonus` / `loserPenalty` 加点は `state.winnerId` が非 null のときのみ効くが、`winnerId` は `reducer.ts:142` の `gameOver` 遷移時にしか代入されない。一方 `mctsAI` は終局を**ランキング経由で先に処理**してから `evaluateState` を呼ぶ（`leafValueByEvaluator:137-140`、`computePriors:213-216` がともに `phase === 'gameOver'` を別扱い）ため、mcts 経路では `winnerId` は常に null → これら 2 行は**到達不能**。`smartAI`(`smartAI.ts:165`) は gameOver の `nextState` を直接 `evaluateState` するため**生きている**。同じ関数の同じ分岐が呼び出し元で生死が変わり、`winnerBonus`/`loserPenalty` の重みが smartAI でだけ効く非対称がある。

**案**: 終局価値の扱いを一本化する（mcts と同じくランキングベースに寄せ、`evaluateState` から終局専用分岐を撤去）か、「smartAI 専用の終局加点」であることをコメントで明示する。

**工数**: 小
**優先度**: 中

### 8. `stepGame` の連鎖打ち切りがマジックナンバー＋silent

**問題**: `src/game/reducer.ts:496-504` の `stepGame` は `resolvingCombos` ループを `while (... && safety < 16)` で打ち切る。`16` はマジックナンバーで根拠がコメント化されておらず、上限到達時に**ログも警告も出さず** `resolvingCombos` のままの状態を返す。万一ロジックバグで 16 を超えると、`resolvingCombos` フェーズのまま AI/UI に返り、合法手が枯渇して `state === before` の silent 打ち切り（項目 26）に化ける。本来ありえない状態への黙ったフォールバック。

**案**: `16` を名前付き定数（例 `MAX_CHAIN_RESOLVE_STEPS`）にし、根拠（1 ターンの連鎖は最大 5 スロット由来）をコメント化。上限到達時は `console.warn` か例外を出す。

**工数**: 極小
**優先度**: 中

### 9. `legalActionMask` が未使用のデッドエクスポート

**問題**: `src/ai/actionSpace.ts:114-120` の `legalActionMask`（`boolean[]` 版）はリポジトリ全体から呼ばれていない（grep で定義箇所のみ）。実際に使われるのは `legalActionIds`（`number[]` 版）。ブラウザ NN 統合の `neuralAI.ts` も `legalActionIds` を使い、mask 版は参照しない。NN マスク用に作られたが現状未使用。

**案**: 使う予定が無ければ削除。将来 masked policy で使うなら `// reserved for masked policy` を明記。

**工数**: 極小
**優先度**: 中

### 10. `getEncodingShape` / `EncodingShape` が未使用のデッドエクスポート

**問題**: `src/ai/encoding.ts:130-148` の `getEncodingShape()` と `interface EncodingShape` は外部から一切参照されていない（grep で `encoding.ts` 内のみ）。NN は `ENCODING_SIZE` を直接使う（`neuralAI.ts` も `encodeState` を呼ぶのみで shape API は使わない）。皮肉なことに項目 31 の案は「`getEncodingShape(numPlayers)` への切り替え」を提案しているが、現状の `getEncodingShape` は引数を取らず誰も呼んでいない死蔵 API。

**案**: 削除するか、項目 31 の可変化方針と統合して引数付きに再設計する。

**工数**: 極小
**優先度**: 中（→ 項目 31 と方針を揃える）

### 11. `Phase` の `'turnEnd'` がデッドコード

**問題**: `src/game/types.ts:36` で `'turnEnd'` を定義し、`src/ai/encoding.ts:17` の `PHASES` 配列にも含まれているが、`reducer` のどこからも遷移しない。NN 入力の phase one-hot 次元が 1 つ無駄。

**案**: 将来使う予定がなければ types / encoding から削除。残すなら `// reserved` コメントを付けて意図を明示する。
**注意**: `PHASES` から削除すると `ENCODING_SIZE` が 185→184 に変わり、**既存の学習済みモデル（入力 185 次元）が全て load 不能**になる。これは Node 学習側だけでなく、ブラウザ推論 `neuralAI.ts:48-72`(`tf.loadLayersModel`) の読み込みも壊す。削除する場合はモデル再学習とセットで（項目 31 と同様の非互換が生じる）。

**工数**: 極小（型のみ）／中（モデル再学習込み）
**優先度**: 中

### 12. `useGameLogic.delayFor` が未使用引数を持つ薄いラッパー

**問題**: `src/hooks/useGameLogic.ts:22-24` の `delayFor(_state, speed)` は `_state` を完全に無視して `normalizeDelay(speed)` を返すだけ。`_state` は「フェーズ別に遅延を変える」想定の残骸（デッドパラメータ）。呼び出しは `:98` の 1 箇所のみで、`resolvingCombos` 分岐（`:84`）は `delayFor` を使わず直接 `normalizeDelay(cpuSpeed)` を呼んでおり、遅延取得が 2 経路に分かれている。

**案**: `delayFor` を削除し、全箇所 `normalizeDelay(cpuSpeed)` に統一する。

**工数**: 極小
**優先度**: 低

### 13. CLI の数値引数が `NaN` を黙って受理する

**問題**: `ai/scripts/tune-es.ts:190-215`、`bench-neural.ts:152-159`、`train.ts:80-119`、`_runner.ts:168-197` で数値オプションが軒並み `Number(argv[++i])`。`--games abc`（不正値）や `--games`（値忘れ、`argv[++i]` が `undefined`）は `NaN` になり**エラーにならず**、`for (g = 0; g < NaN; ...)` などに流れて 0 ループ・無出力で正常終了したように見える。CLI の典型的な握りつぶし。train.ts はブラウザ NN 統合で `--hidden-units` / `--hidden-layers` など数値引数がさらに増えた（`:116, 119`）。

**案**: `parseIntArg(name, raw)` ヘルパで `Number.isFinite` を検証し、不正なら throw する。

**工数**: 小
**優先度**: 中

---

## 定数・ドキュメントの整合（極小工数）

### 14. `COLOR_LABEL` が 2 箇所に重複しており、型も不一致

**問題**: 色→日本語ラベルの同一マップが `src/game/reducer.ts:18-24`（`Record<string, string>`）と `src/components/CardView.tsx:9-15`（`Record<Color, string>`）の 2 箇所にある。reducer 側は `Record<string, string>` のため `COLOR_LABEL[unknownKey]` が型上は `string` を返すが実体は `undefined` になりうる（`:70, 184, 243, 286, 367` で参照）。`appendLog` のメッセージに `undefined` が混入してもコンパイルが通る。新色追加時に片方だけ更新するリスクもある。

**案**: `src/game/labels.ts` に `export const COLOR_LABEL: Record<Color, string>` を 1 つ置き、両方から import する。型が `Record<Color, string>` になることで欠損キーも検出できる。

**工数**: 極小
**優先度**: 中

### 15. アニメーション時間定数 700ms が 2 箇所に独立定義

**問題**: `src/components/SlotView.tsx:46`(`FADE_DURATION_MS = 700`) と `src/hooks/useGameLogic.ts:15`(`RESET_FADE_OUT_MS = 700`) で同値定数が別ファイルに定義され、コメント依存で同期している。

**案**: `src/hooks/boardLayout.ts` などの共通モジュールに `CARD_FADE_DURATION_MS = 700` を 1 つだけ export し、両方から import。

**工数**: 極小
**優先度**: 中

### 16. `DEFAULT_MAX_STEPS` の help 文と実装値が不一致

**問題**: `ai/scripts/_runner.ts:99` で `DEFAULT_MAX_STEPS = 20000` だが、`ai/scripts/bench.ts:13,67` と `ai/scripts/selfplay.ts:11,30` の help 文には `default: 5000` と書かれている。実際の default は `parseCommonArgs`(`_runner.ts:163`) 経由で 20000 が効くので、help を信じた利用者の想定がずれる。

**案**: help と `parseCommonArgs` の説明をすべて 20000 に揃える（または意図的差なら明記）。

**工数**: 極小
**優先度**: 中

---

## 重複排除（ローカル）

### 17. `reducer` の `oldCardIds` 収集が 2 箇所で同じ三重ループ

**問題**: `src/game/reducer.ts:426-432`(`NEW_GAME`) と `:444-450`(`CLEAR_BOARDS_FOR_RESET`) で全プレイヤー全スロットから `card.id` を集める同じ三重ループ（players × slots × stack）が並ぶ。

**案**: ファイル内 private 関数 `collectAllBoardCardIds(state)` に括り出す。

**工数**: 極小
**優先度**: 低

### 18. `wilsonInterval` と期待順位計算が 2 ファイルに同じ実装

**問題**: Wilson 95% 信頼区間の同一実装が `ai/scripts/bench.ts:49-57` と `ai/scripts/bench-neural.ts:106-114` にある。加えて、期待順位の計算式 `rankCount.reduce((acc, c, idx) => acc + c * (idx + 1), 0) / games` も `bench.ts:161-163` と `bench-neural.ts:210` で重複しており、同じ「ベンチ集計ユーティリティ未抽出」問題の一部。

**案**: `ai/scripts/stats.ts` に `wilsonInterval` と `expectedRankFromRankCount` をまとめて両ベンチから import。

**工数**: 極小
**優先度**: 低

---

## ゲーム / AI 層の共通ユーティリティ集約

> 以下 19–24 は密接に関連する重複群。`src/game/actors.ts`（または `selectors.ts` 拡張）と `src/game/ranking.ts`、`src/ai/seed.ts` を整備して一気に整理するのが効率的。ブラウザ NN 統合で追加された `src/ai/neuralAI.ts` も同じロジックを再コピーしているため、集約の対象に含める。

### 19. `currentActorId` が 8 箇所で同一定義

**問題**: 贈与配置中は `pendingGiftBatches[0].recipientId` を返し、それ以外は `state.currentPlayerIndex` を返すロジックが以下の 8 箇所にコピーされている。

- `src/hooks/useGameLogic.ts:26-31`
- `src/ai/mctsAI.ts:62-70`
- `src/ai/neuralAI.ts:118-126`（ブラウザ NN 統合で新規追加）
- `ai/scripts/_runner.ts:68-76`
- `ai/scripts/nn/neuralMcts.ts:70-78`
- `ai/scripts/nn/dataset.ts:37-45`
- `ai/scripts/tune-es.ts:50-58`
- `ai/scripts/bench-neural.ts:36-44`

本来はゲームドメインの責務（フックや AI 側に持つべきではない）だが、共通の置き場所が無く、`App.tsx:2` は `useGameLogic` の re-export を import している。ルール変更時の同期漏れリスクが高い。
※ 作業ツリー未追跡の `ai/scripts/_profile-hotpath.ts:25-30` にも 9 個目の同一定義がある。これをコミットする場合は集約に巻き込む。

**案**: ゲームコア（`src/game/selectors.ts` か新設 `src/game/actors.ts`）に `export function currentActorId(state: GameState): number` を置き、UI・AI・全 Node スクリプトを import に置換。`useGameLogic.ts` の re-export を後方互換のため一時的に残す（`App.tsx` が import している）。

**工数**: 中
**優先度**: 高

### 20. `computeRanking` が 7 箇所に重複、`computeWinner` も同じ tie-break を再実装

**問題**: 得点降順＋同点時は `startPlayerIndex` からの距離で順位付けする同一アルゴリズムが以下に存在。

- `src/ai/mctsAI.ts:72-85`
- `src/ai/neuralAI.ts:132-145`（ブラウザ NN 統合で新規追加）
- `ai/scripts/_runner.ts:78-91`
- `ai/scripts/nn/neuralMcts.ts:84-97`
- `ai/scripts/nn/dataset.ts:52-65`
- `ai/scripts/bench-neural.ts:46-59`
- `ai/scripts/tune-es.ts:91-97`（`computeRanking` 関数を持たず、`ordered.findIndex((p) => p.id === 0)` の同一ソートを**インライン展開**）
- `src/game/engine.ts:135-144`(`computeWinner` も同じ sort 比較子)

**案**: `src/game/ranking.ts` に `computeRanking(state): number[]`（`ranking[playerId] = 0..n-1`）を置き、`computeWinner` を `computeRanking` の先頭から導出するように `engine.ts` も再構成。tune-es のインライン版も共通呼び出しに置換。

**工数**: 中
**優先度**: 高 （→ 項目 21 と同時着手）

### 21. `rankToValue` が 4 箇所に重複

**問題**: `1 - 2*rank/(numPlayers-1)` で順位を [-1, +1] にマップする式が `src/ai/mctsAI.ts:91-94`、`src/ai/neuralAI.ts:128-130`（新規）、`ai/scripts/nn/neuralMcts.ts:80-82`、`ai/scripts/nn/dataset.ts:47-50` の 4 箇所にある。4 箇所とも `numPlayers <= 1` をガード済みで、差は `if` 文か三項演算子かの記法だけ（実質完全同一）。

**案**: 項目 20 の `src/game/ranking.ts` に同居させる。

**工数**: 小
**優先度**: 中 （→ 項目 20 と同時着手）

### 22. `stateBaseSeed` が 4 箇所に重複＋ブラウザ版が式まで乖離

**問題**: `rngSeed / turnNumber / playerId / log.length` から決定論的 seed を生成する処理が `src/ai/mctsAI.ts:96-102`、`src/ai/smartAI.ts:21-27`、`src/ai/randomAI.ts:4-10`、`ai/scripts/nn/neuralMcts.ts:99-105` の 4 箇所にある（いずれも `Math.imul(turnNumber+1, 0x9e3779b1)` 等で混合する同一実装）。
さらに、ブラウザ NN 統合で新規追加された `src/ai/neuralAI.ts:255-256` は同じ 4 入力から seed を作るが、**式が異なる**（`rngSeed ^ (turnNumber*7919) ^ (playerId*13) ^ log.length`、`Math.imul` を使わない弱い混合）。`neuralAI` は `neuralMcts` の移植のはずだが seed 導出が既に乖離しており、共通化していれば起きなかった不整合。学習側と推論側で探索のランダム化が食い違う遠因にもなる（→ 項目 34）。

**案**: `src/ai/seed.ts` に `stateBaseSeed` を集約し、neuralAI も含め全 5 箇所を置換。これで式の乖離も解消する。

**工数**: 小〜中
**優先度**: 中

### 23. 非空スロット index 列挙ロジックが 4 箇所に散在

**問題**:

- `src/game/selectors.ts:25-31`(`nonEmptySlotIndices`、**非 export** のため AI から再利用不能)
- `src/ai/actionSpace.ts:107`(インライン null チェック)
- `src/ai/smartAI.ts:80-85`
- `src/ai/randomAI.ts:70-72`

**案**: `selectors.ts` の `nonEmptySlotIndices` を export する（または `src/game/boardUtils.ts` を新設）。`actionSpace` / `smartAI` / `randomAI` から共通呼び出しに統一。

**工数**: 小
**優先度**: 中

### 24. `Float32Array[]` の 2 次元 pack/unpack が 2 箇所に手書き重複

**問題**: 「`Float32Array[]` を `[n, size]` の flat バッファに `buf.set(vecs[i], i*size)` で詰める／逆に `subarray` で切り出す」パターンが `ai/scripts/nn/train.ts:161-174`(`examplesToTensors` の入力詰め込み) と `ai/scripts/nn/neuralMcts.ts:112-135`(`nnPredictBatch` の出力切り出し) で重複。両者は逆操作の対。

**案**: `packFloat2D(vecs): {buf, n, size}` / `unpackFloat2D(flat, n)` ヘルパに集約。

**工数**: 小
**優先度**: 中

---

## エラーハンドリング・防御コードの整理

### 25. `catch { score = -Infinity }` / `catch { continue }` が例外を握りつぶす

**問題**:

- `src/ai/smartAI.ts:160-169`：合法手のはずの `stepGame` が throw したら `-Infinity` 扱い。
- `src/ai/mctsAI.ts:207-210`(`computePriors` 内)：throw したら prior をスキップして次へ。

正常系では到達しないはずの状態を黙って隠すため、bug の発見が遅れる。実際 `stepGame` は throw しない設計（`reducer` は state を返す）なので、catch 自体が過剰防御の可能性が高い。

**案**: 開発時は `console.warn` + 状態スナップショットを出し、本番は `try/catch` を撤廃するか、限定例外型のみ捕捉する。

**工数**: 小
**優先度**: 中

### 26. シミュレーション打ち切り時の silent break

**問題**: `ai/scripts/_runner.ts:122-128`、`ai/scripts/tune-es.ts:84-87`、`ai/scripts/bench-neural.ts:89-92`、`ai/scripts/nn/dataset.ts:158-169` で `!action` または `state === before` のとき `break` するが、原因（phase / actor / action type）を記録しない。`finished: false` の局が混ざっても何が起きたか追えない。

**案**: 戻り値に `abortReason?: 'no_action' | 'stale_step'` を含め、`--silent` 以外では 1 行 warn を出す。dataset 生成では abort 局を学習データから除外。

**工数**: 小
**優先度**: 中

---

## AI 層の構造的改善

### 27. `smartAI.enumerateActions` と `actionSpace` が合法手を二重管理

**問題**: MCTS / NN-MCTS / 学習データ生成は `actionSpace.legalActionIds + actionIdToAction` を使うが、`smartAI` は独自の `enumerateActions`(`smartAI.ts:29-89`) を持つ。フェーズ追加や合法条件変更時に 2 系統の同期が必要。例: `awaitingPlaceDrawn` で smartAI は `pendingDraw[0]` のみ列挙(`smartAI.ts:58`)、actionSpace は `[0]`(`:84-89`) と `[1]`(`:90-95`) 両方を扱う、という挙動差もある。

**案**: smartAI を `legalActionIds(state, playerId).map(id => actionIdToAction(...)).filter(Boolean)` に書き換える。`CONFIRM_GIFTS` のみ actionSpace 外（`actionSpace.ts:21-22`）なので別経路を残す。

**工数**: 小〜中
**優先度**: 中

### 28. `dataset.ts` の自己対戦生成 2 関数がほぼコピペ

**問題**: `ai/scripts/nn/dataset.ts:126-196`(`generateSelfPlayGame`、mctsAI 用) と `:202-275`(`generateSelfPlayGameWithModel`、neuralMcts 用) が ~90% 同一。差分は decider 呼び出しと `info`/`visits` の取り出し方のみ。

**案**: `runSelfPlayLoop(decider)` に共通化し、両関数は decider 注入の薄いラッパーにする。項目 19〜23 完了後に着手すると差分がさらに減る。

**工数**: 中
**優先度**: 中 （→ 項目 19〜23 の後）

### 29. 対戦ループ `playOneGame` / `playOne` が 3 実装

**問題**:

- `ai/scripts/_runner.ts:101-143`(`playOneGame`、汎用)
- `ai/scripts/tune-es.ts:65-104`(`playOne`、mcts vs 固定相手)
- `ai/scripts/bench-neural.ts:61-104`(`playOne`、neural seat 固定)

骨格（setup → while → currentActor → decider → stepGame → break）が同一。

**案**: `_runner.ts` に `playOneGameWithDeciders(deciders: Decider[], options)` を追加し、tune-es / bench-neural から委譲。席固定・重み注入は decider ファクトリで表現する。

**工数**: 中
**優先度**: 中 （→ 項目 19〜20 の後）

### 30. `nnPredictBatch` / `nnPredict` の `as` キャストが出力構造に無検証依存

**問題**: `ai/scripts/nn/neuralMcts.ts:121-123` で `model.net.predict(input) as tf.Tensor[]` と `out[0].dataSync() as Float32Array` の二重 `as` キャスト。同じパターンがブラウザ版 `src/ai/neuralAI.ts:177-179`(`nnPredict`) にもコピーされている（`predict(input) as tf.Tensor[]`、`out[0]` / `out[1].dataSync() as Float32Array`）。`predict` が単一 Tensor を返す構成（出力 1 つ）に変わると `out[1]` が `undefined` で実行時例外。`dataSync()` も dtype が float32 でないと `Float32Array` でない可能性があり、キャストが嘘になりうる。モデル構造（policy + value の 2 出力）への暗黙依存が、学習側・ブラウザ側の両方で型に守られていない。

**案**: `Array.isArray(out) && out.length === 2` を assert するヘルパに括り出し、両方から使う。または model 側で出力テンソルを名前で取り出すラッパを用意する。

**工数**: 小
**優先度**: 中

### 31. NN 入出力次元のプレイヤー数・スロット数ハードコード

**問題**: `src/ai/encoding.ts:6`(`NUM_PLAYERS = 4`) と `ai/scripts/nn/model.ts:24`(`VALUE_HEAD_SIZE = 4`) が 4 固定。一方 `setup.ts` は `playerNames.length` で人数可変。4 人以外で `encodeState` / 学習を動かすとサイズ不整合だが、サイレントに進む可能性がある（ブラウザ推論 `src/ai/neuralAI.ts:298` も `encodeState` を呼ぶため、この仮定はブラウザ配信時にも及ぶ）。さらに、AI ヒューリスティック（`smartAI.ts:91-113` の `buildGiftAssignmentsHeuristic` や `randomAI.ts:76-86`）は `opponents`/`otherIds` が空（人数 < 2）だと例外や `undefined` 混入を起こす。スロット数 `5` も `actionSpace.ts:26`(`NUM_SLOTS`)・`encoding.ts:5`(`SLOTS_PER_BOARD`)・`setup.ts:12`(`DEFAULT_SLOTS`) の 3 ファイルに独立定義されている。

**案**: 現状 4 人固定なので、`setupGame` 時に `assert(players.length === 4)` を入れる（極小工数）。これで空 `opponents` 経路も塞げる。スロット数定数も 1 箇所に集約。本気で可変化するなら `getEncodingShape(numPlayers)`（項目 10）への切り替えが必要（中工数）。

**工数**: 極小（assert + 定数集約）／ 中（可変化まで）
**優先度**: 中

### 32. NN-MCTS の探索打ち切り path に全員価値 0 を backup

**問題**: `ai/scripts/nn/neuralMcts.ts:274-276`(`zeroValueVec()`) を `kind: 'cut'`(`:293, 310, 314, 316` の 4 箇所) で backup している。同じ「打ち切り時に全員 0 の価値ベクトルを backprop する」挙動はブラウザ版 `src/ai/neuralAI.ts` にもあり、深度上限・非法 action・`stepGame` 不変（`:291, 316, 323`）で `new Float32Array(numPlayers)`（= 全 0）を leaf 価値として backup する。深度上限・非法 action 到達時に「中位相当」を一票入れることで木の統計を歪め、AlphaZero 学習データの value target 品質にも影響しうる。

**案**: cut 時は backup しない、または親ノードの cached value を使う。`cut` 発生率を計測ログに出してから方針決定するのが安全。learn 側（neuralMcts）と推論側（neuralAI）で挙動を揃えること（→ 項目 34）。

**工数**: 小〜中
**優先度**: 低

### 33. `evaluator` / `_runner` のモジュール global state が並列実行で危うい

**問題**: `src/ai/evaluator.ts:80-84` の `let currentWeights` + `setEvalWeights` がプロセス global。`ai/scripts/bench.ts:93` で global を書き換え、`:103` で `STRATEGIES.mcts`（`_runner.ts` のエクスポート定数）も `const` の中身を破壊的代入している。同一プロセスで複数回ベンチを回す将来のテスト等で前回の weights が残る。Gen-3-J 以降は `options.weights` 渡しで AI 単位に閉じる API（`_runner.ts:39-42` の `makeMctsWithWeights`）があるため、global API は段階的に deprecated 化できる。

**案**: 全 AI 呼び出しで `options.weights` 明示を徹底し、bench は decider クロージャに重みを閉じ込める。`STRATEGIES` も immutable に保ち、`playOneGame` に `deciderOverrides` を渡す or `getDecider(name, opts)` ファクトリへ。

**工数**: 中
**優先度**: 低

### 34. IS-MCTS フレームワークが 3 実装に重複（train/inference 整合性リスク）

**問題**: `src/ai/mctsAI.ts`(447 行)、`ai/scripts/nn/neuralMcts.ts`(433 行)、そして新規の `src/ai/neuralAI.ts`(367 行) が `NodeStats`(`mctsAI:53` / `neuralMcts:56` / `neuralAI:109`) / `getOrCreateNode`(`mctsAI:329` / `neuralMcts:221` / `neuralAI:258`) / `puctSelect`(`mctsAI:171` / `neuralMcts:137` / `neuralAI:187`) / selection→expansion→backprop ループ / root 最多訪問選択がほぼ同一構造。`neuralMcts.ts:4` と `neuralAI.ts:4,95,224` のコメントでも「同じ IS-MCTS フレームワーク」と明記されている。差分はリーフ評価（evaluator prior / NN バッチ predict / NN 単発 predict）と prior 算出のみ。
特に `neuralMcts`（学習側）と `neuralAI`（ブラウザ推論側）は**同一であるべき**だが、すでに seed 導出が乖離している（項目 22）。学習時と推論時の探索が食い違うと、学習した policy/value がブラウザで正しく転移しない AlphaZero 特有の不整合を生む。

**案**: tfjs 非依存部分を `src/ai/mctsCore.ts` に抽出し、selection / backprop / node 管理を共通化。`mctsAI` は evaluator prior を注入、`neuralMcts` は NN batch predict を注入、`neuralAI` は NN 単発 predict を注入する。`@tensorflow/tfjs-node` は引き続き `ai/scripts/` のみで、`@tensorflow/tfjs`（ブラウザ）は `neuralAI` のみで import。

**工数**: 大
**優先度**: 低 （→ 項目 19〜23 後の長期目標。ただし NN を実際にブラウザ配信する段階では train/inference 整合性のため優先度が上がる）

---

## パフォーマンス（低優先・実害軽微）

### 35. React の `state` 全体依存 useMemo が毎レンダー再計算

**問題**: `src/App.tsx:36-39` の `interactiveSlotIndices` useMemo は依存配列が `[state, you]`。`state` は reducer で毎 dispatch ごとに新参照になるため実質メモ化が効かず毎レンダー再計算。`useBoardLayout.ts:129` の `globalMaxStack`(`[state.players]` 依存) や `App.tsx:46` の `cardsToPlace = placeableCards(state)`（毎回新配列）→ `usePlacementSelection` の effect 連鎖（`:16-24`）も同種。ただし計算は軽量で実害は限定的。

**案**: 依存を `[state.phase, state.players[you], state.turn, you]` 等に絞るか selector をメモ化。低優先。

**工数**: 極小〜小
**優先度**: 低

---

## ドキュメント陳腐化

### 36. `useBoardLayout.ts` のギフト配布数コメントが古い

**問題**: `src/hooks/useBoardLayout.ts:35-37` のコメントは「gift-bar は 3 列 × 2 行（最大 6 個）を前提とし、2 行で約 162px」とあるが、`40173c4` で `GiftBar.tsx:13-14`（実体は `:31`）が `max(3, ceil(N/2))` の動的列に変更され、配布数 7 以上で列が増える。

**案**: コメントを動的列前提に書き換える。`MIN_ACTION_HEIGHT = 220`(`:40`) の妥当性が変わるなら別途見直し。

**工数**: 極小
**優先度**: 低

---

## まとめテーブル

| # | 項目 | カテゴリ | 工数 | 優先度 | 備考 |
|---|------|----------|------|--------|------|
| 1 | 「取り除き」ボタンの空スロットガード | 実質バグ | 極小 | 高 | 単独で実施可 |
| 2 | randomAI の空山札ドロー | 実質バグ | 極小 | 高 | 単独で実施可 |
| 3 | evaluateState 得点二重計上 | 実質バグ | 小〜中 | 中 | 修正＝再チューニング要 |
| 4 | evaluateUnknownDraw 山札空 | 実質バグ | 小 | 中 | 単独 |
| 5 | プレゼント UI のカード選択 | 機能欠落 | 小〜中 | 中 | docs/RULES.md 準拠 |
| 6 | smartAI tie-break ?? top 削除 | 過剰防御 | 極小 | 中 | 単独 |
| 7 | evaluateState 終局分岐の呼出元依存 | 過剰防御 | 小 | 中 | 単独 |
| 8 | stepGame safety<16 の定数化＋warn | 過剰防御 | 極小 | 中 | 単独 |
| 9 | legalActionMask 削除 | デッドコード | 極小 | 中 | 単独 |
| 10 | getEncodingShape/EncodingShape 削除 | デッドコード | 極小 | 中 | → 31 と方針統一 |
| 11 | Phase 'turnEnd' 削除 | デッドコード | 極小 | 中 | モデル非互換注意（ブラウザ load も） |
| 12 | delayFor 削除 | デッドコード | 極小 | 低 | 単独 |
| 13 | CLI 数値引数の NaN 検証 | エラー処理 | 小 | 中 | 単独 |
| 14 | COLOR_LABEL 統合＋型安全 | 重複排除 | 極小 | 中 | 単独 |
| 15 | アニメーション 700ms 統合 | 重複排除 | 極小 | 中 | 単独 |
| 16 | DEFAULT_MAX_STEPS help 修正 | ドキュメント | 極小 | 中 | 単独 |
| 17 | reducer oldCardIds 抽出 | 重複排除 | 極小 | 低 | 単独 |
| 18 | wilsonInterval＋期待順位 統合 | 重複排除 | 極小 | 低 | 単独 |
| 19 | currentActorId → game コア（8 箇所） | 共通 util | 中 | 高 | 20–23 と同時着手 |
| 20 | computeRanking / computeWinner（7 箇所） | 共通 util | 中 | 高 | → 21 と同時 |
| 21 | rankToValue 統合（4 箇所） | 共通 util | 小 | 中 | → 20 と同時 |
| 22 | stateBaseSeed → ai/seed.ts（5 箇所・式乖離） | 共通 util | 小〜中 | 中 | 単独可 |
| 23 | nonEmptySlotIndices 共有 | 共通 util | 小 | 中 | 単独 |
| 24 | Float32 pack/unpack 統合 | 重複排除 | 小 | 中 | 単独 |
| 25 | catch silent の整理 | 防御コード | 小 | 中 | 単独 |
| 26 | silent break の原因記録 | エラー処理 | 小 | 中 | 単独 |
| 27 | smartAI 合法手を actionSpace に統一 | 構造 | 小〜中 | 中 | 単独可 |
| 28 | dataset 2 関数の統合 | 重複排除 | 中 | 中 | → 19–23 の後 |
| 29 | 対戦ループ統合 | 重複排除 | 中 | 中 | → 19–20 の後 |
| 30 | nnPredict(Batch) 型キャスト検証（2 箇所） | 型安全 | 小 | 中 | 単独 |
| 31 | NUM_PLAYERS/スロット数 assert・集約 | 型安全 | 極小〜中 | 中 | 10 と方針統一 |
| 32 | NN-MCTS cut 時 backup の見直し | AI 品質 | 小〜中 | 低 | 学習に影響・neuralAI と揃える |
| 33 | evaluator/_runner global state 撤去 | 構造 | 中 | 低 | 単独可 |
| 34 | mctsCore 抽出（3 実装） | 構造 | 大 | 低 | → 19–23 の後・配信時に昇格 |
| 35 | React state 全体依存の再計算 | パフォーマンス | 極小〜小 | 低 | 実害軽微 |
| 36 | useBoardLayout コメント更新 | ドキュメント | 極小 | 低 | 単独 |

**着手の目安**: 1 → 2 を最優先で。6〜18（極小工数の過剰防御・デッド・定数整合）を 1 PR で片付け、19〜24（共通 util、neuralAI も巻き込む）を 1 PR、27・28・29（合法手・dataset・対戦ループ）を別 PR、3（二重計上）は計測＋再チューニング前提で慎重に、34（mctsCore、現在 3 実装）は長期。NN をブラウザに実配信する判断が出たら 22・32・34（train/inference 整合性）の優先度を上げる。

---

## 不採用とした指摘の記録

発見フェーズで挙がったが、精査の結果項目化しないもの（再提起防止のため記録）。
位置情報は現行の作業ツリー（`0178861` + 未コミットのブラウザ NN 統合）に合わせて検証済み。

- **`usePlacementSelection` の useEffect 依存配列（`src/hooks/usePlacementSelection.ts:16-24`）から `selectedCardId` を外す**：誤り。外すと `length === 0` 分岐内で stale closure 化する。実体は「`placeableCards` が毎レンダー新配列を返すため effect が毎回走るが、ガードで setState されず無害」（`src/game/selectors.ts:71-73`）。配置選択ロジックは既に `usePlacementSelection` に隔離済み。
- **`key={idx}`（`src/components/PlayerBoardView.tsx:42` / `src/components/LogPanel.tsx:26`）**：問題なし。スロットは固定 5 枚・順序不変、ログは追記のみ。スタック内のフェードは `src/components/SlotView.tsx:154` / `:170` で `card.id` を key にしている。
- **`useBoardLayout` の `calcDims()` 二重呼び出し（`src/hooks/useBoardLayout.ts:121-124`）**：マウント後に寸法を確定させる意図的な呼び出しで実害なし。
- **`giftTargets[i]!` の non-null 断言（`src/App.tsx:102`）**：`allGiftTargetsReady`（`:94-95`）でガード済み。`if (!allGiftTargetsReady) return`（`:98`）で早期 return しているため安全。
  ※ 「コンボ内のどのカードを渡すか UI で選べない」点は別問題として **項目 5** で扱う。
- **`handleSlotClick` のクロージャ陳腐化（`src/App.tsx:49-53`）**：`useCallback` でラップされず毎レンダー再生成されるため、常に最新の `selectedCard`（`usePlacementSelection` 由来）を見る。非問題。
- **`evaluateState` の `pendingMult` 二重計上を「無害な仕様」として放置**：誤り。当ターンの combo がギフトフェーズで二重加点される実バグ。**項目 3** で扱う。
- **`next.players[player.id]` / `next.players[batch.recipientId]` に null ガードを追加（`src/game/reducer.ts:76-78` / `:366-368`）**：不採用。`player.id` はプレイヤー列挙由来、`batch.recipientId` は配布バッチ生成時に検証済みで、いずれも `players` 配列の正当な index。「ありえない index」に黙って `return state` する防御は、むしろ CLAUDE.md が禁じる「デフォルト値での握りつぶし」にあたり、バグを隠す。なお `:367` の `COLOR_LABEL[c.color]` 参照は **項目 14**（COLOR_LABEL 統合）で型安全化される対象。
- **`actionSpace.ts` の `DISCARD_TOP` にスロット index 上限チェックを追加（`src/ai/actionSpace.ts:103-108`）**：不採用。`slotIndex` は `id < ID_DISCARD_TOP_BASE + NUM_SLOTS` で上限管理され、`state.players[actorId]?.board.slots[slotIndex]` の結果を `if (!slot || slot.stack.length === 0) return null` で弾いている。範囲外は `undefined` となり `!slot` で捕捉済みのため、追加ガードは冗長。
