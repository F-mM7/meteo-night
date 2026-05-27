# AI 学習・評価基盤

このディレクトリは「星を放つ夜」CPU AI の学習・評価に関するコード/データを置く場所です。
ブラウザバンドルには含めません（Vite は `src/` のみをエントリにします）。

---

## 現状（コンテキスト復元用サマリ）

> 新セッション開始時は、まずこのセクションと `ai/CHANGELOG.md` の最新エントリを読めば現状把握できます。

### ブラウザに反映されている CPU
- **戦略**: mctsAI (IS-MCTS + leaf 評価関数)
- **重み**: Gen-3-F（`src/ai/evaluator.ts` の `DEFAULT_WEIGHTS`）
- **探索ハイパラ**: `DEFAULT_UCT_C = 2.0`（Gen-3-L、 grid search で √2 → 2.0 に調整）
- **強さ**: vs smart x3 で勝率 **92.0%** (95%CI 87.4-95.0%、 200 局, rotate, seed=1001)
- **1 手あたり時間**: 約 2.3 ms（CPU 計測）

### 試行中の方向性

| 方向 | 現状 | スキル |
|---|---|---|
| 手書き AI 改善（evaluator 重み / mcts ハイパラ / ヒューリスティック）| Gen-3-L で +2pt 改善（uctC 最適化）、 残伸び代は leafEvalScale 等の未調整ハイパラと iter 再評価 | `evolve-meteo-ai-handwritten` |
| NN AI（AlphaZero 風）| 基盤・パイプライン完成（K1〜K4）、最強モデル az-v7 は vs smart 8% でブラウザ未到達 | `evolve-meteo-ai-neural` |

### NN 系の最強モデル
- **az-v7**（vs smart x3 で勝率 **8%**、avgScore 5.38、 1 手 ~8 ms）
- 学習設定: K6 (mean-field 解消) + 5000 games AlphaZero (batch=16)
- ブラウザ反映なし（Gen-3-F に届かないため）

### GPU 環境
- **ハードウェア**: NVIDIA RTX 4080 (16 GB VRAM)、 WSL2 経由で利用可
- **依存関係**: CUDA 11.8 + cuDNN 8（未インストール）→ **セットアップ手順は `docs/GPU_SETUP.md`**
- 現状の学習: CPU 版 `@tensorflow/tfjs-node` で実行（GPU 未活用）

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
| 2-L | MCTS 探索ハイパラ `uctC` の grid 最適化 | **完了 (Gen-3-L)**：vs smart 92.0% ← **ブラウザ反映済み** |
| 3 | AlphaZero 風（tfjs-node で学習 → tfjs ブラウザで推論） | **基盤完成 (Gen-3-K1〜K4)**：パイプライン動作確認済み、 最強 az-v7 でも vs smart 8% |
| 3-GPU | GPU 学習環境セットアップ | **準備中**（`docs/GPU_SETUP.md` 参照） |
| 4 | プレゼント選択の別ヘッド化 | 未着手 |

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

### NN 学習（CPU 版で動作中、GPU セットアップ後は同じコマンドで GPU 利用に切替）

```bash
# Warm-up: mctsAI 自己対戦
npx tsx ai/scripts/nn/train.ts --games 100 --iter 2 --batch 256 --epochs 3 --seed 1000 \
  --selfplay mcts --out ai/models/az-vN-warm

# AlphaZero ループ: neuralMcts 自己対戦 + 学習
npx tsx ai/scripts/nn/train.ts --games 200 --iter 5 --batch 256 --epochs 3 --seed 2000 \
  --selfplay neural --init ai/models/az-vN-warm --mcts-batch 16 \
  --out ai/models/az-vN
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
| **Gen-3-L** | uctC grid search (√2 → 2.0) | vs smart **92.0%** (CI 87.4-95.0%) ← **ブラウザ反映、現状最強** |
