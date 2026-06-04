# AI 学習・評価基盤

このディレクトリは「星を放つ夜」CPU AI の学習・評価に関するコード/データを置く場所です。
ブラウザバンドルには含めません（Vite は `src/` のみをエントリにします）。

---

## 現状（コンテキスト復元用サマリ）

> 新セッション開始時は、まずこのセクションと `ai/CHANGELOG.md` の最新エントリを読めば現状把握できます。

### ブラウザに反映されている CPU
- **戦略**: tempoFastAI + **lookahead=1**（Gen-4-C）。ターン内 DFS 完全読み + テンポ評価 + 時間予算(1秒)/反復深化/αβ/置換表に加え、**相手の手番を挟んで次の自分の手番まで読む(2-ply)**。`src/ai/index.ts`→`tempoFastAI`(既定 LA=1) を export
- **強さ（smart 非依存）**: LA=1 は現 tempoFast(LA=0) に**有意勝ち**（33.0%, n=300, Wilson CI 27.9-38.5% > 公平 25%）。点稼ぎでなく「レースに勝つ」着手。**探索系で初めて現 tempo を超えた＝horizon が「葉の天井」を破った**（葉の改善は全て parity だったが、読みの地平を伸ばすと効く）。vs Gen-3-X mcts も圧倒
- ⚠️ **レイテンシ**: LA=1 は 1 手 ~1 秒（中央値, ≥500ms が 73%）と重い。メインスレッドを止めないよう **Web Worker(`src/ai/aiWorker.ts`)で off-main-thread 実行**（`useGameLogic.ts` が非同期呼び出し＋世代ゲーティング＋同期フォールバック）。体感 OK 確認済み
- ⚠️ vs smart は盲点を共有して測れない。 物差しは `_fast_bench.ts` / `_la_bench.ts`（候補 vs 現状）+ `elo-ladder.ts`
- **旧版**: Gen-4-B(tempoFast LA=0, 最悪 1s)→ Gen-4-A(tempoAI 無制限探索, 21s 裾)→ Gen-3-X mcts。いずれも強さは LA=1 未満 or 同等
- **未解決（探索アプローチは天井）**: 葉も horizon も尽きた。horizon=1 で一度突破したが lookahead=2（@1000 20%/@2500 14.6%）・opp=tempo（16.7%）・終盤適応LA・budget2000（Gen-6, n=400 で 27.8% parity）はいずれも LA=1/budget1000 を超えず＝**lookahead=1 + budget1000 が sweet spot**。NN 近似も前提 refuted。**ML 駆動の特徴発掘(Gen-7)も「自己対戦で観測可能な実用特徴は現評価が捕捉済み」を裏付け**（材料報酬含め parity、最強の新シグナル「席順」は行動不能な定数）。**Gen-8 で配信制約を外し深い探索・MCTS@2万・大規模 value ネット(GPU)も投入したが全て tempo LA=1 に及ばず**（多くは有意に下回る。value ネットは勝者予測では手書きを上回る(0.325 vs 0.253)が、ノイジーで探索の葉にすると壊滅＝0%）。根本機序＝均衡した自己対戦では勝敗が本質的に予測困難で評価改善の余地が原理的に小さい。残る本命のレバーは**人間プレイの弱点診断/模倣**（自己対戦＝自己参照では人間相手の弱点が見えない・要ユーザー）と、構造的盲点の**ギフト能動妨害**（現評価に攻撃モデル皆無・未検証）
- 🔄 **ゲーム設定 (2026-06-03)**: 山札 **120 枚（各色 24）**（旧 100 枚）。Gen-5 で重み再調整したが **現重み（chainReadyMult=10 / tempoChainW=50）が最適＝parity**（各色 20% の分布は 100 枚時と不変で最適点が動かない）。AI は山札サイズ非依存のため Gen-4-C 据置

### 試行中の方向性

| 方向 | 現状 | スキル |
|---|---|---|
| AI 進化（手書き探索 + 評価関数。現 tempoFast LA=1）| **葉の改善は天井**(重み/多ターン投影/残差すべて parity)だが、**horizon=lookahead=1 で突破**(Gen-4-C, 現 tempo に 33%)。Web Worker で ~1 秒思考を off-thread 化。ただし lookahead=2/opp=tempo は parity-下＝LA=1 が sweet spot で**探索も天井**。残るは人間棋譜模倣のみ | `evolve-meteo-ai-handwritten`（唯一の AI 進化スキル）|
| ~~NN AI（AlphaZero 風）~~ | **対象外＝実証済みの行き止まり**: branching 5.1 で priors 無効、hand-eval に value/priors とも勝てず az-v1〜v10 + 価値学習 v1/v2 が全敗。スキル `evolve-meteo-ai-neural` は削除（経緯は CHANGELOG） | （削除済み）|

### 強化の到達点（詳細は CHANGELOG）

- 歴代: Gen-3-O mcts(vs smart 93.5%) → 根本診断で「vs smart は強さの錯覚」 と判明 → **Gen-4-A tempoAI が mcts に ~55% で圧勝**（探索構造の変更＝自分の手番をターン内完全読み）→ Gen-4-B（レイテンシ有界化）→ **Gen-4-C（lookahead=1 + Web Worker）= 現状最強**。
- 天井: 葉（評価）の改善は全 parity、 horizon は lookahead=1 が sweet spot（=2 以上は頭打ち）。 残るレバーは人間棋譜の模倣（凍結中）のみ。

### NN（AlphaZero）路線 — 対象外（実証済みの行き止まり）

分岐因子 5.1 と小さく priors は無効、 hand-eval に value も priors も勝てない（az-v1〜v10 最高 vs smart 8%、 価値学習 v1/v2/残差も parity-下）。 NN 基盤（`src/ai/neuralAI.ts` + `@tensorflow/tfjs` 動的 import + GPU 環境）はコードに残るが**使用しない**。 GPU セットアップは `docs/GPU_SETUP.md`、 経緯・数値は CHANGELOG（Gen-3-K* / Gen-3-S / 根本診断）参照。

---

## 進化サイクルの始め方

唯一の AI 進化スキル: `.claude/skills/evolve-meteo-ai-handwritten/SKILL.md`（現 tempoFast の探索・評価の改善を 1 イテレーション進める。NN は対象外）。

- **1 イテレーション = 1 仮説**
- **Step 0: ルール変更チェック必須**
- 物差しは **smart 非依存**（候補 vs 現状最強 + Elo）。結果は `ai/CHANGELOG.md` に追記

---

## ロードマップ

| フェーズ | 内容 | 状態 |
|---|---|---|
| 0 | 学習基盤（決定論 RNG・encoding・行動空間・self-play / bench CLI） | **完了 (Gen-0)** |
| 1 | IS-MCTS（randomAI を rollout policy として利用） | **完了 (Gen-1)**：vs smart 56% |
| 1-B | IS-MCTS の leaf 評価関数化（`evaluateState` を tanh 圧縮）| **完了 (Gen-2)**：vs smart 83.5% |
| 2 | 評価関数の重み自動チューニング + 探索ハイパラ grid | **完了 (Gen-3-B〜O)**：vs smart 93.5% |
| 3 | AlphaZero 風 / ハイブリッド NN | **棄却 (Gen-3-S)**：分岐因子 5.1 で priors 無効、 NN は本 game と相性が悪い |
| 3-診断 | 「vs smart は強さの錯覚」 を実証 | **完了**：物差しを smart 非依存に移行 |
| 3-X | smart 非依存ベンチ確立 + `chainReadyMult=10` 採用 | 完了（後に tempo に置換）：vs baseline mcts 33.3% |
| **4-A** | **tempoAI（ターン内完全読み + テンポ評価）** | **完了・ブラウザ反映**：vs Gen-3-X mcts ~55%。 多ターン連鎖計画を探索構造で実現＝「葉の天井」 突破 |
| **4-B** | レイテンシ有界化（時間予算 + 反復深化 + αβ + 置換表）| **完了・反映**：最悪 21s→1s、 強さは Gen-4-A 同等 |
| **4-C** | **lookahead=1（horizon）+ Web Worker** | **完了・反映＝現状最強**：現 tempo に +8pt(33%)。 lookahead=2 以上・opp=tempo・NN は頭打ち＝探索アプローチ天井 |
| **Gen-5** | ルール変更（山札 120 枚化）+ 重み再調整 | **完了**：現重み据置（parity, 各色 20% の分布不変）。 Gen-4-C を 120 枚で再検証・反映継続 |
| Gen-6 | 終盤適応先読み(A) + 思考予算増(B) | **完了**：A 不発(終盤 LA=2 も配置探索を削り parity〜微悪)・B parity(budget2000 も n=400 で 27.8%)。据置＝探索アプローチ天井を再確認 |
| Gen-7 | ML顕微鏡で特徴量の穴探索＋材料報酬 | **完了**：行動可能な予測特徴は現評価が捕捉済み・材料も parity＝据置。残る本命は人間feedback / ギフト能動妨害 |
| Gen-8 | 深い探索＋大規模 ML value（GPU・配信制約外）| **完了**：深い探索/MCTS/学習value すべて tempo LA=1 未満。自己対戦の勝敗は本質的に予測困難＝評価改善の余地が原理的に小さいと判明。実験フックは revert 済み |
| 5 | 人間棋譜の模倣学習（self-play 天井を上位教師で破る）| 未着手・凍結中。 要対局記録 |

---

## ファイル構成

```
ai/
  README.md           このファイル
  CHANGELOG.md        AI 各世代の変更と評価結果（最新は冒頭）
  tsconfig.json       Node.js 実行用 TS 設定
  scripts/
    bench-self.ts     候補 vs baseline の smart 非依存ベンチ（現・主物差し）
    _fast_bench.ts    tempoFast 系の強度ベンチ
    _la_bench.ts      lookahead / 相手モデルの比較ベンチ
    elo-ladder.ts     全 AI 総当たり Elo（物差し補強・intransitivity 検出）
    _runner.ts        共通 playOneGame / playOneGameWithDeciders
    _combo-stats.ts   連鎖統計、 stats.ts  Wilson CI 等
    bench.ts / selfplay.ts / tune-es.ts          旧（vs smart 時代・参考）
    bench-neural.ts / nn/                         NN 系（対象外・旧）
  data/ models/       自己対戦ログ・学習出力（gitignore）
src/ai/
  index.ts            ブラウザ既定 decideAction を export（現 tempoFastAI）
  tempoFastAI.ts      現状最強（Gen-4-C: lookahead=1 + 時間予算 + 置換表）
  tempoAI.ts          Gen-4-A（無制限探索版・比較ベースライン）
  aiWorker.ts         CPU AI を Web Worker で実行（UI 非ブロック）
  evaluator.ts        評価関数 evaluateState + DEFAULT_WEIGHTS（chainReadyMult=10）
  smartAI / mctsAI / randomAI / chainRushAI       旧・補助戦略
  neuralAI.ts         NN 系（対象外・未使用）
```

ゲームロジックは `src/game/` を直接 import します（学習環境と本番環境を完全に一致させるため）。

---

## よく使うコマンド（物差しは smart 非依存）

```bash
# 偏りチェック / 候補 vs 現状最強（公平基準 25%・Wilson CI）
npx tsx ai/scripts/_fast_bench.ts --base tempo --budget 1000 --games 48 --seed 31001

# lookahead / 相手モデルの比較（候補 vs baseline、両者同 budget）
npx tsx ai/scripts/_la_bench.ts --budget 1000 --lookahead 1 --opp smart --base-lookahead 0 --games 150 --seed 31001

# 評価重み候補 vs baseline mcts（chainReadyMult 等の検証）
npx tsx ai/scripts/bench-self.ts --cand '{"chainReadyMult":10}' --games 150 --seed 8001

# 全 AI 総当たり Elo（相対強度・intransitivity 検出）
npx tsx ai/scripts/elo-ladder.ts --ais random,smart,mctsGen3X,tempo50 --games 0 --mixed --mixed-games 12 --json
```

⚠️ **vs-smart ベンチ**（`bench.ts --strategies mcts,smart,smart,smart`）は smart と評価関数が盲点を共有し検出力がないため**使わない**（根本診断参照）。NN 学習コマンドは対象外（旧情報は CHANGELOG / `docs/GPU_SETUP.md`）。

---

## 詳細ドキュメント

- **進化サイクルの手順**: `.claude/skills/evolve-meteo-ai-handwritten/SKILL.md`（唯一の AI 進化スキル）
- **全試行履歴と結果**: `ai/CHANGELOG.md`（最新が冒頭）
- **GPU セットアップ手順**（NN・対象外）: `docs/GPU_SETUP.md`
- **ゲームルール**: `docs/RULES.md`

---

## 試行履歴の要約（不採用も含む）

採用された改善は **太字**、不採用は ~~取り消し線~~。詳細は CHANGELOG 参照。

| Gen | 内容 | 結果 |
|---|---|---|
| **Gen-0〜2** | 学習基盤 / IS-MCTS / leaf 評価関数化 | vs smart 56%→83.5% ← ブラウザ反映 |
| **Gen-3-B〜F** | (1+1)-ES 重み tune | vs smart 89.5%、 1 手 2.10 ms ← 反映 |
| ~~Gen-3-C/E/G〜I~~ | PUCT / 特徴量追加 / gift 改善 | 不採用（短期 prior 悪手・過学習・MCTS 構造限界）|
| **Gen-3-J** | per-AI weights 構造 | API 採用、 DEFAULT 据置 |
| **Gen-3-K1〜K6 / az-v7** | AlphaZero パイプライン基盤 + 学習 | az-v7 が NN 系最強でも vs smart **8%**、 ブラウザ未達 |
| ~~az-v8/v9/v10~~ | virtual loss / tau / 再学習 | 改善せず、 不採用 |
| **Gen-3-L〜O** | uctC × iter grid | vs smart **93.5%** (Gen-3-O) ← 反映、 当時最強 |
| ~~Gen-3-M/N/P/Q/S/T/U~~ | grid / ES / 終局評価 / 非線形化 | 不採用。**手書き評価（葉）の重み tune は Gen-3-O が天井**（※ horizon は別軸 — Gen-4 で突破）|
| 3-診断 | 「vs smart は強さの錯覚」 実証 | mcts は size3 連鎖 88%・size5 0.1%、 物差しが盲点共有 → smart 非依存ベンチへ |
| **Gen-3-X** | smart 非依存ベンチ + chainReadyMult=10 | vs baseline mcts 33.3% ← 反映（後に tempo に置換）|
| **Gen-4-A** | **tempoAI（ターン内完全読み + テンポ評価）** | vs Gen-3-X mcts ~55% ← 反映。 探索構造の変更で「葉の天井」 を突破 |
| **Gen-4-B** | 時間予算 + 反復深化 + αβ + 置換表 | 強さ同等・最悪 21s→1s ← 反映 |
| **Gen-4-C** | **lookahead=1 + Web Worker** | 現 tempo に +8pt(33%) ← 反映・**現状最強** |
| ~~Gen-4 探索ラウンド~~ | LA=2 / opp=tempo / 学習価値 v1·v2·残差 / ギフト / 重み再tune | いずれも parity-下、 不採用＝**探索アプローチ天井**（CHANGELOG 参照）|
| **Gen-5** | ルール変更（山札 120 枚化）+ 重み再調整 | 現重み据置（parity, 3 seed×2 horizon）＝AI 不変、 Gen-4-C 継続 |
| ~~Gen-6~~ | 終盤適応先読み(A) / 思考予算増 budget2000(B) | A 不発・B parity(n=400, 27.8%)＝据置。探索系の主要レバー出尽くし |
| ~~Gen-7~~ | ML顕微鏡で特徴量の穴探索＋材料報酬 | 行動可能な予測特徴は現評価が捕捉済み・材料も parity＝据置。自己対戦観測上の天井を独立に裏付け |
| ~~Gen-8~~ | 深い探索/MCTS@2万/大規模 value ネット(GPU, 配信制約外) | 全て tempo LA=1 に及ばず（多く有意に下回る）。ネットは勝者予測で手書き超える(0.325 vs 0.253)が葉では壊滅(0%)＝据置 |
