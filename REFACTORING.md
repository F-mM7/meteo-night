# リファクタリング方針

## 現状分析

- **規模**: `src/` 44 ファイル（`.ts`/`.tsx`、うちテスト 4、**4,742 行**）、`ai/scripts/` 22 ファイル（`.ts`、**5,094 行**）。未追跡（未コミット）は joint 2D grid の `grid-joint-uct-eval.ts`・`grid-joint-uct-iter.ts`（各 323 行）と、開発用補助スクリプト `_profile-gpu-vs-cpu.ts`・`_profile-nn-selfplay.ts`・`_save-untrained-hybrid.ts`・`_verify-search.ts`。
- **最大ファイル**: `ai/scripts/nn/neuralMcts.ts`(**822**), `src/game/reducer.ts`(516), `ai/scripts/nn/dataset.ts`(**499**), `src/ai/mctsAI.ts`(**467**), `src/ai/neuralAI.ts`(367), `ai/scripts/nn/train.ts`(342), `ai/scripts/tune-es.ts`(332), `ai/scripts/grid-joint-uct-eval.ts`(323), `ai/scripts/grid-joint-uct-iter.ts`(323), `ai/scripts/grid-uct.ts`(293)
- **構成**: UI(`src/components` + `src/hooks` + `src/App.tsx`) / ゲーム(`src/game`) / AI(`src/ai`、ブラウザ用) / 学習基盤(`ai/scripts`、Node 用)
- **直近の動き**: `ad795aa`（**コミット済み**）で旧番号体系の極小バッチを実装：`COLOR_LABEL` を `src/game/labels.ts`、ベンチ集計を `ai/scripts/stats.ts` に集約、CLI 数値引数の `parseIntArg`/`parseFloatArg` 検証、`stepGame` 連鎖上限の `MAX_CHAIN_RESOLVE_STEPS` 定数化、デッドエクスポート（`legalActionMask`/`getEncodingShape`）削除、700ms 定数集約 等。**これは旧番号「1・2・6〜18」であり、下記の現行項目 6〜11 の共通化（`currentActorId`/`computeRanking`/`stateBaseSeed` 等の集約）とは別物。現行項目はいずれも未着手（17・18・20 のみ部分着手）。**
  その後、探索ハイパラを grid search で最適化：**Gen-3-O で `DEFAULT_UCT_C=1.7` / `DEFAULT_ITERATIONS=800` に更新しブラウザ反映（vs smart 93.5%、`src/ai/mctsAI.ts:35` 他）**。Gen-3-M(leafEvalScale)/N(iter)/P(joint)/Q(21 次元 ES) は不採用。NN 側は parallel self-play（K11、後に K12 で不要と判明）と mcts-batch=iterations（K12、1.5x）を実装し、`neuralMcts.ts` が 433→**822 行**、`dataset.ts` が 307→**499 行** に増加（未コミット）。grid search スクリプトは `grid-uct`/`grid-eval-scale`/`grid-iter`/`grid-joint-uct-eval`/`grid-joint-uct-iter` の **5 本** に増殖し、対戦ループ・`currentActorId`・`computeRanking` を各自コピーしている。

主要な負債は **「ゲーム / AI / 学習スクリプトの三層に同一ロジックがコピーされている」** こと（`currentActorId` **15 箇所**、`computeRanking` **11 箇所**、対戦ループ **8 実装**、silent break **9 ファイル 18 行** に増殖。grid 5 本の追加が箇所数を押し上げた）。IS-MCTS フレームワークは mctsAI / neuralMcts / neuralAI の **3 実装** に加え、`neuralMcts.ts` 内部で sequential/parallel の **2 系統** に二重化（822 行の主因＝項目 21）、seed 導出はブラウザ版 `neuralAI` が式まで乖離（項目 9）。さらに **NN 学習パイプラインの実質バグ**（並列 self-play の hybrid 非対応＝項目 3、未終局局面を value target 化＝項目 4）、**プレゼント UI のカード選択欠落**（項目 5）、**評価関数 `evaluateState` の得点二重計上窓**（項目 1）。

---

## 実質的なバグ・機能欠落（最優先）

### 1. `evaluateState` がギフトフェーズで当該ターンの得点を二重計上する

**問題**: `src/game/reducer.ts:113-143` の `finalizeTurnAfterCombos` は当ターンの combo 得点を `player.score` に加算して**確定**したあと、`turn.combosThisTurn` を**クリアせずに** `giftQueue` へコピーし、`awaitingGiftSelection` へ遷移する。`combosThisTurn` が空になるのは `endTurn`（`:167`）。一方 `src/ai/evaluator.ts:225-227` は `state.currentPlayerIndex === playerId` のとき `totalScoreForTurn(state.turn.combosThisTurn).total * pendingMult` を加点する。このため `awaitingGiftSelection` / `awaitingGiftPlacement` フェーズの状態を評価すると、`me.score`（既に combo 分を含む）に pending 分（同じ combo）が**二重加算**される。`smartAI` / `mctsAI` がこれらフェーズの `nextState` を `evaluateState` する経路で発生する。

**案**: (a) `finalizeTurnAfterCombos` で `combosThisTurn` をクリアする（pending は `giftQueue` で持つ）、または (b) `evaluateState` の pending 加点を得点未反映フェーズ（`resolvingCombos` 等）に限定する。**現挙動で重みが学習・チューニング済みのため、修正時は再チューニング（tune-es / NN 再学習）が必須**。先に二重計上の影響度を計測してから着手するのが安全。

**工数**: 小〜中（修正自体は小、再チューニング込みで中）
**優先度**: 中（AI 評価の歪みだが、現状は学習が適応しており即時破綻はしない）

### 2. `smartAI.evaluateUnknownDraw` が山札枯渇時にサンプリング無効・無駄ループ

**問題**: `src/ai/smartAI.ts:116-133` は `DRAW_FROM_DECK` / `CHOOSE_ADDITIONAL_DRAW` の期待値を 4 サンプルで推定するため `shuffle(state.deck, rand)`（`:127`）で山札順を変えてから `stepGame` する。だが**山札が空（`state.deck.length === 0`）で捨札にカードがある**場合、`shuffle([])` は空配列を返し、実際のドローは `engine` 側の `reshuffleDiscardIntoDeck`（固定 seed、`engine.ts:42-46`）で決まる。結果、4 サンプルすべてが**同一状態**になり、`for` ループは無駄に 4 回同じ計算を繰り返す（分散推定にならない）。終盤の山札枯渇時に「引く」手の評価が決定論的に偏る。

**案**: `state.deck.length === 0 && state.discardPile.length > 0` のときは捨札もシャッフル対象に含めて determinize するか、サンプル数を 1 に落として無駄ループを省く。

**工数**: 極小
**優先度**: 中

### 3. NN 並列 self-play が hybrid / policy-only モードを黙って無視する

**問題**: `ai/scripts/nn/train.ts:264-283` は `--parallel-games >= 2` のとき `generateDatasetParallel`（`dataset.ts:414`）を呼ぶが、`--hybrid` フラグ（`args.hybrid`）を渡していない（`:273` に「parallel 経路はまだ hybrid 未対応」とコメント）。並列経路の leaf 評価 `neuralMcts.ts:807-822` は `nnPredictBatch` の NN value をそのまま backprop し、sequential 版（`:452-459`）にある `useHeuristicValue` / `model.valueSize === 0`（policy-only）時の `evaluateLeafHeuristic` 分岐を持たない。このため `--parallel-games N --hybrid` を同時指定すると hybrid が黙って無効化され、policy-only モデル（`valueSize=0`）を並列で回すと NN value 出力（空〜不定）を value target に使い、**silent に誤学習**する。CLAUDE.md が禁じる「暗黙のフォールバック」にあたる。

**案**: 最低限、`parallelGames >= 2 && (hybrid || model.valueSize === 0)` で throw して誤用を即座に検出する（極小）。本対応は並列経路にも heuristic leaf 分岐を実装する（小〜中）。

**工数**: 極小（throw でガード）／ 小〜中（並列 hybrid 対応）
**優先度**: 中（現状 parallel は K12 で不要と判明し未使用だが、誤用で黙って壊れる）

### 4. 自己対戦データ生成が未終局局面を value target に含める

**問題**: `dataset.ts` の `generateSelfPlayGame`（`:152-176`）と並列版 `finalizeSlot`（`:371-398`）は、`!action`（`:163`）・`state === before`（`:174`）・`steps >= maxSteps`（`:367`、`maxSteps=20000`）で打ち切った場合も、`state.phase === 'gameOver'` か否かを**区別せず** `computeRanking(state)`（`:178` / `:377`）で順位を確定し、全 pending step に `valueTarget` として付与する。未終局の中途状態の順位（最終結果ではない）を教師信号にするため、異常終了局が混ざると AlphaZero の value head 学習を汚染する。`_runner.ts` は `finished` フラグを持つが dataset 側は未使用。

**案**: 打ち切り（非 `gameOver`）の局は value target を生成せず除外する、または `finished: false` フラグで loss から外す。`applyActionToSlot`（`:355-368`）で done 理由（`gameOver` / `abort`）を記録する（項目 13 と同時着手）。

**工数**: 小
**優先度**: 中

### 5. プレゼント UI が各コンボの「渡すカード」を常に先頭固定

**問題**: `docs/RULES.md:117-120` では「各コンボから1枚を**選んで**渡す」と仕様化されているが、`src/components/GiftBar.tsx:37` は `const card = combo.cards[0]` を表示し、`src/App.tsx:103,116` も `cardId: combo.cards[0].id` を送る。`reducer` の `validateAssignments`(`reducer.ts:306`) は任意の `combo.cards.find` を受け付ける設計なので、UI が機能を提供していない欠落。3 枚以上の同色コンボでも、現状はユーザーが渡すカードを選べない（同色だが ID は別物なのでゲーム上の影響は限定的だが、ルール準拠と「将来 NN ヘッドを差し替えるとき」の整合性として要修正）。`GiftBar.tsx:13-14` の動的列化は実装済みだが、カード選択 UI は未実装。

**案**: `GiftBar` の行ごとに「コンボ内のどのカードを渡すか」の選択 state を持たせ、`handleConfirmGifts` で選択 ID を `assignments` に反映する。

**工数**: 小〜中
**優先度**: 中（同色なら効果は同等のため、ルール表現の問題として中）

---

## ゲーム / AI 層の共通ユーティリティ集約

> 以下 6–11 は密接に関連する重複群。`src/game/actors.ts`（または `selectors.ts` 拡張）と `src/game/ranking.ts`、`src/ai/seed.ts` を整備して一気に整理するのが効率的。ブラウザ NN 統合の `src/ai/neuralAI.ts`、grid search 5 本も同じロジックを再コピーしているため、集約の対象に含める。

### 6. `currentActorId` が 15 箇所で同一定義

**問題**: 贈与配置中は `pendingGiftBatches[0].recipientId` を返し、それ以外は `state.currentPlayerIndex` を返すロジックが以下の **15 箇所**にコピーされている（旧 11 箇所から grid 系・tune-es・_profile 追加で増加）。

- `src/hooks/useGameLogic.ts:19`（export・UI/AI 共通の正）
- `src/ai/mctsAI.ts:82`
- `src/ai/neuralAI.ts:118`
- `ai/scripts/_runner.ts:76`
- `ai/scripts/nn/neuralMcts.ts:115`
- `ai/scripts/nn/dataset.ts:37`
- `ai/scripts/tune-es.ts:61`
- `ai/scripts/bench-neural.ts:38`
- `ai/scripts/grid-uct.ts:131`
- `ai/scripts/grid-eval-scale.ts:128`
- `ai/scripts/grid-iter.ts:128`
- `ai/scripts/grid-joint-uct-eval.ts:141`
- `ai/scripts/grid-joint-uct-iter.ts:140`
- `ai/scripts/_profile-hotpath.ts:25`
- `ai/scripts/_profile-nn-selfplay.ts:34`

本来はゲームドメインの責務だが共通の置き場所が無く、ルール変更時の同期漏れリスクが高い。

**案**: ゲームコア（`src/game/selectors.ts` か新設 `src/game/actors.ts`）に `export function currentActorId(state: GameState): number` を置き、UI・AI・全 Node スクリプトを import に置換。`useGameLogic.ts` の re-export を後方互換のため一時的に残す（`App.tsx` が import している）。

**工数**: 中
**優先度**: 高

### 7. `computeRanking` が 11 箇所に重複、`computeWinner` も同じ tie-break を再実装

**問題**: 得点降順＋同点時は `startPlayerIndex` からの距離で順位付けする同一アルゴリズムが以下の **11 箇所**に存在（旧 9 から grid 系 +2）。

- `src/ai/mctsAI.ts:92`
- `src/ai/neuralAI.ts:132`
- `ai/scripts/_runner.ts:86`
- `ai/scripts/nn/neuralMcts.ts:129`
- `ai/scripts/nn/dataset.ts:52`
- `ai/scripts/bench-neural.ts:48`
- `ai/scripts/grid-uct.ts:116`
- `ai/scripts/grid-eval-scale.ts:113`
- `ai/scripts/grid-iter.ts:113`
- `ai/scripts/grid-joint-uct-eval.ts:126`
- `ai/scripts/grid-joint-uct-iter.ts:125`
- `ai/scripts/tune-es.ts:102-107`（`computeRanking` 関数を持たず、`ordered.findIndex((p) => p.id === 0)` の同一ソートを**インライン展開**）
- `src/game/engine.ts:135-144`(`computeWinner` も同じ sort 比較子)

**案**: `src/game/ranking.ts` に `computeRanking(state): number[]`（`ranking[playerId] = 0..n-1`）を置き、`computeWinner` を `computeRanking` の先頭から導出するように `engine.ts` も再構成。tune-es のインライン版も共通呼び出しに置換。

**工数**: 中
**優先度**: 高（→ 項目 8 と同時着手）

### 8. `rankToValue` が 4 箇所に重複

**問題**: `1 - 2*rank/(numPlayers-1)` で順位を [-1, +1] にマップする式が `src/ai/mctsAI.ts:111`、`src/ai/neuralAI.ts:128`、`ai/scripts/nn/neuralMcts.ts:125`、`ai/scripts/nn/dataset.ts:47` の 4 箇所にある。4 箇所とも `numPlayers <= 1` をガード済みで、差は `if` 文か三項演算子かの記法だけ（実質完全同一）。

**案**: 項目 7 の `src/game/ranking.ts` に同居させる。

**工数**: 極小
**優先度**: 中（→ 項目 7 と同時着手）

### 9. `stateBaseSeed` が 4 箇所に重複＋ブラウザ版が式まで乖離

**問題**: `rngSeed / turnNumber / playerId / log.length` から決定論的 seed を生成する処理が `src/ai/mctsAI.ts:116`、`src/ai/smartAI.ts:21`、`src/ai/randomAI.ts:4`、`ai/scripts/nn/neuralMcts.ts:144` の 4 箇所にある（いずれも `Math.imul(turnNumber+1, 0x9e3779b1)` 等で混合する同一実装）。
さらに、ブラウザ NN 統合の `src/ai/neuralAI.ts:255-256` は同じ 4 入力から seed を作るが、**式が異なる**（`rngSeed ^ (turnNumber*7919) ^ (playerId*13) ^ log.length`、`Math.imul` を使わない弱い混合）。`neuralAI` は `neuralMcts` の移植のはずだが seed 導出が既に乖離しており、共通化していれば起きなかった不整合。学習側と推論側で探索のランダム化が食い違う遠因にもなる（→ 項目 21）。

**案**: `src/ai/seed.ts` に `stateBaseSeed` を集約し、neuralAI も含め全 5 箇所を置換。これで式の乖離も解消する。

**工数**: 小〜中
**優先度**: 中

### 10. 非空スロット index 列挙ロジックの重複（`nonEmptySlotIndices` 非 export）

**問題**: `src/game/selectors.ts:25-31` の `nonEmptySlotIndices` が**非 export** のため AI から再利用できず、`src/ai/randomAI.ts:75-77` がインライン再実装している。なお `src/ai/smartAI.ts` は全スロット列挙（`:31`）＋ discard 時 filter（`:80-81`）に変化し、`src/ai/actionSpace.ts:106-107` は `DISCARD_TOP` の slot/stack チェック（別用途）。純粋な「非空スロット列挙」の重複は selectors（非 export）と randomAI の **2 箇所**。

**案**: `selectors.ts` の `nonEmptySlotIndices` を export し、randomAI から共通呼び出しに統一する。

**工数**: 極小
**優先度**: 中

### 11. `Float32Array[]` の 2 次元 pack/unpack が 2 箇所に手書き重複

**問題**: 「`Float32Array[]` を `[n, size]` の flat バッファに `buf.set(vecs[i], i*size)` で詰める／逆に `subarray` で切り出す」パターンが `ai/scripts/nn/train.ts:198-218`(`examplesToTensors` の入力詰め込み) と `ai/scripts/nn/neuralMcts.ts:153-169`(`nnPredictBatch` の出力切り出し) で重複。両者は逆操作の対。

**案**: `packFloat2D(vecs): {buf, n, size}` / `unpackFloat2D(flat, n)` ヘルパに集約。

**工数**: 小
**優先度**: 中

---

## エラーハンドリング・防御コードの整理

### 12. `catch { score = -Infinity }` / `catch { continue }` が例外を握りつぶす

**問題**:

- `src/ai/smartAI.ts:167-168`：合法手のはずの `stepGame` が throw したら `-Infinity` 扱い。
- `src/ai/mctsAI.ts:229-230`(`computePriors` 内)：throw したら prior をスキップして次へ。

正常系では到達しないはずの状態を黙って隠すため、bug の発見が遅れる。実際 `stepGame` は throw しない設計（`reducer` は state を返す）なので、catch 自体が過剰防御の可能性が高い。

**案**: 開発時は `console.warn` + 状態スナップショットを出し、本番は `try/catch` を撤廃するか、限定例外型のみ捕捉する。

**工数**: 小
**優先度**: 中

### 13. シミュレーション打ち切り時の silent break（9 ファイル 18 行）

**問題**: `!action` または `state === before` のとき `break` するが、原因（phase / actor / action type）を記録しない箇所が **9 ファイル 18 行**（旧 6 ファイル 12 行から grid 系 +3 ファイル）。

- `_runner.ts:130,135`
- `tune-es.ts:95,98`
- `bench-neural.ts:93,96`
- `dataset.ts:163,174`(`generateSelfPlayGame`) / `dataset.ts:244,254`(`generateSelfPlayGameWithModel`)
- `grid-uct.ts:174,177`
- `grid-eval-scale.ts:171,174`
- `grid-iter.ts:171,174`
- `grid-joint-uct-eval.ts:193,196`
- `grid-joint-uct-iter.ts:192,195`

`finished: false` の局が混ざっても何が起きたか追えない（項目 4 の value target 汚染に直結）。

**案**: 戻り値に `abortReason?: 'no_action' | 'stale_step'` を含め、`--silent` 以外では 1 行 warn を出す。dataset 生成では abort 局を学習データから除外（項目 4）。

**工数**: 小〜中
**優先度**: 中

---

## AI 層の構造的改善

### 14. `smartAI.enumerateActions` と `actionSpace` が合法手を二重管理

**問題**: MCTS / NN-MCTS / 学習データ生成は `actionSpace.legalActionIds + actionIdToAction` を使うが、`smartAI` は独自の `enumerateActions`(`smartAI.ts:29-89`) を持つ。フェーズ追加や合法条件変更時に 2 系統の同期が必要。例: `awaitingPlaceDrawn` で smartAI は `pendingDraw[0]` のみ列挙(`:57-64`)、actionSpace は `[0]`(`:84-89`) と `[1]`(`:90-95`) 両方を扱う、という挙動差もある。

**案**: smartAI を `legalActionIds(state, playerId).map(id => actionIdToAction(...)).filter(Boolean)` に書き換える。`CONFIRM_GIFTS` のみ actionSpace 外（`actionSpace.ts:21-22`）なので別経路を残す。

**工数**: 中
**優先度**: 中

### 15. `dataset.ts` の自己対戦生成が 3 系統にコピペ増殖

**問題**: `ai/scripts/nn/dataset.ts:131-201`(`generateSelfPlayGame`、mctsAI 用) と `:207-275`(`generateSelfPlayGameWithModel`、neuralMcts 用) が ~90% 同一だったところに、Gen-3-K11 で `finalizeSlot`(`:371-398`) + `generateDatasetParallel`(`:414-499`) の並列版が加わり **3 系統**に。pending→ranking→policyTarget の組み立てが各所で重複している（499 行に増加）。

**案**: `collectPendingSteps` + `finalizeExamples(pending, state, tau)` に抽出し、sequential / parallel / mcts / neural を decider 注入の薄いラッパーにする。項目 6〜11 完了後に着手すると差分がさらに減る。

**工数**: 中
**優先度**: 中（→ 項目 6〜11 の後）

### 16. 対戦ループが 8 実装に増殖

**問題**: 骨格（setup → while → currentActor → decider → stepGame → break）が同一の対戦ループが **8 実装**（旧 5 から grid 系 +3）。

- `_runner.ts:109`(`playOneGame`、汎用)
- `tune-es.ts:76`(`playOne`、mcts vs 固定相手)
- `bench-neural.ts:63`(`playOne`、neural seat 固定)
- `grid-uct.ts:154`(`playGame`)
- `grid-eval-scale.ts:151`(`playGame`)
- `grid-iter.ts:151`(`playGame`)
- `grid-joint-uct-eval.ts:168`(`playGame`)
- `grid-joint-uct-iter.ts:167`(`playGame`)

grid 系は `maxSteps = 20000` をインライン直書きして `DEFAULT_MAX_STEPS`(`_runner.ts:107`) 定数を共有せず、未完局の warn も無い。さらに `rotate<T>` も `_runner.rotateSeats`(`:252-255`) と同一実装が grid 5 本にコピーされている。

**案**: `_runner.ts` に `playOneGameWithDeciders(deciders: Decider[], options)` を追加し、tune-es / bench-neural / grid-* から委譲。席固定・重み注入は decider ファクトリで表現する。`rotateSeats` も import に統一。

**工数**: 中
**優先度**: 中（→ 項目 6〜7 の後）

### 17. `nnPredictBatch` / `nnPredict` の `as` キャストが出力構造に無検証依存（部分着手）

**問題**: ブラウザ版 `src/ai/neuralAI.ts:177-179` は `predict(input) as tf.Tensor[]`、`out[0]` / `out[1].dataSync() as Float32Array` の二重 `as` キャストのまま。学習側 `ai/scripts/nn/neuralMcts.ts:153-169` は `Array.isArray(rawOut)` 分岐が追加され部分的に改善済みだが、`ai/scripts/nn/model.ts:184` の `loadModel` は出力テンソルの shape を読まず `valueSize = VALUE_HEAD_SIZE`（4）固定。`predict` が単一 Tensor を返す構成（出力 1 つ）に変わると `out[1]` が `undefined` で実行時例外、`dataSync()` の dtype が float32 でないとキャストが嘘になりうる。モデル構造（policy + value の 2 出力）への暗黙依存が型に守られていない。

**案**: ロード時に `net.outputs[i].shape` を検証し、`ACTION_SPACE_SIZE` / `VALUE_HEAD_SIZE` 不一致なら throw するヘルパに括り出し、neuralAI / neuralMcts 両方から使う。

**工数**: 小
**優先度**: 中

### 18. NN 入出力次元のプレイヤー数・スロット数・評価スケールのハードコード（部分着手）

**問題**: デッドエクスポート `legalActionMask` / `getEncodingShape` は `ad795aa` で削除済み。残る固定値: `src/ai/encoding.ts:5-6`(`SLOTS_PER_BOARD=5` / `NUM_PLAYERS=4`)、`ai/scripts/nn/model.ts:24`(`VALUE_HEAD_SIZE=4`)・`:184`(loadModel が shape を読まず 4 固定)、`src/ai/actionSpace.ts:26`(`NUM_SLOTS=5`)、`src/game/setup.ts:12`(`DEFAULT_SLOTS=5`)。4 人以外で `encodeState` / 学習を動かすとサイズ不整合がサイレントに進む（ブラウザ推論 `neuralAI.ts:298` も `encodeState` を呼ぶ）。AI ヒューリスティック（`smartAI.ts:91-113` の `buildGiftAssignmentsHeuristic`、`randomAI.ts:82-90`）も人数 < 2 で例外 / `undefined` 混入。加えて leaf 評価スケール `DEFAULT_LEAF_EVAL_SCALE = 1500` が `mctsAI.ts:39` と `neuralMcts.ts:69` に同値で二重定義されている。

**案**: 現状 4 人固定なので `setupGame` 時に `assert(players.length === 4)` を入れる（極小、空 `opponents` 経路も塞げる）。スロット数定数と `leafEvalScale` を 1 箇所に集約。本気で可変化するなら shape API を `numPlayers` 引数付きで再設計（中工数）。

**工数**: 極小（assert + 定数集約）／ 中（可変化まで）
**優先度**: 中

### 19. NN-MCTS の探索打ち切り path に全員価値 0 を backup

**問題**: `ai/scripts/nn/neuralMcts.ts:319-320`(`zeroValueVec()`) を depth cut / 非法 action / `stepGame` 不変(`:338, 355, 359, 361`) で backup している。同じ「打ち切り時に全員 0 の価値ベクトルを backprop する」挙動はブラウザ版 `src/ai/neuralAI.ts:291, 316, 323`(`new Float32Array(numPlayers)` = 全 0) にもある。深度上限・非法 action 到達時に「中位相当」を一票入れることで木の統計を歪め、AlphaZero 学習データの value target 品質にも影響しうる。

**案**: cut 時は backup しない、または親ノードの cached value を使う。`cut` 発生率を計測ログに出してから方針決定するのが安全。learn 側（neuralMcts）と推論側（neuralAI）で挙動を揃えること（→ 項目 21）。

**工数**: 小〜中
**優先度**: 低

### 20. `evaluator` / `bench` のモジュール global state が並列実行で危うい（部分着手）

**問題**: `src/ai/evaluator.ts:109-112` の `currentWeights` + `setEvalWeights` がプロセス global。AI 単位に閉じる `options.weights` API（`_runner.ts:39` の `makeMctsWithWeights`、`:48` の `makeMctsWithOpts`）が追加され tune-es は移行済みだが、`ai/scripts/bench.ts:93` で `setEvalWeights` により global を書き換え、`:144` で `STRATEGIES.mcts`（`_runner.ts` のエクスポート定数）も破壊的代入している。同一プロセスで複数回ベンチを回す将来のテスト等で前回の weights が残る。

**案**: bench も `makeMctsWithWeights` / `makeMctsWithOpts` に統一し、decider クロージャに重みを閉じ込める。`STRATEGIES` も immutable に保つ。

**工数**: 小
**優先度**: 低

### 21. IS-MCTS フレームワークが 3 実装に重複＋`neuralMcts` 内で 2 系統に二重化（train/inference 整合性リスク）

**問題**: `src/ai/mctsAI.ts`(467 行)、`ai/scripts/nn/neuralMcts.ts`(822 行)、`src/ai/neuralAI.ts`(367 行) が `NodeStats`(`mctsAI:73` / `neuralMcts:95` / `neuralAI:109`) / `getOrCreateNode`(`mctsAI:349` / `neuralMcts:266` / `neuralAI:258`) / `puctSelect`(`mctsAI:191` / `neuralMcts:182` / `neuralAI:187`) / selection→expansion→backprop ループがほぼ同一構造。さらに `neuralMcts.ts` は内部で sequential（`decideActionNeural`、`runSelection` / `installPriors` / `makeRankingValueVec` / `zeroValueVec`）と parallel（`decideActionNeuralParallel`、`ctxRunSelection` / `ctxInstallPriors` / `ctxBackprop` / `ctxZeroValueVec`）の **2 系統**にほぼ同一ロジックを二重化（822 行の主因）。
特に `neuralMcts`（学習側）と `neuralAI`（ブラウザ推論側）は**同一であるべき**だが、すでに seed 導出が乖離している（項目 9）。学習時と推論時の探索が食い違うと、学習した policy/value がブラウザで正しく転移しない AlphaZero 特有の不整合を生む。

**案**: tfjs 非依存部分を `src/ai/mctsCore.ts` に抽出し、selection / backprop / node 管理を共通化。`mctsAI` は evaluator prior を注入、`neuralMcts` は NN batch predict を注入、`neuralAI` は NN 単発 predict を注入する。`neuralMcts` の sequential/parallel も context を引数化して 1 セットに統合する。

**工数**: 大
**優先度**: 低（→ 項目 6〜11 後の長期目標。NN を実際にブラウザ配信する段階では train/inference 整合性のため優先度が上がる）

---

## パフォーマンス（低優先・実害軽微）

### 22. React の `state` 全体依存 useMemo が毎レンダー再計算

**問題**: `src/App.tsx:36-38` の `interactiveSlotIndices` useMemo は依存配列が `[state, you]`。`state` は reducer で毎 dispatch ごとに新参照になるため実質メモ化が効かず毎レンダー再計算。`useBoardLayout.ts:129` の `globalMaxStack`(`[state.players]` 依存) や `App.tsx:46` の `placeableCards(state)`（毎回新配列）も同種。計算は軽量で実害は限定的。

**案**: 依存を `[state.phase, state.turn, state.currentPlayerIndex, you]` 等に絞るか selector をメモ化。

**工数**: 極小〜小
**優先度**: 低

### 23. `encodeState` の `Float32Array.from` がホットパスで多発

**問題**: 各 step / leaf で `Float32Array.from(encodeState(...))` が新規 allocate される箇所が `ai/scripts/nn/dataset.ts:168`、`ai/scripts/nn/neuralMcts.ts:447,809`、`src/ai/neuralAI.ts:298` 等にあり、`_profile-nn-selfplay.ts` で hot path として計測済み。`encodeState` が `number[]` を返すため変換コピーが必須になっている。現状 1 手 ~5.7 ms で実害は軽微。

**案**: `encodeState` が直接 `Float32Array` を返す API にするか、再利用バッファに書き込む形へ変更する。

**工数**: 小
**優先度**: 低

---

## ドキュメント陳腐化

### 24. `train.ts` の先頭コメントが「one-hot 暫定版」のまま

**問題**: `ai/scripts/nn/train.ts:17-19` のコメントは「本骨格は『既存 mcts による自己対戦 → 方策ヘッドを one-hot ターゲットで学習』する暫定版。本格的な AlphaZero ループ（MCTS の visit count を方策ターゲットに、学習済みネットを次の MCTS に反映してデータ生成）は次イテレーションで実装する」とある。実装は `dataset.ts:186` で `visitsToPolicy`（softmax visits）を使い、`--selfplay neural` で学習済みネット誘導の自己改善ループも既に実装済み。コメントが陳腐化している。

**案**: 現行 AlphaZero ループの記述に書き換える。

**工数**: 極小
**優先度**: 低

### 25. `useBoardLayout.ts` のギフト配布数コメントが古い

**問題**: `src/hooks/useBoardLayout.ts:35-37` のコメントは「gift-bar は 3 列 × 2 行（最大 6 個）を前提とし、2 行で約 162px」とあるが、`GiftBar.tsx:13-14`（実体は `:31`）が `max(3, ceil(N/2))` の動的列に変更され、配布数 7 以上で列が増える。

**案**: コメントを動的列前提に書き換える。`MIN_ACTION_HEIGHT = 220`(`:40`) の妥当性が変わるなら別途見直し。

**工数**: 極小
**優先度**: 低

---

## まとめテーブル

| # | 項目 | カテゴリ | 工数 | 優先度 | 備考 |
|---|------|----------|------|--------|------|
| 1 | evaluateState 得点二重計上 | 実質バグ | 小〜中 | 中 | 修正＝再チューニング要 |
| 2 | evaluateUnknownDraw 山札空 | 実質バグ | 極小 | 中 | 単独 |
| 3 | 並列 self-play の hybrid 無視 | 実質バグ | 極小〜中 | 中 | NN 学習の正しさ・暗黙 fallback |
| 4 | 未終局を value target 化 | 実質バグ | 小 | 中 | → 13 と同時 |
| 5 | プレゼント UI のカード選択 | 機能欠落 | 小〜中 | 中 | docs/RULES.md 準拠 |
| 6 | currentActorId → game コア（15 箇所） | 共通 util | 中 | 高 | 7〜11 と同時着手 |
| 7 | computeRanking / computeWinner（11 箇所） | 共通 util | 中 | 高 | → 8 と同時 |
| 8 | rankToValue 統合（4 箇所） | 共通 util | 極小 | 中 | → 7 と同時 |
| 9 | stateBaseSeed → ai/seed.ts（4 箇所＋式乖離） | 共通 util | 小〜中 | 中 | 単独可 |
| 10 | nonEmptySlotIndices export（2 箇所） | 共通 util | 極小 | 中 | 単独 |
| 11 | Float32 pack/unpack 統合 | 重複排除 | 小 | 中 | 単独 |
| 12 | catch silent の整理 | 防御コード | 小 | 中 | 単独 |
| 13 | silent break の原因記録（9 ファイル 18 行） | エラー処理 | 小〜中 | 中 | → 4 と同時 |
| 14 | smartAI 合法手を actionSpace に統一 | 構造 | 中 | 中 | 単独可 |
| 15 | dataset 3 系統の統合 | 重複排除 | 中 | 中 | → 6〜11 の後 |
| 16 | 対戦ループ統合（8 実装） | 重複排除 | 中 | 中 | → 6〜7 の後 |
| 17 | nnPredict(Batch) 型キャスト検証 | 型安全 | 小 | 中 | neuralMcts は部分着手 |
| 18 | NUM_PLAYERS/スロット/leafEvalScale assert・集約 | 型安全 | 極小〜中 | 中 | デッドエクスポート削除済み |
| 19 | NN-MCTS cut 時 backup の見直し | AI 品質 | 小〜中 | 低 | neuralAI と揃える |
| 20 | evaluator/bench global state 撤去 | 構造 | 小 | 低 | options.weights API は追加済み |
| 21 | mctsCore 抽出（3 実装＋内部 2 系統） | 構造 | 大 | 低 | → 6〜11 後・配信時に昇格 |
| 22 | React state 全体依存の再計算 | パフォーマンス | 極小〜小 | 低 | 実害軽微 |
| 23 | encodeState の Float32Array allocate | パフォーマンス | 小 | 低 | プロファイル済み・実害軽微 |
| 24 | train.ts 先頭コメント更新 | ドキュメント | 極小 | 低 | 単独 |
| 25 | useBoardLayout コメント更新 | ドキュメント | 極小 | 低 | 単独 |

**着手の目安**: 1（二重計上）は計測＋再チューニング前提で慎重に。3・4（NN 学習パイプラインの実質バグ）は NN を本格運用する前に潰す（3 は最低限 throw＝極小で誤用を即検出）。4〜11 でなく 6〜11（共通 util、neuralAI / grid 5 本を巻き込む）を 1 PR、14・15・16（合法手・dataset・対戦ループ）を別 PR、21（mctsCore、現在 3 実装＋内部 2 系統）は長期。NN をブラウザに実配信する判断が出たら 9・19・21（train/inference 整合性）の優先度を上げる。

---

## 不採用とした指摘の記録

発見フェーズで挙がったが、精査の結果項目化しないもの（再提起防止のため記録）。

- **NN leaf heuristic のスケールが mctsAI=1500 と neuralMcts で不一致（1000 のまま）**：誤り。`neuralMcts.ts:69` の `DEFAULT_LEAF_EVAL_SCALE` は **1500** で、Gen-3-N で 1000 から 1500 に修正済み（コメント `:63, 74`）。mctsAI と同値で不一致は存在しない。ただし同じ定数が 2 ファイルに二重定義されている点は項目 18（定数集約）で扱う。
- **`neuralAI` のモデルロード失敗が `console.warn` + null 返却のみ**：不採用。`ai/README.md` に「ロード前 / 失敗時は mctsAI にフォールバック」と設計明記された意図的フォールバックで、`console.warn` により追跡可能。CLAUDE.md の「意図的フォールバック」に該当し、握りつぶしではない。
- **学習スクリプトの `@tensorflow/tfjs-node-gpu` ハード依存**：不採用（現状）。開発環境は RTX 4080 + CUDA で確立し、`CUDA_VISIBLE_DEVICES=-1` で CPU 実行する運用（`ai/README.md`）。GPU パッケージ前提は意図的。`_profile-gpu-vs-cpu.ts` が GPU パッケージで CPU 比較する点は軽微な矛盾だが、CPU-only 環境への移植要件が生じるまで保留。
- **`usePlacementSelection` の useEffect 依存配列（`src/hooks/usePlacementSelection.ts:16-24`）から `selectedCardId` を外す**：誤り。外すと `length === 0` 分岐内で stale closure 化する。実体は「`placeableCards` が毎レンダー新配列を返すため effect が毎回走るが、ガードで setState されず無害」（`src/game/selectors.ts:71-73`）。
- **`key={idx}`（`src/components/PlayerBoardView.tsx:42` / `src/components/LogPanel.tsx:26`）**：問題なし。スロットは固定 5 枚・順序不変、ログは追記のみ。スタック内のフェードは `src/components/SlotView.tsx` が `card.id` を key にしている。
- **`useBoardLayout` の `calcDims()` 二重呼び出し**：マウント後に寸法を確定させる意図的な呼び出しで実害なし。
- **`giftTargets[i]!` の non-null 断言（`src/App.tsx`）**：`allGiftTargetsReady` でガード済み。早期 return しているため安全。
  ※ 「コンボ内のどのカードを渡すか UI で選べない」点は別問題として **項目 5** で扱う。
- **`next.players[player.id]` / `next.players[batch.recipientId]` に null ガードを追加**：不採用。`player.id` はプレイヤー列挙由来、`batch.recipientId` は配布バッチ生成時に検証済みで、いずれも `players` 配列の正当な index。「ありえない index」に黙って `return state` する防御は、むしろ CLAUDE.md が禁じる「デフォルト値での握りつぶし」にあたり、バグを隠す。なお `COLOR_LABEL[c.color]` 参照は `src/game/labels.ts` への集約により `Record<Color, string>` 型化され、欠損キーは型エラーで検出される。
- **`actionSpace.ts` の `DISCARD_TOP` にスロット index 上限チェックを追加**：不採用。`slotIndex` は `id < ID_DISCARD_TOP_BASE + NUM_SLOTS` で上限管理され、`state.players[actorId]?.board.slots[slotIndex]` の結果を `if (!slot || slot.stack.length === 0) return null` で弾いている。範囲外は `undefined` となり `!slot` で捕捉済みのため、追加ガードは冗長。
