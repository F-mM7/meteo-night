# リファクタリング方針

## 現状分析

- **規模**: `src/` 44 ファイル（`.ts`/`.tsx`、うちテスト 4、4,624 行）、`ai/scripts/` tracked 13 ファイル（2,793 行）。※未追跡（未コミット）は本バッチ新設の共有モジュール `src/game/labels.ts`・`ai/scripts/stats.ts` と、`ai/scripts/grid-eval-scale.ts`(286 行・Gen-3-M leafEvalScale グリッドサーチ) の 3 つ。ブラウザ NN (`src/ai/neuralAI.ts`)・Gen-3-L の `grid-uct.ts`・補助スクリプト群（`_profile-hotpath.ts`・`nn/_smoke-gpu.ts`・`nn/make-dummy.ts`）は inter-session で committed 済み。
- **最大ファイル**: `src/game/reducer.ts`(516), `src/ai/mctsAI.ts`(456), `ai/scripts/nn/neuralMcts.ts`(433), `src/ai/neuralAI.ts`(367), `ai/scripts/tune-es.ts`(332), `ai/scripts/nn/dataset.ts`(307)
- **構成**: UI(`src/components` + `src/hooks` + `src/App.tsx`) / ゲーム(`src/game`) / AI(`src/ai`、ブラウザ用) / 学習基盤(`ai/scripts`、Node 用)
- **直近の動き**: 極小工数の安全な改善バッチ（旧項目 1・2・6〜18）を実装（未コミット）：`COLOR_LABEL` を `src/game/labels.ts`、ベンチ集計（`wilsonInterval` / 期待順位）を `ai/scripts/stats.ts` に集約、CLI 数値引数を `parseIntArg`/`parseFloatArg` で検証、`stepGame` の連鎖上限を `MAX_CHAIN_RESOLVE_STEPS` 定数化＋warn、デッドエクスポート（`legalActionMask`/`getEncodingShape`）削除、700ms 定数集約 等。AI 側は Gen-3-L で mcts uctC を 2.0 に最適化（committed・ブラウザ反映、vs smart 92.0%）、Gen-3-M で leafEvalScale を grid search したが 1500 がピークで不採用（未コミット `grid-eval-scale.ts`）。
  なお `grid-uct.ts`(Gen-3-L) と `grid-eval-scale.ts`(Gen-3-M) は対戦ループ・`currentActorId`・`computeRanking` を再コピーしており（`wilsonInterval` は `stats.ts` に集約済み）、残る重複項目（4・5・11・14）の箇所数を押し上げている。

主要な負債は **「ゲーム / AI / 学習スクリプトの三層に同一ロジックがコピーされている」** こと（特に IS-MCTS フレームワークは mctsAI / neuralMcts / neuralAI の**3 実装**に増殖し、seed 導出は既に乖離している＝項目 7・19）、**「UI が一部のルール（プレゼントのカード選択）を実装し切れていない」** こと（項目 3）、そして **評価関数 `evaluateState` の得点二重計上窓**（項目 1）。

---

## 実質的なバグ・機能欠落（最優先）

### 1. `evaluateState` がギフトフェーズで当該ターンの得点を二重計上する

**問題**: `src/game/reducer.ts:113-144` の `finalizeTurnAfterCombos` は当ターンの combo 得点を `player.score` に加算して**確定**したあと、`turn.combosThisTurn` を**クリアせずに** `giftQueue` へコピーし（`:140`）、`awaitingGiftSelection` へ遷移する。`combosThisTurn` が空になるのは `endTurn`（`:167`）。
一方 `src/ai/evaluator.ts:155-158` は `state.currentPlayerIndex === playerId` のとき `totalScoreForTurn(state.turn.combosThisTurn).total * pendingMult` を加点する。このため `awaitingGiftSelection` / `awaitingGiftPlacement` フェーズの状態を評価すると、`me.score`（既に combo 分を含む）に加えて pending 分（同じ combo）が**二重加算**される。`smartAI` / `mctsAI` がこれらフェーズの `nextState` を `evaluateState` する経路で発生する。

**案**: `pendingMult` は「得点未確定の pending combo を先取り評価する」意図なので、(a) `finalizeTurnAfterCombos` で `combosThisTurn` をクリアする（pending は `giftQueue` で持つ）、または (b) `evaluateState` の pending 加点を得点未反映フェーズ（`resolvingCombos` 等）に限定する。**現挙動で重みが学習・チューニング済みのため、修正時は再チューニング（tune-es / NN 再学習）が必須**。先に二重計上の影響度を計測してから着手するのが安全。

**工数**: 小〜中（修正自体は小、再チューニング込みで中）
**優先度**: 中（AI 評価の歪みだが、現状は学習が適応しており即時破綻はしない）

### 2. `smartAI.evaluateUnknownDraw` が山札枯渇時にサンプリング無効・無駄ループ

**問題**: `src/ai/smartAI.ts:116-133` は `DRAW_FROM_DECK` / `CHOOSE_ADDITIONAL_DRAW` の期待値を 4 サンプルで推定するため `shuffle(state.deck, rand)`（`:127`）で山札順を変えてから `stepGame` する。だが**山札が空（`state.deck.length === 0`）で捨札にカードがある**場合、`shuffle([])` は空配列を返し、実際のドローは `engine` 側の `reshuffleDiscardIntoDeck`（固定 seed）で決まる。結果、4 サンプルすべてが**同一状態**になり、`for` ループは無駄に 4 回同じ計算を繰り返す（分散推定にならない）。終盤の山札枯渇時に「引く」手の評価が決定論的に偏る。

**案**: `state.deck.length === 0 && state.discardPile.length > 0` のときは捨札もシャッフル対象に含めて determinize するか、サンプル数を 1 に落として無駄ループを省く。

**工数**: 小
**優先度**: 中

### 3. プレゼント UI が各コンボの「渡すカード」を常に先頭固定

**問題**: `docs/RULES.md:117-120` では「各コンボから1枚を**選んで**渡す」と仕様化されているが、`src/components/GiftBar.tsx:37` は `const card = combo.cards[0]` を表示し、`src/App.tsx:101` も `cardId: combo.cards[0].id` を送る。`reducer` の `validateAssignments`(`reducer.ts:306`) は任意の `combo.cards.find` を受け付ける設計なので、UI が機能を提供していない欠落。3 枚以上の同色コンボでも、現状はユーザーが渡すカードを選べない（同色だが ID は別物なのでゲーム上の影響は限定的だが、ルール準拠の観点と「将来 NN ヘッドを差し替えるとき」の整合性として要修正）。

**案**: `GiftBar` の行ごとに「コンボ内のどのカードを渡すか」の選択 state を持たせ、`handleConfirmGifts` で選択 ID を `assignments` に反映する。

**工数**: 小〜中
**優先度**: 中（同色なら効果は同等のため、ルール表現の問題として中）

---

## ゲーム / AI 層の共通ユーティリティ集約

> 以下 4–9 は密接に関連する重複群。`src/game/actors.ts`（または `selectors.ts` 拡張）と `src/game/ranking.ts`、`src/ai/seed.ts` を整備して一気に整理するのが効率的。ブラウザ NN 統合の `src/ai/neuralAI.ts`、Gen-3-L/M の `grid-uct.ts`/`grid-eval-scale.ts` も同じロジックを再コピーしているため、集約の対象に含める。

### 4. `currentActorId` が 11 箇所で同一定義

**問題**: 贈与配置中は `pendingGiftBatches[0].recipientId` を返し、それ以外は `state.currentPlayerIndex` を返すロジックが以下の 11 箇所にコピーされている。

- `src/hooks/useGameLogic.ts:19`
- `src/ai/mctsAI.ts:71`
- `src/ai/neuralAI.ts:118`
- `ai/scripts/_runner.ts:76`
- `ai/scripts/nn/neuralMcts.ts:70`
- `ai/scripts/nn/dataset.ts:37`
- `ai/scripts/tune-es.ts:51`
- `ai/scripts/bench-neural.ts:38`
- `ai/scripts/grid-uct.ts:131`（Gen-3-L grid search）
- `ai/scripts/grid-eval-scale.ts:128`（Gen-3-M grid search）
- `ai/scripts/_profile-hotpath.ts:25`（開発用プロファイラ）

本来はゲームドメインの責務（フックや AI 側に持つべきではない）だが、共通の置き場所が無く、`App.tsx:2` は `useGameLogic` の re-export を import している。ルール変更時の同期漏れリスクが高い。

**案**: ゲームコア（`src/game/selectors.ts` か新設 `src/game/actors.ts`）に `export function currentActorId(state: GameState): number` を置き、UI・AI・全 Node スクリプトを import に置換。`useGameLogic.ts` の re-export を後方互換のため一時的に残す（`App.tsx` が import している）。

**工数**: 中
**優先度**: 高

### 5. `computeRanking` が 9 箇所に重複、`computeWinner` も同じ tie-break を再実装

**問題**: 得点降順＋同点時は `startPlayerIndex` からの距離で順位付けする同一アルゴリズムが以下に存在。

- `src/ai/mctsAI.ts:81`
- `src/ai/neuralAI.ts:132`
- `ai/scripts/_runner.ts:86`
- `ai/scripts/nn/neuralMcts.ts:84`
- `ai/scripts/nn/dataset.ts:52`
- `ai/scripts/bench-neural.ts:48`
- `ai/scripts/grid-uct.ts:116`（Gen-3-L grid search）
- `ai/scripts/grid-eval-scale.ts:113`（Gen-3-M grid search）
- `ai/scripts/tune-es.ts:98`（`computeRanking` 関数を持たず、`ordered.findIndex((p) => p.id === 0)` の同一ソートを**インライン展開**）
- `src/game/engine.ts:135-144`(`computeWinner` も同じ sort 比較子)

**案**: `src/game/ranking.ts` に `computeRanking(state): number[]`（`ranking[playerId] = 0..n-1`）を置き、`computeWinner` を `computeRanking` の先頭から導出するように `engine.ts` も再構成。tune-es のインライン版も共通呼び出しに置換。

**工数**: 中
**優先度**: 高 （→ 項目 6 と同時着手）

### 6. `rankToValue` が 4 箇所に重複

**問題**: `1 - 2*rank/(numPlayers-1)` で順位を [-1, +1] にマップする式が `src/ai/mctsAI.ts:100-103`、`src/ai/neuralAI.ts:128-130`、`ai/scripts/nn/neuralMcts.ts:80-82`、`ai/scripts/nn/dataset.ts:47-50` の 4 箇所にある。`grid-uct.ts`/`grid-eval-scale.ts` は勝率集計のみで value target を作らないため `rankToValue` は持たず、ここは 4 箇所のまま。4 箇所とも `numPlayers <= 1` をガード済みで、差は `if` 文か三項演算子かの記法だけ（実質完全同一）。

**案**: 項目 5 の `src/game/ranking.ts` に同居させる。

**工数**: 小
**優先度**: 中 （→ 項目 5 と同時着手）

### 7. `stateBaseSeed` が 4 箇所に重複＋ブラウザ版が式まで乖離

**問題**: `rngSeed / turnNumber / playerId / log.length` から決定論的 seed を生成する処理が `src/ai/mctsAI.ts:105-111`、`src/ai/smartAI.ts:21-27`、`src/ai/randomAI.ts:4-10`、`ai/scripts/nn/neuralMcts.ts:99-105` の 4 箇所にある（いずれも `Math.imul(turnNumber+1, 0x9e3779b1)` 等で混合する同一実装）。
さらに、ブラウザ NN 統合で新規追加された `src/ai/neuralAI.ts:255-256` は同じ 4 入力から seed を作るが、**式が異なる**（`rngSeed ^ (turnNumber*7919) ^ (playerId*13) ^ log.length`、`Math.imul` を使わない弱い混合）。`neuralAI` は `neuralMcts` の移植のはずだが seed 導出が既に乖離しており、共通化していれば起きなかった不整合。学習側と推論側で探索のランダム化が食い違う遠因にもなる（→ 項目 19）。

**案**: `src/ai/seed.ts` に `stateBaseSeed` を集約し、neuralAI も含め全 5 箇所を置換。これで式の乖離も解消する。

**工数**: 小〜中
**優先度**: 中

### 8. 非空スロット index 列挙ロジックが 4 箇所に散在

**問題**:

- `src/game/selectors.ts:25-31`(`nonEmptySlotIndices`、**非 export** のため AI から再利用不能)
- `src/ai/actionSpace.ts:107`(インライン null チェック)
- `src/ai/smartAI.ts:80-85`
- `src/ai/randomAI.ts:74-76`

**案**: `selectors.ts` の `nonEmptySlotIndices` を export する（または `src/game/boardUtils.ts` を新設）。`actionSpace` / `smartAI` / `randomAI` から共通呼び出しに統一。

**工数**: 小
**優先度**: 中

### 9. `Float32Array[]` の 2 次元 pack/unpack が 2 箇所に手書き重複

**問題**: 「`Float32Array[]` を `[n, size]` の flat バッファに `buf.set(vecs[i], i*size)` で詰める／逆に `subarray` で切り出す」パターンが `ai/scripts/nn/train.ts:162-175`(`examplesToTensors` の入力詰め込み) と `ai/scripts/nn/neuralMcts.ts:112-135`(`nnPredictBatch` の出力切り出し) で重複。両者は逆操作の対。

**案**: `packFloat2D(vecs): {buf, n, size}` / `unpackFloat2D(flat, n)` ヘルパに集約。

**工数**: 小
**優先度**: 中

---

## エラーハンドリング・防御コードの整理

### 10. `catch { score = -Infinity }` / `catch { continue }` が例外を握りつぶす

**問題**:

- `src/ai/smartAI.ts:160-168`：合法手のはずの `stepGame` が throw したら `-Infinity` 扱い（catch は `:167`）。
- `src/ai/mctsAI.ts:218`(`computePriors` 内、`:203` 開始)：throw したら prior をスキップして次へ。

正常系では到達しないはずの状態を黙って隠すため、bug の発見が遅れる。実際 `stepGame` は throw しない設計（`reducer` は state を返す）なので、catch 自体が過剰防御の可能性が高い。

**案**: 開発時は `console.warn` + 状態スナップショットを出し、本番は `try/catch` を撤廃するか、限定例外型のみ捕捉する。

**工数**: 小
**優先度**: 中

### 11. シミュレーション打ち切り時の silent break

**問題**: `ai/scripts/_runner.ts:130-137`、`ai/scripts/tune-es.ts:85,88`、`ai/scripts/bench-neural.ts:91,94`、`ai/scripts/nn/dataset.ts:158-169`、`ai/scripts/grid-uct.ts:174,177`、`ai/scripts/grid-eval-scale.ts:171,174` で `!action` または `state === before` のとき `break` するが、原因（phase / actor / action type）を記録しない。`finished: false` の局が混ざっても何が起きたか追えない。

**案**: 戻り値に `abortReason?: 'no_action' | 'stale_step'` を含め、`--silent` 以外では 1 行 warn を出す。dataset 生成では abort 局を学習データから除外。

**工数**: 小
**優先度**: 中

---

## AI 層の構造的改善

### 12. `smartAI.enumerateActions` と `actionSpace` が合法手を二重管理

**問題**: MCTS / NN-MCTS / 学習データ生成は `actionSpace.legalActionIds + actionIdToAction` を使うが、`smartAI` は独自の `enumerateActions`(`smartAI.ts:29-89`) を持つ。フェーズ追加や合法条件変更時に 2 系統の同期が必要。例: `awaitingPlaceDrawn` で smartAI は `pendingDraw[0]` のみ列挙(`smartAI.ts:58`)、actionSpace は `[0]`(`:84-89`) と `[1]`(`:90-95`) 両方を扱う、という挙動差もある。

**案**: smartAI を `legalActionIds(state, playerId).map(id => actionIdToAction(...)).filter(Boolean)` に書き換える。`CONFIRM_GIFTS` のみ actionSpace 外（`actionSpace.ts:21-22`）なので別経路を残す。

**工数**: 小〜中
**優先度**: 中

### 13. `dataset.ts` の自己対戦生成 2 関数がほぼコピペ

**問題**: `ai/scripts/nn/dataset.ts:126-196`(`generateSelfPlayGame`、mctsAI 用) と `:202-275`(`generateSelfPlayGameWithModel`、neuralMcts 用) が ~90% 同一。差分は decider 呼び出しと `info`/`visits` の取り出し方のみ。

**案**: `runSelfPlayLoop(decider)` に共通化し、両関数は decider 注入の薄いラッパーにする。項目 4〜9 完了後に着手すると差分がさらに減る。

**工数**: 中
**優先度**: 中 （→ 項目 4〜9 の後）

### 14. 対戦ループ `playOneGame` / `playOne` / `playGame` が 5 実装

**問題**:

- `ai/scripts/_runner.ts:109-151`(`playOneGame`、汎用)
- `ai/scripts/tune-es.ts:66-104`(`playOne`、mcts vs 固定相手)
- `ai/scripts/bench-neural.ts:63-104`(`playOne`、neural seat 固定)
- `ai/scripts/grid-uct.ts:154-188`(`playGame`、uctC grid search 用)
- `ai/scripts/grid-eval-scale.ts:151-185`(`playGame`、leafEvalScale grid search 用)

grid-uct / grid-eval-scale はともに `maxSteps = 20000` をインライン直書きして `DEFAULT_MAX_STEPS` 定数を共有せず、未完局の warn も無い。骨格（setup → while → currentActor → decider → stepGame → break）が同一で、新規スクリプトを足すたびに同じ骨格が増殖している。

**案**: `_runner.ts` に `playOneGameWithDeciders(deciders: Decider[], options)` を追加し、tune-es / bench-neural / grid-* から委譲。席固定・重み注入は decider ファクトリで表現する。

**工数**: 中
**優先度**: 中 （→ 項目 4〜5 の後）

### 15. `nnPredictBatch` / `nnPredict` の `as` キャストが出力構造に無検証依存

**問題**: `ai/scripts/nn/neuralMcts.ts:122-124` で `model.net.predict(input) as tf.Tensor[]` と `out[0].dataSync() as Float32Array` の二重 `as` キャスト。同じパターンがブラウザ版 `src/ai/neuralAI.ts:177-179`(`nnPredict`) にもコピーされている（`predict(input) as tf.Tensor[]`、`out[0]` / `out[1].dataSync() as Float32Array`）。`predict` が単一 Tensor を返す構成（出力 1 つ）に変わると `out[1]` が `undefined` で実行時例外。`dataSync()` も dtype が float32 でないと `Float32Array` でない可能性があり、キャストが嘘になりうる。モデル構造（policy + value の 2 出力）への暗黙依存が、学習側・ブラウザ側の両方で型に守られていない。

**案**: `Array.isArray(out) && out.length === 2` を assert するヘルパに括り出し、両方から使う。または model 側で出力テンソルを名前で取り出すラッパを用意する。

**工数**: 小
**優先度**: 中

### 16. NN 入出力次元のプレイヤー数・スロット数ハードコード

**問題**: `src/ai/encoding.ts:6`(`NUM_PLAYERS = 4`) と `ai/scripts/nn/model.ts:24`(`VALUE_HEAD_SIZE = 4`) が 4 固定。一方 `setup.ts` は `playerNames.length` で人数可変。4 人以外で `encodeState` / 学習を動かすとサイズ不整合だが、サイレントに進む可能性がある（ブラウザ推論 `src/ai/neuralAI.ts:298` も `encodeState` を呼ぶため、この仮定はブラウザ配信時にも及ぶ）。さらに、AI ヒューリスティック（`smartAI.ts:91-113` の `buildGiftAssignmentsHeuristic` や `randomAI.ts:82-90`）は `opponents`/`otherIds` が空（人数 < 2）だと例外や `undefined` 混入を起こす。スロット数 `5` も `actionSpace.ts:26`(`NUM_SLOTS`)・`encoding.ts:5`(`SLOTS_PER_BOARD`)・`setup.ts:12`(`DEFAULT_SLOTS`) の 3 ファイルに独立定義されている。

**案**: 現状 4 人固定なので、`setupGame` 時に `assert(players.length === 4)` を入れる（極小工数）。これで空 `opponents` 経路も塞げる。スロット数定数も 1 箇所に集約。本気で可変化するなら shape API（旧 `getEncodingShape` は本バッチで削除済み）を `numPlayers` 引数付きで再設計する必要がある（中工数）。

**工数**: 極小（assert + 定数集約）／ 中（可変化まで）
**優先度**: 中

### 17. NN-MCTS の探索打ち切り path に全員価値 0 を backup

**問題**: `ai/scripts/nn/neuralMcts.ts:274-276`(`zeroValueVec()`) を `kind: 'cut'`(`:293, 310, 314, 316` の 4 箇所) で backup している。同じ「打ち切り時に全員 0 の価値ベクトルを backprop する」挙動はブラウザ版 `src/ai/neuralAI.ts` にもあり、深度上限・非法 action・`stepGame` 不変（`:291, 316, 323`）で `new Float32Array(numPlayers)`（= 全 0）を leaf 価値として backup する。深度上限・非法 action 到達時に「中位相当」を一票入れることで木の統計を歪め、AlphaZero 学習データの value target 品質にも影響しうる。

**案**: cut 時は backup しない、または親ノードの cached value を使う。`cut` 発生率を計測ログに出してから方針決定するのが安全。learn 側（neuralMcts）と推論側（neuralAI）で挙動を揃えること（→ 項目 19）。

**工数**: 小〜中
**優先度**: 低

### 18. `evaluator` / `_runner` のモジュール global state が並列実行で危うい

**問題**: `src/ai/evaluator.ts:80-84` の `let currentWeights` + `setEvalWeights` がプロセス global。`ai/scripts/bench.ts:90` で global を書き換え、`:131` で `STRATEGIES.mcts`（`_runner.ts` のエクスポート定数）も `const` の中身を破壊的代入している。同一プロセスで複数回ベンチを回す将来のテスト等で前回の weights が残る。Gen-3-J 以降は `options.weights` 渡しで AI 単位に閉じる API（`_runner.ts:39-42` の `makeMctsWithWeights`、Gen-3-L で追加された `:48` の `makeMctsWithOpts`）があるため、global API は段階的に deprecated 化できる。

**案**: 全 AI 呼び出しで `options.weights` 明示を徹底し、bench は decider クロージャに重みを閉じ込める。`STRATEGIES` も immutable に保ち、`playOneGame` に `deciderOverrides` を渡す or `getDecider(name, opts)` ファクトリへ。

**工数**: 中
**優先度**: 低

### 19. IS-MCTS フレームワークが 3 実装に重複（train/inference 整合性リスク）

**問題**: `src/ai/mctsAI.ts`(456 行)、`ai/scripts/nn/neuralMcts.ts`(433 行)、そして `src/ai/neuralAI.ts`(367 行) が `NodeStats`(`mctsAI:62` / `neuralMcts:56` / `neuralAI:109`) / `getOrCreateNode`(`mctsAI:338` / `neuralMcts:221` / `neuralAI:258`) / `puctSelect`(`mctsAI:180` / `neuralMcts:137` / `neuralAI:187`) / selection→expansion→backprop ループ / root 最多訪問選択がほぼ同一構造。`neuralMcts.ts:4` と `neuralAI.ts:4,95,224` のコメントでも「同じ IS-MCTS フレームワーク」と明記されている。差分はリーフ評価（evaluator prior / NN バッチ predict / NN 単発 predict）と prior 算出のみ。
特に `neuralMcts`（学習側）と `neuralAI`（ブラウザ推論側）は**同一であるべき**だが、すでに seed 導出が乖離している（項目 7）。学習時と推論時の探索が食い違うと、学習した policy/value がブラウザで正しく転移しない AlphaZero 特有の不整合を生む。

**案**: tfjs 非依存部分を `src/ai/mctsCore.ts` に抽出し、selection / backprop / node 管理を共通化。`mctsAI` は evaluator prior を注入、`neuralMcts` は NN batch predict を注入、`neuralAI` は NN 単発 predict を注入する。`@tensorflow/tfjs-node` は引き続き `ai/scripts/` のみで、`@tensorflow/tfjs`（ブラウザ）は `neuralAI` のみで import。

**工数**: 大
**優先度**: 低 （→ 項目 4〜9 後の長期目標。ただし NN を実際にブラウザ配信する段階では train/inference 整合性のため優先度が上がる）

---

## パフォーマンス（低優先・実害軽微）

### 20. React の `state` 全体依存 useMemo が毎レンダー再計算

**問題**: `src/App.tsx:36-39` の `interactiveSlotIndices` useMemo は依存配列が `[state, you]`。`state` は reducer で毎 dispatch ごとに新参照になるため実質メモ化が効かず毎レンダー再計算。`useBoardLayout.ts:129` の `globalMaxStack`(`[state.players]` 依存) や `App.tsx:46` の `cardsToPlace = placeableCards(state)`（毎回新配列）→ `usePlacementSelection` の effect 連鎖（`:16-24`）も同種。ただし計算は軽量で実害は限定的。

**案**: 依存を `[state.phase, state.players[you], state.turn, you]` 等に絞るか selector をメモ化。低優先。

**工数**: 極小〜小
**優先度**: 低

---

## ドキュメント陳腐化

### 21. `useBoardLayout.ts` のギフト配布数コメントが古い

**問題**: `src/hooks/useBoardLayout.ts:35-37` のコメントは「gift-bar は 3 列 × 2 行（最大 6 個）を前提とし、2 行で約 162px」とあるが、`40173c4` で `GiftBar.tsx:13-14`（実体は `:31`）が `max(3, ceil(N/2))` の動的列に変更され、配布数 7 以上で列が増える。

**案**: コメントを動的列前提に書き換える。`MIN_ACTION_HEIGHT = 220`(`:40`) の妥当性が変わるなら別途見直し。

**工数**: 極小
**優先度**: 低

---

## まとめテーブル

| # | 項目 | カテゴリ | 工数 | 優先度 | 備考 |
|---|------|----------|------|--------|------|
| 1 | evaluateState 得点二重計上 | 実質バグ | 小〜中 | 中 | 修正＝再チューニング要 |
| 2 | evaluateUnknownDraw 山札空 | 実質バグ | 小 | 中 | 単独 |
| 3 | プレゼント UI のカード選択 | 機能欠落 | 小〜中 | 中 | docs/RULES.md 準拠 |
| 4 | currentActorId → game コア（11 箇所） | 共通 util | 中 | 高 | 5〜9 と同時着手 |
| 5 | computeRanking / computeWinner（9 箇所） | 共通 util | 中 | 高 | → 6 と同時 |
| 6 | rankToValue 統合（4 箇所） | 共通 util | 小 | 中 | → 5 と同時 |
| 7 | stateBaseSeed → ai/seed.ts（5 箇所・式乖離） | 共通 util | 小〜中 | 中 | 単独可 |
| 8 | nonEmptySlotIndices 共有 | 共通 util | 小 | 中 | 単独 |
| 9 | Float32 pack/unpack 統合 | 重複排除 | 小 | 中 | 単独 |
| 10 | catch silent の整理 | 防御コード | 小 | 中 | 単独 |
| 11 | silent break の原因記録 | エラー処理 | 小 | 中 | 単独 |
| 12 | smartAI 合法手を actionSpace に統一 | 構造 | 小〜中 | 中 | 単独可 |
| 13 | dataset 2 関数の統合 | 重複排除 | 中 | 中 | → 4〜9 の後 |
| 14 | 対戦ループ統合（5 実装） | 重複排除 | 中 | 中 | → 4〜5 の後 |
| 15 | nnPredict(Batch) 型キャスト検証（2 箇所） | 型安全 | 小 | 中 | 単独 |
| 16 | NUM_PLAYERS/スロット数 assert・集約 | 型安全 | 極小〜中 | 中 | 単独 |
| 17 | NN-MCTS cut 時 backup の見直し | AI 品質 | 小〜中 | 低 | 学習に影響・neuralAI と揃える |
| 18 | evaluator/_runner global state 撤去 | 構造 | 中 | 低 | 単独可 |
| 19 | mctsCore 抽出（3 実装） | 構造 | 大 | 低 | → 4〜9 の後・配信時に昇格 |
| 20 | React state 全体依存の再計算 | パフォーマンス | 極小〜小 | 低 | 実害軽微 |
| 21 | useBoardLayout コメント更新 | ドキュメント | 極小 | 低 | 単独 |

**着手の目安**: 極小工数の安全な改善バッチ（旧 1・2・6〜18）は実装済み（未コミット）。残りは、1（二重計上）は計測＋再チューニング前提で慎重に、4〜9（共通 util、neuralAI / grid-uct / grid-eval-scale も巻き込む）を 1 PR、12・13・14（合法手・dataset・対戦ループ）を別 PR、19（mctsCore、現在 3 実装）は長期。NN をブラウザに実配信する判断が出たら 7・17・19（train/inference 整合性）の優先度を上げる。

---

## 不採用とした指摘の記録

発見フェーズで挙がったが、精査の結果項目化しないもの（再提起防止のため記録）。

- **`usePlacementSelection` の useEffect 依存配列（`src/hooks/usePlacementSelection.ts:16-24`）から `selectedCardId` を外す**：誤り。外すと `length === 0` 分岐内で stale closure 化する。実体は「`placeableCards` が毎レンダー新配列を返すため effect が毎回走るが、ガードで setState されず無害」（`src/game/selectors.ts:71-73`）。配置選択ロジックは既に `usePlacementSelection` に隔離済み。
- **`key={idx}`（`src/components/PlayerBoardView.tsx:42` / `src/components/LogPanel.tsx:26`）**：問題なし。スロットは固定 5 枚・順序不変、ログは追記のみ。スタック内のフェードは `src/components/SlotView.tsx:154` / `:170` で `card.id` を key にしている。
- **`useBoardLayout` の `calcDims()` 二重呼び出し（`src/hooks/useBoardLayout.ts:121-124`）**：マウント後に寸法を確定させる意図的な呼び出しで実害なし。
- **`giftTargets[i]!` の non-null 断言（`src/App.tsx:102`）**：`allGiftTargetsReady`（`:94-95`）でガード済み。`if (!allGiftTargetsReady) return`（`:98`）で早期 return しているため安全。
  ※ 「コンボ内のどのカードを渡すか UI で選べない」点は別問題として **項目 3** で扱う。
- **`evaluateState` の `pendingMult` 二重計上を「無害な仕様」として放置**：誤り。当ターンの combo がギフトフェーズで二重加点される実バグ。**項目 1** で扱う。
- **`next.players[player.id]` / `next.players[batch.recipientId]` に null ガードを追加**：不採用。`player.id` はプレイヤー列挙由来、`batch.recipientId` は配布バッチ生成時に検証済みで、いずれも `players` 配列の正当な index。「ありえない index」に黙って `return state` する防御は、むしろ CLAUDE.md が禁じる「デフォルト値での握りつぶし」にあたり、バグを隠す。なお `COLOR_LABEL[c.color]` 参照は本バッチで `src/game/labels.ts` への集約により `Record<Color, string>` 型化され、欠損キーは型エラーで検出されるようになった。
- **`actionSpace.ts` の `DISCARD_TOP` にスロット index 上限チェックを追加（`src/ai/actionSpace.ts:103-108`）**：不採用。`slotIndex` は `id < ID_DISCARD_TOP_BASE + NUM_SLOTS` で上限管理され、`state.players[actorId]?.board.slots[slotIndex]` の結果を `if (!slot || slot.stack.length === 0) return null` で弾いている。範囲外は `undefined` となり `!slot` で捕捉済みのため、追加ガードは冗長。
