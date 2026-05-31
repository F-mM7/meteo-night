# AI 学習・評価基盤

このディレクトリは「星を放つ夜」CPU AI の学習・評価に関するコード/データを置く場所です。
ブラウザバンドルには含めません（Vite は `src/` のみをエントリにします）。

---

## 現状（コンテキスト復元用サマリ）

> 新セッション開始時は、まずこのセクションと `ai/CHANGELOG.md` の最新エントリを読めば現状把握できます。

### ブラウザに反映されている CPU
- **戦略**: tempoAI（Gen-4-A: 自分の手番をターン内完全読み + テンポ評価）。 `src/ai/index.ts` で `decideAction` を tempoAI に切替済み
- **要点**: 平均合法手数 5.1 の低分岐を活かし、 2 枚の配置順・配置先・連鎖シーケンスを DFS で完全展開してターン終了時の盤面価値を最大化。 leaf は `evaluateState`（Gen-3-X 重み）+ 複数色チェイン準備度（`tempoChainW=50`、 near² 非線形）
- **強さ（smart 非依存）**: 候補 tempo vs baseline mcts(Gen-3-X) で勝率 **55.3%**（seed 8001/9001 とも、 各 150 局、 Wilson CI 下限 47.3% > 公平基準 25%）→ 現状最強の手書き mcts に有意勝ち。 w=45/60 も ~55% で同等、 w=50 は seed に最も頑健
- ⚠️ vs smart は盲点を共有して測れない。 物差しは `bench-self.ts`（候補 vs baseline mcts）
- ⚠️ **1 手あたり時間（メインスレッド同期）**: 中央値 1.7ms だが連鎖局面で重い裾（p95 767ms / p99 3.4s / 最大 ~21s、 約 6.7% が ≥500ms）。 体感に問題があれば time-budget か Web Worker 化が必要（現状未対応）
- **baseline（置換された旧採用版）**: Gen-3-X = Gen-3-O mcts(`uctC=1.7 / iter=800`) + `chainReadyMult=10`。 vs Gen-3-O で 33.3%、 1 手 ~5.7 ms
- **未解決**: 人間との実力差・レイテンシ裾。 多ターン連鎖計画（`lookaheadTurns>0` は計算重く未実用）と off-main-thread 化が次の課題

### 試行中の方向性

| 方向 | 現状 | スキル |
|---|---|---|
| 手書き AI 改善（evaluator 重み / mcts ハイパラ / ヒューリスティック）| 重み/ハイパラ tune は **Gen-3-O が天井 (93.5%)**（smart fitness=天井 (Q)・self-play fitness=vs smart 退行 (S)）。 **構造的変更 = tempoAI（Gen-4-A, ターン内完全読み）で突破**し Gen-3-X mcts に ~55%（採用・ブラウザ反映） | `evolve-meteo-ai-handwritten` |
| NN AI（AlphaZero 風）| 基盤・パイプライン完成（K1〜K4）、最強モデル az-v7 は vs smart 8% でブラウザ未到達 | `evolve-meteo-ai-neural` |

### NN 系の最強モデル
- **az-v7**（vs smart x3 で勝率 **8%**、avgScore 5.38、 1 手 ~8 ms）
- 学習設定: K6 (mean-field 解消) + 5000 games AlphaZero (batch=16)
- ブラウザ反映なし（Gen-3-F に届かないため）

### 新方向: 最強 AI（93.5% 超え）を目指す路線（2026-05-28〜）

手書き AI は Gen-3-O (93.5%) でグリッドサーチ系の伸び代をほぼ使い切った。 残る本命は NN priors:

- **A 路線（評価関数 feature 追加, Gen-3-R）**: 4 新 feature を追加したが、 別セッションの Gen-3-Q（21 次元 ES）でも私の ES でも不採用。 既存 17 weights と役割が重複し効果なし
- **B 路線（ハイブリッド NN, Gen-3-S）**: policy-only NN + Gen-3-F leaf value。 **検証完了 → 低天井で棄却**
  - 未学習 52% → 蒸留後 55%（CI 重複、 有意改善なし）。 mctsAI 93.5% に遠く及ばず
  - 原因（実測確定）: **平均合法手数 5.1**（`_branching-factor.ts`）と小さく、 mctsAI の UCT1+全手展開で十分尽くせる。 NN prior は囲碁級の高分岐ゲームでこそ効くもので本 game では出番がない
  - 副産物: batch 探索バグ発見（K11/K12 の speedup 結論を無効化）、 ブラウザ側 neuralAI も policy-only 対応済み
- C 路線（純粋 AlphaZero / 新 architecture）: 同じ理由で ROI 低い

### 現時点の総括（最強 AI を目指す上での到達点）

- **最強は heuristic mctsAI (Gen-3-O, 93.5%)**。 NN は priors（Gen-3-S）も value（az-v1〜v10）も hand-tuned evaluator に勝てない
- 93.5% 超えの残レバー: ①非線形 leaf value、 ②ギフト選択フェーズ（構造的弱点）、 ③より深い探索（伸び代小）。 いずれも難度高
- NN 系は本 game の構造（低分岐 + 既に優秀な評価関数）と相性が悪いことが判明

### GPU 環境
- **ハードウェア**: NVIDIA RTX 4080 (16 GB VRAM)、 WSL2 経由で利用可
- **依存関係**: CUDA 11.8 runtime ライブラリ + cuDNN 8.9.2（インストール済み）→ 詳細は `docs/GPU_SETUP.md`
- **tfjs-node-gpu 4.22.0**: GPU 認識成功、 13.5 GB VRAM 利用可
- `ai/scripts/nn/{model,train,neuralMcts}.ts` は `@tensorflow/tfjs-node-gpu` を使用
- **Gen-3-K11 実装**: `--parallel-games N` で並列 self-play 実装（後に不要と判明）
- ⚠️ **Gen-3-K12 撤回（Gen-3-S）**: `--mcts-batch 100` の「1.5x speedup」 は **誤り**
  - `decideActionNeural` の batch 探索は batchSize が大きいと木を降りないバグがあった（`_verify-search.ts` で実証）
  - mcts-batch=100 が速かったのは探索が空回りしていたから。 正しい上限は **`--mcts-batch 8`**
  - プロファイルで NN predict の 3 ms 固定オーバーヘッドを発見したこと自体は有効
  - 開発中は `CUDA_VISIBLE_DEVICES=-1` で CPU 実行しても同等速度

### ブラウザ統合の準備状況（Gen-3-K9）

NN 学習の最強モデルが Gen-3-F に届いていないため、ブラウザ反映は保留中。
ただし「強いモデルができたら数手で反映できる」状態に整えてある:

| 構成要素 | 状態 | 場所 |
|---|---|---|
| `@tensorflow/tfjs`（ブラウザ版）依存 | 追加済み（dependencies） | `package.json` |
| `src/ai/neuralAI.ts` | 実装済み（NN-guided MCTS + 自動フォールバック） | tfjs.loadLayersModel 使用 |
| 動的 import 経路 | `loadNeuralAI(url)` を `src/ai/index.ts` から export | tfjs は別 chunk、 呼ばない限り main chunk に混入しない |
| placeholder モデル | `public/models/dummy/` に未学習版 (76 KB) 配置済み | 動作確認用 |
| `train.ts --copy-to-public` | 学習後の自動コピー対応 | `public/models/active/` 等にコピー可 |

**バンドルサイズ計測**（実測）:
- baseline（mctsAI のみ）: JS 239 KB / gzip 75 KB
- tfjs を main chunk に同梱した場合: JS 1.83 MB / gzip 327 KB
- 現状（動的 import）: baseline と同じ。 `loadNeuralAI()` 呼び出し時のみ別 chunk として lazy load

**強いモデル完成後の反映手順**:
1. `npx tsx ai/scripts/nn/train.ts ... --copy-to-public public/models/active`
2. UI 側（`App.tsx` / `useGameLogic.ts` 等）で `loadNeuralAI(\`${import.meta.env.BASE_URL}models/active/model.json\`)` を呼び、 得た `decideAction` を mctsAI の差し替えとして使う
3. ロード前 / 失敗時は内部で mctsAI にフォールバックするため、 UI の崩れは起きない

---

## 進化サイクルの始め方

進化サイクルは目的に応じてスキルを使い分けます。

```text
.claude/skills/
  evolve-meteo-ai-handwritten/SKILL.md    手書き AI（smart / mcts / evaluator）の改善
  evolve-meteo-ai-neural/SKILL.md         NN AI（AlphaZero）の学習・改善
```

両スキルとも:
- **1 イテレーション = 1 仮説**
- **Step 0: ルール変更チェック必須**
- 結果は `ai/CHANGELOG.md` に追記

---

## ロードマップ

| フェーズ | 内容 | 状態 |
|---|---|---|
| 0 | 学習基盤（決定論 RNG・encoding・行動空間・self-play / bench CLI） | **完了 (Gen-0)** |
| 1 | IS-MCTS（randomAI を rollout policy として利用） | **完了 (Gen-1)**：vs smart 56% |
| 1-B | IS-MCTS の leaf 評価関数化（`evaluateState` を tanh 圧縮）| **完了 (Gen-2)**：vs smart 83.5% |
| 2 | 評価関数の重み自動チューニング（(1+1)-ES） | **完了 (Gen-3-B〜F)**：vs smart 89.5% |
| 2-extra | per-AI weights 構造（mcts/smart で別重み）| **完了 (Gen-3-J)**：構造採用、 ブラウザ DEFAULT は据置 |
| 2-L | MCTS 探索ハイパラ `uctC` の grid 最適化 | **完了 (Gen-3-L)**：vs smart 92.0% |
| 2-O | `uctC × iter` joint 2D grid search | **完了 (Gen-3-O)**：vs smart 93.5% |
| 3 | AlphaZero 風 / ハイブリッド NN | **棄却 (Gen-3-S)**：分岐因子 5.1 で priors 無効、 NN は本 game と相性が悪い |
| 3-診断 | 「vs smart は強さの錯覚」 を実証 | **完了**：mcts は size3 連鎖 88%・size5 0.1%、 物差しが盲点を共有 |
| 3-X | **smart 非依存ベンチ確立 + `chainReadyMult=10` 採用** | **完了・ブラウザ反映**：vs baseline mcts 33.3% (>25%) で有意。 ただし改善は modest |
| 4 | 多ターン連鎖計画（人間との差を埋める本命）| 未着手。 静的評価では不足、 探索構造 or outcome 接地 value が要 |

---

## ファイル構成

```
ai/
  README.md           このファイル
  CHANGELOG.md        AI 各世代の変更と評価結果（最新は冒頭）
  tsconfig.json       Node.js 実行用 TS 設定
  scripts/
    selfplay.ts       指定戦略で N 局回し結果集計
    bench.ts          戦略を比較するベンチ（rotate / weights / mcts-weights 対応）
    bench-neural.ts   NN モデル vs 既存戦略のベンチ
    tune-es.ts        評価関数重みの (1+1)-ES チューナー
    _runner.ts        共通の playOneGame ロジック
    nn/
      model.ts        NN 定義 (createModel / saveModel / loadModel)
      dataset.ts      自己対戦データ生成 (mctsAI / neuralMcts)
      neuralMcts.ts   NN 誘導 MCTS（PUCT + NN prior/value）
      train.ts        AlphaZero ループ CLI (--selfplay mcts|neural)
      _smoke-gpu.ts   GPU 動作確認用スクリプト
  data/               自己対戦ログ・学習出力（gitignore）
  models/             学習済みモデル（gitignore）
```

ゲームロジックは `src/game/` を直接 import します（学習環境と本番環境を完全に一致させるため）。

---

## よく使うコマンド

### ベンチ（手書き AI 系）

```bash
# 自己対戦バランス確認
npx tsx ai/scripts/bench.ts --games 200 --strategies smart,smart,smart,smart --rotate --seed 1 --json

# 現状ブラウザ CPU の強さ確認
npx tsx ai/scripts/bench.ts --games 200 --strategies mcts,smart,smart,smart --rotate --seed 1001 --json

# JSON で得た重みを mcts のみに適用
npx tsx ai/scripts/bench.ts --mcts-weights ai/data/tuned-weights-gen3X.json \
  --games 200 --strategies mcts,smart,smart,smart --rotate --seed 1001 --json
```

### 評価関数重みの (1+1)-ES チューニング

```bash
npx tsx ai/scripts/tune-es.ts \
  --gens 15 --games 50 --seed 1 --sigma 0.2 \
  --init ai/data/tuned-weights-previous.json \
  --out ai/data/tuned-weights-new.json
```

### NN 学習（GPU で動作中、 CPU でも同じコマンドで動く）

```bash
export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}

# Warm-up: mctsAI 自己対戦
npx tsx ai/scripts/nn/train.ts --games 100 --iter 2 --batch 256 --epochs 3 --seed 1000 \
  --selfplay mcts --out ai/models/az-vN-warm

# AlphaZero ループ: neuralMcts 自己対戦 + 学習
npx tsx ai/scripts/nn/train.ts --games 200 --iter 5 --batch 256 --epochs 3 --seed 2000 \
  --selfplay neural --init ai/models/az-vN-warm --mcts-batch 16 \
  --out ai/models/az-vN

# Gen-3-S ハイブリッド蒸留: 強い mctsAI 自己対戦データで policy-only NN を学習
npx tsx ai/scripts/nn/train.ts --games 200 --iter 1 --batch 256 --epochs 15 --seed 60000 \
  --selfplay mcts --hybrid --hidden-units 256 --hidden-layers 3 \
  --out ai/models/hybrid-distill-v1
# 注: --mcts-batch は 8 以下に保つこと（大きいと探索が空回りする。 Gen-3-S 参照）
```

### NN モデルのベンチ

```bash
npx tsx ai/scripts/bench-neural.ts ai/models/az-vN \
  --opponent smart --games 50 --seed 1001 --silent --json
```

---

## 詳細ドキュメント

- **進化サイクルの手順**: `.claude/skills/evolve-meteo-ai-handwritten/SKILL.md` / `.claude/skills/evolve-meteo-ai-neural/SKILL.md`
- **全試行履歴と結果**: `ai/CHANGELOG.md`（最新が冒頭）
- **GPU セットアップ手順**: `docs/GPU_SETUP.md`
- **ゲームルール**: `docs/RULES.md`

---

## 試行履歴の要約（不採用も含む）

採用された改善は **太字**、不採用は ~~取り消し線~~。詳細は CHANGELOG 参照。

| Gen | 内容 | 結果 |
|---|---|---|
| **Gen-0** | 学習基盤構築 | 採用 |
| **Gen-1** | IS-MCTS + random rollout | vs smart 56% |
| **Gen-2** | leaf 評価関数化 | vs smart 83.5% ← ブラウザ反映 |
| ~~Gen-3-A~~ | iter 400→1000 | 飽和、不採用 |
| **Gen-3-B** | (1+1)-ES tune | vs smart 88.0% |
| **Gen-3-B-2** | warm-start ES | vs smart 89.0% |
| ~~Gen-3-C~~ | PUCT (progressive bias) | 短期 prior が悪手、不採用 -32.5pt |
| ~~Gen-3-E~~ | selfNearEnd 特徴量追加 | 過学習、不採用 |
| **Gen-3-F** | 本格 ES (100局/世代) | vs smart 89.5%、 1 手 2.10 ms ← ブラウザ反映 |
| ~~Gen-3-G/G-2/H/I~~ | gift selection 改善 4 連敗 | 全て不採用、MCTS の構造的限界 |
| **Gen-3-J** | per-AI weights 構造 | API 採用、 ブラウザ DEFAULT 据置 |
| **Gen-3-K1〜K3** | AlphaZero パイプライン基盤 | コード採用、 モデル未達 |
| **Gen-3-K4** | NN バッチ推論 (batch=16) | 学習速度 8x |
| ~~Gen-3-K5~~ | NN 容量増 (77K params) | underfit、 不採用 |
| ~~Gen-3-K6~~ | 多人数 value 出力 | 構造採用、 単独ではブラウザ未達 |
| **az-v7** | K6 + 5000 games | vs smart 8%、 NN 系最強 |
| ~~az-v8/v9~~ | virtual loss / tau 調整 | 大幅悪化、 不採用 |
| ~~az-v10~~ | 1 から再学習 (6500 games) | 改善せず、 不採用 |
| **Gen-3-L** | uctC grid search (√2 → 2.0) | vs smart 92.0% ← ブラウザ反映（後段 Gen-3-O で更新） |
| ~~Gen-3-M~~ | leafEvalScale grid search | 現状 1500 が grid 内ピーク、不採用 |
| ~~Gen-3-N~~ | iterations grid 再評価 (uctC=2.0 で) | 現状 400 が grid 内ピーク、不採用（coordinate-descent 解として確認） |
| **Gen-3-O** | uctC × iter joint 2D grid | `(uctC, iter) = (1.7, 800)` で coordinate-descent 解を突破、 vs smart **93.5%** (CI 89.2-96.2%) ← **ブラウザ反映、現状最強** |
| ~~Gen-3-P~~ | uctC × leafEvalScale joint 2D grid | `(1.7, 1500)` が依然 grid 内ピーク、不採用。`leafEvalScale=1500` は他軸に依存しないロバスト値 |
| ~~Gen-3-Q~~ | 21 次元 ES tune（新 4 特徴量 + 既存 17）| 17 世代 sigma 早期収束、best = default。smart x3 fitness は天井（98%, avgScore 22.24）、 新特徴量は smart 相手では検出不能 |
| ~~Gen-3-S~~ | mcts 自己対戦 fitness で 21 次元 ES | self-play では改善（+1.88 avgScore、新特徴量も非ゼロ化）も vs smart で -4.5〜-5pt 退行、不採用。Gen-3-J 現象（self-play 最適 ≠ vs smart 最適）を再確認 |
| ~~Gen-3-T~~ | 終局評価を純粋勝敗(winLoss)化 | vs smart も head-to-head も中立（改善なし）、不採用。終局評価は到達頻度が低く実質無関係、「得点重視」是正の効きどころは途中評価の非線形化と判明 |
| ~~Gen-3-U~~ | 自己得点項の非線形化（凸/凹 grid）| 線形(0)が両方向のピーク、不採用。現状の評価は得点差+tanh飽和で既に勝利位置を表現済み。手書き AI は Gen-3-O が実質天井と確定 |
