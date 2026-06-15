# AI 学習・評価基盤

このディレクトリは「星を放つ夜」CPU AI の学習・評価に関するコード/データを置く場所です。
ブラウザバンドルには含めません（Vite は `src/` のみをエントリにします）。

---

## 現状（コンテキスト復元用サマリ）

> 新セッション開始時は、まずこのセクションと `ai/CHANGELOG.md` の最新エントリを読めば現状把握できます。

### ブラウザに反映されている CPU
- **戦略**: **GRM（目標到達確率最大化法・第3路線、2026-06-11 採用）**＝学習も手書き評価関数も使わない確率プランナー（仕様 `ai/REACHABILITY.md`・目的と物差し `ai/OBJECTIVE.md`）。内側 q（発火後連鎖の厳密確率）＋外側 T̂（G 到達期待ターン数＝多色レース厳密閉形式の解析推定、tstar v1 移植）。`src/ai/index.ts` が**配信構成固定の wrapper** を export（`GRM_BROWSER_OPTIONS` = V=20 / **P\*=0.45**（`GRM_P_STAR` 1 定数・2026-06-12 更新）/ K=6 / timeBudgetMs=3000）。UI に CPU 慎重モード (P=1) トグルあり
- **強さ（公平25%）**: **fresh 事前登録テスト 34.13%（CI 30.92-37.48）＝旧既定 tempoChain（3席）に有意勝ち**・同条件 P=0.5 対照 28.25% を +5.9pt・**L2 逸脱テストで self-play 不動点を確認（P\* 軸＝第1回・K 軸＝第2回 2026-06-14。K=8 を fresh n=800 で 26.13%（CI 23.20-29.28）＝parity と確証し K=6 を不動点確定。K はレイテンシにほぼ中立）**。無予算逸脱者は +6.9pt 勝つ＝**時間予算の残コスト ~7pt**（回収経路は実分布対応 C2・LA1。「予算を外す」は無予算 max 106 分で不可と実測済み）
- ⚠️ **レイテンシ**: 時間予算 3000ms の anytime 設計（期限超過は劣化先 `degradeEstimate` へ設計劣化、`budgetStats()` で追跡可）＋予算のチャネル公平化＋**ゼロ損失×2（memo キーのビットパック・連鎖解決の Color[][] 直実装＝全着手一致で証明）**＝1手 p50 1ms / p90 1.5s / max ~8.9s（贈与バッチ同時最適化の仕掛かり分）・**劣化率 7-8%**。**Web Worker(`src/ai/aiWorker.ts`)で off-main-thread 実行**（例外は握りつぶさず error イベント→同期再実行で顕在化。フォールバック時は最悪数秒ブロックしうる）
- 旧既定 **tempoChainAI（Gen-15）** は存置（`index.ts` の export を戻せば即復帰）。教訓: 採用判定は基準を事前宣言し完全未使用 seed で 1 回だけ測る
- ⚠️ vs smart は盲点を共有して測れない。**物差しは `ai/OBJECTIVE.md` の序列（2026-06-12 方針確立: 目的＝ゲーム理論的最適＝対称 ε-ナッシュ）**: L1 単独決定理論の厳密性（q 厳密・T̂ の順位保存率）/ L2 家族内 self-play 不動点（逸脱テスト: 候補パラメータ 1 席 vs 現行 3 席）/ L3 家族外挑戦（新ライン vs 現 champion + Wilson CI）。**人間体感は盲点発見ソースであり最適性の基準ではない**。旧既定 tempoChain への勝率は回帰用参考値に格下げ
- **旧採用版**: Gen-4-C(tempoFast LA=1, 1手~1s, horizon で葉の天井を突破)→ Gen-4-B(LA=0)→ Gen-4-A(tempoAI 無制限, 21s 裾)→ Gen-3-X mcts。いずれも現在は**ブラウザ未使用のベンチ用ベースライン**
- **未解決（探索アプローチは天井）**: 葉も horizon も尽きた。horizon=1 で一度突破したが lookahead=2（@1000 20%/@2500 14.6%）・opp=tempo（16.7%）・終盤適応LA・budget2000（Gen-6, n=400 で 27.8% parity）はいずれも LA=1/budget1000 を超えず＝**lookahead=1 + budget1000 が sweet spot**。NN 近似も前提 refuted。**ML 駆動の特徴発掘(Gen-7)も「自己対戦で観測可能な実用特徴は現評価が捕捉済み」を裏付け**（材料報酬含め parity、最強の新シグナル「席順」は行動不能な定数）。**Gen-8 で配信制約を外し深い探索・MCTS@2万・大規模 value ネット(GPU)も投入したが全て tempo LA=1 に及ばず**（多くは有意に下回る。value ネットは勝者予測では手書きを上回る(0.325 vs 0.253)が、ノイジーで探索の葉にすると壊滅＝0%）。根本機序＝均衡した自己対戦では勝敗が本質的に予測困難で評価改善の余地が原理的に小さい。**ギフト能動妨害(Gen-9)も評価ベース最適化で n=360 parity**（ギフトは稀＋smartAI の harm 最小化が既に good）。**自己対戦で測れる全レバーが出尽くした**（と Gen-9 時点では結論）。**→ Gen-15 で覆る**: 人間戦略を構成化した目的志向ポリシー tempoChain（genome 最適化）が tempoFast LA=1 に有意勝ち＝「点火閾値・配置方針(buildTempoBlend)」という新レバーが効いた。残る本命は genome のさらなる探索 or 人間データ量拡大（詳細 CHANGELOG Gen-15）。**Gen-16 で「tempoChain への LA 付与」も検証＝dead-end**: 配置仲裁の 1 ターン先読みは fresh 2seed×5000局で 26.1%/25.6%（採用基準未達＝parity〜+1pt 弱）、小発火候補は 15-20% と有意悪化（1ターン地平は即時小得点を過大評価し「無駄撃ちしない」規律を侵食）＝計算量レバーは一巡 dead-end
- 🔄 **ゲーム設定 (2026-06-03)**: 山札 **120 枚（各色 24）**（旧 100 枚）。Gen-5 で重み再調整したが **現重み（chainReadyMult=10 / tempoChainW=50）が最適＝parity**（各色 20% の分布は 100 枚時と不変で最適点が動かない）。AI は山札サイズ非依存のため Gen-4-C 据置

### 試行中の方向性

| 方向 | 現状 | スキル |
|---|---|---|
| AI 進化（手書き探索/評価 + 目的志向 genome。現 tempoChain Gen-15）| 葉も horizon も天井だったが、**Gen-15 で genome 最適化が突破**（人間戦略を構成化した目的志向ポリシー＋実カスケード評価が tempoFast LA=1 に 32.7%/CI 27.6-38.2 で有意勝ち）。**Gen-16 で lookahead 付与は parity と判明（不採用）**。次の実験候補: genome のさらなる探索／人間データ量拡大 | `evolve-meteo-ai-handwritten`（唯一の AI 進化スキル）|
| GRM（目標到達確率最大化法。第3路線＝学習も手書き評価も使わない確率プランナー）| **配信中（現ブラウザ既定）**。P\*=0.45（fresh 34.13%・L2 不動点確認・2026-06-12）。**K=6 も L2 不動点として確証**（K 軸第2回 2026-06-14。K=8 fresh n=800 で 26.13%＝parity）。ゼロ損失×2 で劣化率 7-8%・p50 1ms。残る伸びしろ＝予算の残コスト ~7pt（無予算逸脱者 +6.9pt で実証）で、回収経路は**実分布対応 C2**（一様 i.i.d. 版は対戦不採用＝分布ずれが本丸と確定）と **LA1**（h 葉＋深さ1展開、tstar 実証→meteo 実験中）。残る L2 対象＝ギフト配り族・deck15（速度ブロック中）。q テーブルは不成立確定。**読み合い（相手進捗の先読み race-read）も parity 見送り**（160局25.0%・発動1.4%・計算量は無コスト、2026-06-15。深い相手読みは予算崩壊＋設計原理に反す＝GRM の伸びしろでない） | スキル無し。仕様 `ai/REACHABILITY.md`・目的 `ai/OBJECTIVE.md`・台帳 `ai/SPEED-PLAN.md`/`ai/TSTAR-DEPS.md` |
| ~~NN AI（AlphaZero 風）~~ | **対象外＝実証済みの行き止まり**: branching 5.1 で priors 無効、hand-eval に value/priors とも勝てず az-v1〜v10 + 価値学習 v1/v2 が全敗。スキル `evolve-meteo-ai-neural` は削除（経緯は CHANGELOG） | （削除済み）|

### 強化の到達点（詳細は CHANGELOG）

- 歴代: Gen-3-O mcts(vs smart 93.5%) → 根本診断で「vs smart は強さの錯覚」 と判明 → **Gen-4-A tempoAI が mcts に ~55% で圧勝**（探索構造の変更＝自分の手番をターン内完全読み）→ Gen-4-B（レイテンシ有界化）→ Gen-4-C（lookahead=1 + Web Worker, 探索系の天井）→ **Gen-15 tempoChain（genome 最適化）= 現状最強・ブラウザ反映**。
- かつての天井（Gen-9「自己対戦で測れる全レバー出尽くし・残るは人間模倣のみ」）は **Gen-15 で破った**: 人間戦略「溜めて1ターン5連鎖・小連鎖は撃たない」を genome（点火閾値・構築テンポ混合 buildTempoBlend）で構成化し、grid 400候補の最適化勝者(idx340: fire=5/blend=0.5)が tempoFast LA=1 に有意勝ち（32.7%, CI 27.6-38.2）。葉の重み tune や horizon 深掘りとは別軸（目的志向ポリシー＋実カスケード評価）が効いた。次は genome のさらなる探索 or 人間データ量拡大。

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
| **4-C** | **lookahead=1（horizon）+ Web Worker** | **完了・反映（Gen-15 まで現状最強）**：現 tempo に +8pt(33%)。 lookahead=2 以上・opp=tempo・NN は頭打ち＝探索アプローチ天井 |
| **Gen-5** | ルール変更（山札 120 枚化）+ 重み再調整 | **完了**：現重み据置（parity, 各色 20% の分布不変）。 Gen-4-C を 120 枚で再検証・反映継続 |
| Gen-6 | 終盤適応先読み(A) + 思考予算増(B) | **完了**：A 不発(終盤 LA=2 も配置探索を削り parity〜微悪)・B parity(budget2000 も n=400 で 27.8%)。据置＝探索アプローチ天井を再確認 |
| Gen-7 | ML顕微鏡で特徴量の穴探索＋材料報酬 | **完了**：行動可能な予測特徴は現評価が捕捉済み・材料も parity＝据置。残る本命は人間feedback / ギフト能動妨害 |
| Gen-8 | 深い探索＋大規模 ML value（GPU・配信制約外）| **完了**：深い探索/MCTS/学習value すべて tempo LA=1 未満。自己対戦の勝敗は本質的に予測困難＝評価改善の余地が原理的に小さいと判明。実験フックは revert 済み |
| Gen-9 | ギフト能動妨害（評価ベースのギフト最適化）| **完了**：n=360 で 25.3% parity＝据置。自己対戦で測れる全レバー出尽くし。残るは人間 feedback のみ |
| Gen-10〜14 | 局面適応/選択的深化/人間模倣prior/分散削減/葉formation/ES重み進化/build policy/人間BC | **完了**：いずれも self-play parity or 実プレイ崩壊。「自己対戦は天井・人間データ律速」を多角確認（詳細 CHANGELOG）|
| **Gen-15** | **目的志向 genome の grid 最適化（tempoChainAI: 点火閾値+構築テンポ混合 blend）** | **完了・採用・ブラウザ反映＝現状最強**：grid 400候補の勝者(idx340: fire=5/blend=0.5)が tempoFast LA=0 2seed×1000局 29.9%・LA=1 300局 32.7%(CI27.6-38.2)で有意勝ち。**Gen-9 の天井を突破** |
| Gen-16 | tempoChain への 1 ターン先読み（race-timing）付与 | **完了・不採用**：配置仲裁 LA は fresh 2seed×5000局 26.1%/25.6%（CI下限>25% 未達＝+1pt 弱）。小発火候補は 15-20% と有意悪化＝発火は固定規律が強い。計算量レバーは一巡 dead-end |
| 5 | 人間棋譜の模倣学習（self-play 天井を上位教師で破る）| 未着手・凍結中。 要対局記録 |

---

## ファイル構成

```
ai/
  README.md           このファイル
  CHANGELOG.md        AI 各世代の変更と評価結果（最新は冒頭）
  REACHABILITY.md     GRM（目標到達確率最大化法・第3路線）の設計仕様書
  TSTAR.md            GRM 外側 T̂ の研究対象 T*（最適期待到達ターン数）の自己完結な数学的仕様
  TSTAR-DEPS.md       tstar リポジトリ依存事項・研究への要望の台帳（C2 導入条件・q テーブル等）
  SPEED-PLAN.md       GRM 速度×強さ改善のローカル手法台帳（予算公平化・キー数値化等と採用規律）
  tsconfig.json       Node.js 実行用 TS 設定
  scripts/
    bench-self.ts     候補 vs baseline の smart 非依存ベンチ（現・主物差し）
    _fast_bench.ts    tempoFast 系の強度ベンチ
    _la_bench.ts      lookahead / 相手モデルの比較ベンチ
    elo-ladder.ts     全 AI 総当たり Elo（物差し補強・intransitivity 検出）
    _runner.ts        共通 playOneGame / playOneGameWithDeciders
    _combo-stats.ts   連鎖統計、 stats.ts  Wilson CI 等
    bench-grm.ts / sweep-grm-p.ts   GRM の対戦ベンチ・P 掃引（--base fast|chain で旧/現 champion を切替）
    _grm_latency_probe.ts           GRM の 1 手レイテンシ分布（p50/p90/p99/max・フェーズ別）の実測
    _tstar-bench.ts   GRM 外側 T̂ の精度ベンチ（小盤面の厳密 T* を値反復で解いて比較）
    _grm-ml-*.ts      T̂ の教師あり学習実験（結論: 非有望・凍結。CHANGELOG 参照）
    bench.ts / selfplay.ts / tune-es.ts          旧（vs smart 時代・参考）
    bench-neural.ts / nn/                         NN 系（対象外・旧）
  data/ models/       自己対戦ログ・学習出力（gitignore）
src/ai/
  index.ts            ブラウザ既定 decideAction を export（現 tempoChainAI, Gen-15）
  tempoChainAI.ts     現状最強（Gen-15: 目的志向 genome ポリシー。DEFAULT_GENOME=idx340: fire=5/blend=0.5/nodeLimit=15000）
  cascade.ts          実カスケード評価 maxChainFrom/bestChainMove（tempoChain の点火判定。段違い対応・置換表）
  tempoFastAI.ts      旧採用版（Gen-4-C: lookahead=1 + 時間予算 + 置換表。現ベンチ用ベースライン）
  tempoAI.ts          Gen-4-A（無制限探索版・比較ベースライン）
  grmAI.ts            GRM のプレイ可能 CPU（第3路線。ブラウザ未接続。仕様 ai/REACHABILITY.md）
  grmReachQ.ts        GRM 内側関数 q（発火後連鎖サブゲームの厳密解）
  __tests__/          grmReachQ / grmAI の vitest（実エンジンを使う独立オラクルと照合）
  aiWorker.ts         CPU AI を Web Worker で実行（UI 非ブロック）
  evaluator.ts        評価関数 evaluateState + DEFAULT_WEIGHTS（chainReadyMult=10。tempoChain の構築テンポ項にも使用）
  smartAI / mctsAI / randomAI / chainRushAI       補助/ベンチ戦略（smartAI は tempoChain のギフト委譲で現役）
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
- **GRM（第3路線）の設計仕様**: `ai/REACHABILITY.md`
- **T*（期待到達ターン数）の数学的仕様**（近似研究の切り出し用・自己完結）: `ai/TSTAR.md`
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
| **Gen-4-C** | **lookahead=1 + Web Worker** | 現 tempo に +8pt(33%) ← 反映（Gen-15 まで現状最強）|
| ~~Gen-4 探索ラウンド~~ | LA=2 / opp=tempo / 学習価値 v1·v2·残差 / ギフト / 重み再tune | いずれも parity-下、 不採用＝**探索アプローチ天井**（CHANGELOG 参照）|
| **Gen-5** | ルール変更（山札 120 枚化）+ 重み再調整 | 現重み据置（parity, 3 seed×2 horizon）＝AI 不変、 Gen-4-C 継続 |
| ~~Gen-6~~ | 終盤適応先読み(A) / 思考予算増 budget2000(B) | A 不発・B parity(n=400, 27.8%)＝据置。探索系の主要レバー出尽くし |
| ~~Gen-7~~ | ML顕微鏡で特徴量の穴探索＋材料報酬 | 行動可能な予測特徴は現評価が捕捉済み・材料も parity＝据置。自己対戦観測上の天井を独立に裏付け |
| ~~Gen-8~~ | 深い探索/MCTS@2万/大規模 value ネット(GPU, 配信制約外) | 全て tempo LA=1 に及ばず（多く有意に下回る）。ネットは勝者予測で手書き超える(0.325 vs 0.253)が葉では壊滅(0%)＝据置 |
| ~~Gen-9~~ | ギフト能動妨害（評価ベースのギフト最適化）| n=360 で 25.3% parity（n=120 の 30% は seed 運）＝据置。ギフト稀＋smart の harm 最小化が既に good |
| ~~Gen-10〜14~~ | 局面適応/選択的深化/人間prior/分散削減/葉formation/ES/build policy/人間BC | 全て parity or 実プレイ崩壊。self-play 天井・人間データ律速を多角確認（詳細 CHANGELOG）|
| **Gen-15** | **目的志向 genome の grid 最適化（tempoChainAI）** | grid 勝者 idx340(fire=5/blend=0.5) が tempoFast LA=1 に 32.7%(CI27.6-38.2) ← **採用・ブラウザ反映・現状最強**。Gen-9 の天井を突破 |
