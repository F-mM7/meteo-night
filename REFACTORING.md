# リファクタリング方針

実コードと照合した、実行可能なリファクタリング作業計画。**独立した作業単位（WU）**ごとに整理してある。各 WU は単独で着手でき、依存がある場合は明記する。NN 関連は方針上**保留**（末尾の専用セクション、当面着手しない）。

## 現状分析

- **規模**: `src/` 47 ファイル（約 6,259 行、うちテスト 4）、`ai/scripts/` 33 ファイル（約 7,221 行）。
- **体制**:
  - ブラウザ CPU は **`tempoFastAI`（lookahead=1, Gen-4-C）**（`src/ai/index.ts:4` が re-export）。1 手 ~1 秒のため **`src/ai/aiWorker.ts`（Web Worker）で実行**し `useGameLogic` が非同期に呼ぶ（同期 `decideAction` はフォールバック）。探索は深さ的にほぼ天井（lookahead=2 は parity-下）、**葉＝`evaluateState` の評価も全 tune が parity ＝強さは実用天井**。
  - `mctsAI` / `smartAI` / `tempoAI` / `chainRushAI` はブラウザから到達せず、**ベンチ専用のベースライン**に後退した。
  - **NN（`neuralAI` / `ai/scripts/nn/*` / `bench-neural` 等、約 2,875 行）は方針上保留**。生きている経路から到達不能なまま残る（→ 末尾「保留」）。
- **主要負債（現役コード）**:
  1. **現役 AI のコピー重複**: `tempoFastAI` が `tempoAI` を探索フレームごと全面再実装、`currentActorId`（26 箇所）/`computeRanking`（15 箇所）/`stateBaseSeed`（生存 5 箇所）/対戦ループ（12 実装超）がゲーム・AI・スクリプトに散在。
  2. **評価関数 `evaluateState` の得点二重計上窓**（現ブラウザ CPU に現存）。
  3. **ベンチ基盤の重複と退行**（数値引数の NaN・`maxSteps` 直書き・勝者判定のタイブレーク無視）。

---

## WU-1: CPU 思考の非ブロック化 + エンジンのテスト網【優先度: 高 / 独立】

UX 直結と、後続リファクタの安全網。単独で着手可能。

- ~~**CPU 探索の同期ブロック解消**~~ → **完了（Gen-4-C, 2026-06）**: `src/ai/aiWorker.ts` を新設し、`useGameLogic` が CPU 手番の `decideAction` を **Web Worker で非同期実行**（世代ゲーティングで古い応答を破棄、生成不可時は同期 `decideAction` フォールバック）。lookahead=1 で 1 手 ~1 秒だが UI は非ブロック。`cpuSpeed` は `effectDelay`（表示テンポ）にリネーム済み。**残課題（小）**: effect 依存配列に `effectDelay` が残り、スライダー操作で同一 state を再探索する（worker 経由で非ブロックなので実害小。気になれば遅延値を ref 化して依存から外す）。
- **エンジン最複雑部のテスト追加** — `src/game/__tests__/` は combo/scoring/selectors/flow の 4 本のみで、連鎖収束（`reducer.ts:63` `resolveChainStep`）・得点確定と終局（`reducer.ts:113` `finalizeTurnAfterCombos`）・贈与の検証/自動配置（`reducer.ts:306` `validateAssignments`）が無テスト。→ seed 固定の 1 ターン完走統合テスト＋ `validateAssignments` の境界（重複 comboIndex 拒否・自分宛て拒否・枚数一致）＋連鎖収束テスト。**工数 中**
- **`hasNoMoreTurns` のテスト固定** — `engine.ts:121-133` の 12 行モジュロ算術（`rawEnd === 0 ? n : rawEnd` 特殊ケース）が `reducer.ts:360`（最終ラウンドの贈与自動配置＝ゲーム結果に直結）を駆動するのに無テスト。→ endTrigger 位置・current 位置・対象 player を網羅する表駆動テスト。**工数 小**

---

## WU-2: ゲームコア（actors / ranking）への集約【優先度: 高 / WU-4 の前提】

「アクター判定」と「順位付け」をゲームコアの単一ソースにし、UI・現役 AI の重複を一掃する。最もレバレッジが高い。

- **`currentActorId` を `src/game/actors.ts`（新設）へ** — 贈与配置中は受領者、それ以外は手番者を返すロジックが **26 箇所**に重複（現状の正は `useGameLogic.ts:19`、ほか `_runner` export 版・`mctsAI`・`smartAI`・`randomAI`・`tempoAI:87`・`tempoFastAI:125`・`chainRushAI:48` ＋スクリプト群）。→ ゲームコアに 1 本化し、UI・現役 AI を import に置換。`useGameLogic` は後方互換のため re-export を一時残置。
- **`isAIDriven` / `isHumanInteractive` を `selectors` へ** — 同じく `useGameLogic.ts:19-54` のドメイン純関数が UI フックを正としている。`selectors` へ寄せ、`autoPilot` を引数で受ける純関数化。
- **操作ガードの一本化** — 「AI 手番中はユーザー操作無視」が `useGameLogic.ts:104-107` と `App.tsx:50,56,61` の 2 層（出所が `isAIDriven`/`isHumanInteractive` で別）。判定を上記集約先へ寄せ、1 層に。
- **`nonEmptySlotIndices` を export** — `selectors.ts:25-31` が非 export のため `randomAI.ts:74-77` がインライン再実装。export して置換。
- **`computeRanking` + `computeWinner` を `src/game/ranking.ts`（新設）へ** — 得点降順＋同点は startPlayer 距離、の同一アルゴリズムが **15 箇所**（`_runner.ts:100`・`mctsAI`・grid 系・`tune-es.ts:102-107` のインライン展開 ＋ `engine.ts:135` の `computeWinner` も同 tie-break）。→ `computeRanking(state): number[]` を置き、`computeWinner` を先頭から導出。
- **`rankToValue` を `ranking.ts` へ** — `1 - 2*rank/(numPlayers-1)` の生存コピー（`mctsAI.ts:128`）を同居集約。

**工数 中 / 依存 なし（_runner も import に切替）。`_runner` 経由で WU-4 が依存。**

---

## WU-3: src/ai の共通ヘルパ・重複の集約【優先度: 高〜中 / WU-2 の後が楽】

現役 AI 戦略ファイル間のコピーを排除する。現役コード最大の負債。

- **`tempoFastAI` ↔ `tempoAI` の重複排除** — `tempoFastAI`(602 行) が `tempoAI`(334 行) を「評価関数は完全同一」と認めつつ探索フレームごと全面再実装。`leafValue`(tempoAI:161/fast:185)・`multiColorChainReadiness`(tempoAI:133/fast:163)・`enumerateOwnActions`・`isBlindDraw`/`isPlacement`・定数群が重複。`tempoAI` はブラウザ到達不能でベンチ専用。→ **`tempoAI` を `tempoFast` の「`timeBudgetMs=Infinity`・TT/αβ 無効」プリセットとして吸収し `tempoAI.ts`(334 行) を削除**（ベンチの `makeTempoWithOpts` も fast 差し替え）。または共通部を `tempoShared.ts` に抽出。**工数 中 / 優先度 高**
- **チェイン準備度ロジックの一本化** — 「色がスロット上位に並ぶ度合い」の盤面スキャンが 4 実装に分裂し式が三者三様: `evaluator.chainReadinessScore`(`:181`, near×3)・`tempoAI`/`tempoFast.multiColorChainReadiness`(near²)・`chainRushAI.dominantNearTopColor`(`:64`)。`evaluator.ts:180` のコメント「chainRushAI と同設計」は実装と乖離。→ `src/ai/boardSignals.ts` に色別 near/top カウントの基底関数を置き、各係数は薄い集計に。**工数 小〜中**
- **`stateBaseSeed` を `src/ai/seed.ts` へ** — `Math.imul` 混合の同一実装が生存 5 箇所（`randomAI:4`・`smartAI:21`・`tempoAI:94`・`tempoFastAI:132`・`mctsAI:131`）。→ 1 本化。**工数 小**

**依存: 共通化先のうち `currentActorId`/`stateBaseSeed` は WU-2 と連動（先に WU-2 を済ませると差分が減る）。**

---

## WU-4: ベンチ / スクリプト基盤の一本化【優先度: 中 / WU-2 の後】

`ai/scripts/` の対戦・集計の重複を `_runner` に集約し、退行を修正する。

- **対戦ループを `playOneGameWithDeciders` に委譲** — 骨格同一の対戦ループが **12 実装超**。改善先の `playOneGameWithDeciders` は**既に `_runner.ts:144` に実装済み**で `bench-self`/`elo-ladder`/`_la_bench` は使用中。→ 未移行（`tune-es`・grid 系・`grid-score-convex`・`grid-chain-ready`・`hh-terminal`・`_fast_bench`・`_fast_latency`）を委譲。`rotateSeats` も import 統一。
- **ベンチ集計骨格と tempoFast factory の共通化** — 「候補 1 席 vs baseline 3 席 rotate → `ranking[candSeat]===0` 集計 → Wilson CI → 公平基準 0.25」が `bench-self`/`_fast_bench`/`_la_bench` で逐語重複。さらに現状最強 `tempoFastAI` 用の decider factory が `_runner` に無い。→ `runRotatingBench(...)` と `makeTempoFastWithOpts` を `_runner` に追加、`STRATEGIES` に `tempoFast` 登録。
- **数値引数の検証（退行修正）** — `_runner` の `parseIntArg`/`parseFloatArg`（NaN を throw）を使わず素の `Number()` に逆戻りしている: `_fast_bench`/`_fast_latency`/`_la_bench`（`--budget`/`--lookahead`）。`timeBudgetMs=NaN` で deadline 即超過＝**ベンチが黙って弱い結果**を出す。→ 全数値引数を `parseIntArg`/`parseFloatArg` に統一。**極小だが物差しの信頼性に直結。**
- **`maxSteps=20000` の定数化** — `_runner.DEFAULT_MAX_STEPS` があるのに新スクリプトがインライン直書き（`_fast_bench:73,109` 他）。→ import に統一。
- **`_fast_latency` の勝者判定** — `:144-148` が `Math.max` 比較で同点トップを全員勝ちにカウント。→ `r.ranking[candSeat]===0`（`playOneGameWithDeciders` 利用）に統一。
- **silent break の原因記録** — `!action`/`state===before` で `break` する箇所が **15 ファイル超**、原因（phase/actor/action）を記録しない。→ 戻り値に `abortReason` を含め `--silent` 以外で 1 行 warn。`playOneGameWithDeciders` 集約で一括解消。
- **`evaluator`/`bench` の global state 撤去** — `evaluator.ts:135-138` の `setEvalWeights`（プロセス global）を `bench.ts:94,157` が書き換え、`STRATEGIES.mcts` も破壊代入。`makeMctsWithOpts`（`_runner.ts:52`）に統一し decider クロージャへ閉じ込め。

**工数 小〜中 / 依存: WU-2（`playOneGameWithDeciders` が game コアの関数を使う）。**

---

## WU-5: UI コンポーネントの責務分離【優先度: 中 / 独立】

ゲームページのコンポーネント責務を整理する。`App.tsx`(267 行) の肥大化解消。

- **ギフト配布を `useGiftDistribution` フックへ＋カード選択 UI** — `App.tsx:81-145` に `giftTargets` state・初期化 effect・確定/ランダム配布・確定ボタン JSX が約 65 行集中（プレイスメントは `usePlacementSelection` に分離済みなのに不均衡）。同時に、各コンボの「渡すカード」が `GiftBar.tsx:37`/`App.tsx:103,116` で先頭固定（`docs/RULES.md:117-120` は「選んで渡す」、`validateAssignments` は任意カードを受け付ける）。→ `useGiftDistribution(...)` に集約し、行ごとのカード選択 state を持たせる。**工数 小〜中**
- **`ActionPanel` の `rightSlot` 撤去** — `ActionPanel.tsx:9,70` の汎用 `rightSlot` に `App.tsx:122-145,244` がギフト確定ボタンを混入。→ 確定 UI は GiftBar 側（または `GiftConfirmBar`）へ移し `rightSlot` 削除。**工数 小**
- **`describePhase`/`canDiscard` の分離** — `ActionPanel.tsx:12-50` のフェーズ文言マッピングと `:61-63` の合法性ガード（ゲーム層と二重管理の疑い）。→ 文言は `game/labels.ts`、可否判定は `selectors` へ。**工数 小**
- **`CenterArea` 座席 prop の配列化＋`SeatPosition` 一本化** — `CenterArea.tsx:15-18` が 4 個別 prop を受け `:39-44` で配列化（`App.tsx:204-207` が往復展開）。`SeatPosition` 型は `PlayerBoardView.tsx:4` と `CenterArea.tsx:6`（順序違いのローカル再定義）に重複。→ `seats: Array<{position, player}>` 1 prop へ、型は 1 箇所に統一。**工数 小**

---

## WU-6: AI 評価・防御の修正【優先度: 中 / 独立・一部要計測】

- **`evaluateState` の得点二重計上** — `finalizeTurnAfterCombos`（`reducer.ts:113-143`）が combo 得点を `score` 確定後に `combosThisTurn` をクリアせず `giftQueue` へコピー（クリアは `endTurn:167`）。一方 `evaluator.ts:280-282` が `currentPlayerIndex===playerId` で pending を無条件加点 → ギフトフェーズで二重計上。**現ブラウザ CPU の `tempoFastAI`（`:186` で `evaluateState` を leaf に使用）に現存**。→ (a) `finalizeTurnAfterCombos` で `combosThisTurn` クリア、または (b) pending 加点を得点未反映フェーズに限定。**現挙動で重みが調整済みのため、まず影響度を計測し、修正時は葉重みの再チューニング必須。WU 内で最もリスクが高い。** **工数 小〜中**
- **`evaluateUnknownDraw` の山札枯渇** — `smartAI.ts:116-133` は `shuffle(state.deck)`（`:127`）で 4 サンプル推定するが、山札空・捨札ありだと `shuffle([])` で 4 サンプル同一＝無駄ループ＋決定論的偏り（実ドローは `engine.ts:42-46` の固定 seed）。→ 山札空時は捨札も determinize 対象に含めるかサンプル数 1 に。**工数 極小**
- **`catch` の握りつぶし整理** — 合法手のはずの `stepGame`（throw しない設計）を try で囲み黙ってスキップ: `smartAI:167`・`mctsAI:246`・**`tempoFastAI:587`（ブラウザ経路）**・`chainRushAI` 7 箇所（`:110-113,126-129,160-162,172-174,183-185,309-311,322-324`）。→ 開発時は warn＋スナップショット、本番は撤廃か限定例外型のみ。ブラウザ経路の `tempoFastAI:587` を優先。**工数 小**
- **`smartAI` 合法手を `actionSpace` に統一** — `smartAI.enumerateActions`(`:29-89`) が `actionSpace` と二重管理（`awaitingPlaceAdditionalDraw` で挙動差: smartAI は `pendingDraw[0]` のみ、actionSpace は両方）。→ `legalActionIds().map(actionIdToAction).filter(Boolean)` に。`CONFIRM_GIFTS` のみ別経路。**工数 中**

---

## WU-7: 極小・デッドコード一括【優先度: 中〜低 / 独立】

機械的で安全な小修正。1 PR でまとめて。

- **`freshTurnState()` の導入** — `TurnState` 空初期値 7 フィールドが `reducer.ts:164-172` と `setup.ts:101-109` に完全重複。→ 共通関数化。
- **デッドコード削除** — `SetupOptions.initialHandRounds`（`types.ts:102`、参照ゼロ）／ `seatLong`・`centerSize`（`useBoardLayout.ts:9-10,49-51`、消費者ゼロ）。
- **`chainRushAI.__debugFireSamples`（`:390`）の隔離** — 本番 `src/ai` 配下のデバッグ専用 export（使い捨て `_debug-chainrush.ts` のみ使用）を debug 側へ。
- **定数化** — ログ上限 `reducer.ts:26,36` の `.slice(-80)` → `LOG_MAX_ENTRIES`。`appendLog`/`appendSystemLog`（`reducer.ts:19,29`、差分 playerName のみ）統合＋ `'システム'`(`:32`) を `SYSTEM_NAME`。クランプ `normalizeDelay`(`useGameLogic.ts:14`)/`AppHeader.clamp`(`:28`) 統合。
- **人数・スロット固定の防御** — `setupGame` に `assert(players.length === 4)`（`encoding.ts:5-6`・`actionSpace.ts:26`・`setup.ts:12` の 4/5 固定をサイレント不整合から守る）。`DEFAULT_LEAF_EVAL_SCALE=1500` の二重定義（`mctsAI.ts:39` ＝生存側）を集約。
- **`.board-area` の統合** — `index.css:299-301` と `:326-340` の分裂を 1 ブロックに。
- **型を狭める** — `interactivePairs` を `number[]` → `(0|1)[]`（`FieldView.tsx:7`/`CenterArea.tsx:11`）。
- **コメント更新** — `useBoardLayout.ts:35-37` のギフト列コメント（「3 列×2 行」）を `GiftBar.tsx:31` の動的列前提に。

**工数 各極小**

---

## WU-8: CSS の整理【優先度: 低 / 独立】

- **アクセント色のトークン化** — `--accent`/`--accent-strong`/`--blue` と同値の色を生 `rgba()` で約 60 箇所に散布。→ `--accent-strong-rgb: 255 210 77` 成分変数＋ `rgb(var(...) / 0.55)` で透明度バリアント生成。**工数 中**
- **キーフレームの方向別重複** — `card-fade/launch/place-*` が down/up/left/right × 3 種で約 130 行（差分は軸と符号のみ）。→ `--dir-x/--dir-y`(±1) 変数で一本化。**工数 中**
- **寸法ロジックの JS/CSS 二重化の方針判断** — `useBoardLayout.ts:46-107` ↔ `index.css:264-340`。盤面正方形は `aspect-ratio:1`、分岐は `@media(orientation)` へ戻せる余地がある一方、ログ高さを差し引く連立は JS 残置が妥当。**設計レビュー対象 / 工数 大**

---

## WU-9: 要計測・要判断・長期【優先度: 低】

着手前に計測や方針決定が要るもの。

- **`tempoFast` の TT キー文字列生成** — `tempoFastAI.ts:338` が反復深化の各ノードで `observationKey`（重い）＋文字列連結。→ `observationKey` の WeakMap メモ化等。**プロファイルで律速確認後に着手。**
- **`tempoFast` の `opponentModel='mcts'/'tempo'` 経路の整理** — **ブラウザ既定は `lookaheadTurns=1`/`opponentModel='smart'`（Gen-4-C で LA=1 採用）**。lookahead 検証は決着済み（LA=1 採用、LA=2 と opp=tempo/mcts は parity-下で**不採用確定**＝CHANGELOG「Gen-4 探索ラウンド」「horizon 深掘り」）。よって `decideTempoOpponent` と `advanceToMyTurn` の mcts/tempo 分岐は配信経路でもベンチでも今後使わない（`tempoFast` の `mctsAI` 依存の唯一理由）。→ 約 120 行削除＋`mctsAI` 依存除去が**着手可能**。
- **React `state` 全体依存の useMemo** — `App.tsx:36-38`（`[state, you]`）・`useBoardLayout.ts:138`（`globalMaxStack` の依存と参照のズレ）・`App.tsx:46`。→ 依存を絞る。実害軽微。
- **`Phase` の判別共用体化（長期）** — `types.ts:27-39`(10 文字列 union)＋`:58-71`(フラットな `TurnState`)で不正状態が型表現可能、各ハンドラの `if(!card) return state` 防御を要する。`turnEnd` 幽霊フェーズ（`types.ts:36-38`、コメントは明記済み）も同時に型分離。→ まず不変条件のスモークテスト（小）、判別共用体移行は長期（大）。`pendingDraw` 等が広範に直接参照され影響大。

---

## 作業単位サマリ

| WU | 内容 | 工数 | 優先度 | 依存 |
|---|------|------|--------|------|
| 1 | CPU 非ブロック化（**Web Worker で完了**）+ エンジンテスト（未） | 小〜中 | 高 | なし |
| 2 | ゲームコア（actors/ranking）集約 | 中 | 高 | なし（WU-4 の前提）|
| 3 | src/ai 共通ヘルパ集約（tempo 重複排除）| 中 | 高〜中 | WU-2 と連動 |
| 4 | ベンチ/スクリプト基盤の一本化 | 小〜中 | 中 | WU-2 |
| 5 | UI コンポーネント責務分離 | 小〜中 | 中 | なし |
| 6 | AI 評価・防御の修正 | 小〜中 | 中 | なし（評価二重計上は要計測）|
| 7 | 極小・デッドコード一括 | 極小 | 中〜低 | なし |
| 8 | CSS 整理 | 中 | 低 | なし |
| 9 | 要計測・長期 | 小〜大 | 低 | 計測/方針決定 |

**推奨着手順**: WU-1（即効・安全網）→ WU-2（コア集約、後続の土台）→ WU-3 / WU-4（重複排除、WU-2 後が楽）→ WU-5・WU-6・WU-7（独立、並行可）→ WU-8 → WU-9。

---

## 保留: NN 関連（当面着手しない）

NN/AlphaZero は本ゲームでは行き止まりと実証され進化対象外（スキル `evolve-meteo-ai-neural` も削除済み）。だが**去就（削除 or 保管）は保留**とし、当面は触らない。実コード約 2,875 行（`neuralAI.ts` 400 ＋ `ai/scripts/nn/*` 約 1,936 ＋ `bench-neural.ts` 248 ＋ NN 専用 `_profile-*`/`_verify-search`/`_save-untrained-hybrid`）が、生きた経路から到達不能なまま残る（`neuralAI` への唯一の橋 `index.ts:20` の `loadNeuralAI` も未呼び出し）。

以下は記述としては実コードと整合するが、保留扱いで着手しない。NN の去就を決める時にまとめて扱う:

- 並列 self-play が hybrid/policy-only を黙って無視（`train.ts:263-283` が `args.hybrid` を渡さない）
- 自己対戦データ生成が未終局局面を value target 化（`dataset.ts:131,371`、`gameOver` 区別なし）
- `dataset.ts` の自己対戦生成が 3 系統にコピペ（`:131`/`:207`/`:371,414`）
- `Float32Array[]` の 2 次元 pack/unpack の手書き重複（`train.ts:205` ↔ `neuralMcts.ts:164`）
- NN-MCTS の打ち切り path に全員価値 0 を backup（`neuralMcts.ts:330` 他、neuralAI 側にも同構造）
- IS-MCTS が 3 実装＋ `neuralMcts` 内 sequential/parallel の 2 系統に重複（train/inference 整合性目的は配信しない方針で消滅）
- `encodeState` の `Float32Array.from` がホットパスで多発（NN 経路のみ）
- `neuralAI` の `stateBaseSeed` 式乖離（`:285`、`Math.imul` 不使用）／ `rankToValue`・`computeRanking` の NN 側コピー／ `VALUE_HEAD_SIZE`・NN 側 `DEFAULT_LEAF_EVAL_SCALE` の固定値 — WU-2/WU-3/WU-7 の集約対象から除外して保留
- `train.ts:17-19` の「one-hot 暫定版」コメント陳腐化

---

## 調査済み・非対応（再提起不要）

- **`usePlacementSelection` の依存から `selectedCardId` を外す**: 誤り。外すと stale closure 化。実体は「`placeableCards`(`selectors.ts:71-73`) が毎レンダー新配列を返すが、ガードで setState されず無害」。
- **`key={idx}`（`PlayerBoardView.tsx:42`/`LogPanel.tsx:26`）**: 問題なし。スロットは固定 5 枚・順序不変、ログは追記のみ。スタック内フェードは `SlotView.tsx` が `card.id` を key にしている。
- **`useBoardLayout` の `calcDims()` 二重呼び出し**: マウント後に寸法を確定させる意図的呼び出しで実害なし。
- **`App.tsx` の `giftTargets[i]!` 断言 / `next.players[...]` の null ガード追加**: いずれも正当な index でガード済み。「ありえない index に黙って `return state`」はバグを隠すため不採用（`COLOR_LABEL` は `labels.ts` で `Record<Color,string>` 型化済み、欠損は型エラー検出）。
- **`actionSpace.ts` の `DISCARD_TOP` にスロット index 上限チェック追加**: 冗長。`id < ID_DISCARD_TOP_BASE + NUM_SLOTS` で上限管理、`if (!slot || slot.stack.length === 0) return null` で範囲外捕捉済み。
