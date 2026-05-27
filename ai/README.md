# AI 学習基盤

このディレクトリは「星を放つ夜」CPU AI の学習・評価に関するコード/データを置く場所です。
ブラウザバンドルには含めません（Vite は `src/` のみをエントリにします）。

## ディレクトリ構成

```
ai/
  README.md          このファイル
  CHANGELOG.md       AI 各世代の変更と評価結果の追記場所
  tsconfig.json      Node.js 実行用の TS 設定（型チェック専用）
  scripts/           CLI スクリプト
    selfplay.ts      指定戦略で N 局回し、結果を集計
    bench.ts         複数戦略を総当たり対戦させ、勝率/順位分布を出力
  data/              自己対戦ログ（gitignore）
  models/            学習済みモデル（gitignore）
```

ゲームロジックそのものは `src/game/` を直接 import します（学習環境と本番環境を完全に一致させるため）。

## 前提

```bash
npm install
```

`tsx` が devDependency に入っていれば準備完了です。

## よく使うコマンド

### 自己対戦を 1 セット回す

```bash
npx tsx ai/scripts/selfplay.ts --games 20 --strategies smart,smart,smart,smart --seed 42
```

### 戦略の比較ベンチ（既定: smart 1 体 vs random 3 体）

```bash
npx tsx ai/scripts/bench.ts --games 200 --strategies smart,random,random,random
```

`--rotate` を付けると各局で席をローテーションし、席順バイアスを除去します。

### JSON で結果を取得

`--json` を付けると標準出力に JSON 集計だけ流れます（自動化向け）。

## 進化サイクル

1 イテレーションを 1 PR として回す想定です。詳細は `.claude/skills/evolve-meteo-ai/SKILL.md` を参照してください。
各イテレーションの結果は `CHANGELOG.md` に追記してください。

## ロードマップ（要点）

| フェーズ | 内容 | 状態 |
|---|---|---|
| 0 | 学習基盤（決定論 RNG、エンコーディング、行動空間、self-play / bench CLI） | **完了 (Gen-0)** |
| 1 | IS-MCTS（randomAI を rollout policy として利用） | **完了 (Gen-1)**：vs smart で勝率 56% |
| 1-B | IS-MCTS の leaf 評価関数化（`evaluateState` を tanh 圧縮）| **完了 (Gen-2)**：vs smart で勝率 83.5%、1 手 4.15 ms |
| 2 | 評価関数の重み自動チューニング（(1+1)-ES） | **完了 (Gen-3-B / Gen-3-B-2 / Gen-3-F)**：vs smart で勝率 89.5%、1 手 2.09 ms（ブラウザ反映済み） |
| 3 | AlphaZero 風（tfjs-node で学習 → tfjs ブラウザで推論） | **基盤完成 + 速度 8x (Gen-3-K1〜K4)**：visit count 方策ターゲット・ネットワーク誘導 MCTS・AlphaZero ループ・ブラウザ推論雛形・バッチ推論まで実装。400 games 学習でも vs smart 2%、 大規模学習は次イテレーション |
| 4 | プレゼント選択の別ヘッド化 | 未着手 |

### 直近の改善候補（次イテレーション）

| 候補 | 仮説 | 期待効果 |
|---|---|---|
| ~~Gen-3-A: iterations 400 → 1000~~ | leaf eval が決定論的なので飽和済み | **不採用済み** |
| ~~Gen-3-C: progressive bias / PUCT~~ | 短期視点 prior が悪手 | **不採用済み**（勝率 -32.5pt） |
| ~~Gen-3-B: (1+1)-ES で evaluator 重み最適化~~ | leaf 評価の質を上げる | **採用済み**（勝率 +4.5pt、ブラウザ反映済み） |
| ~~Gen-3-B-2: warm-start ES~~ | 別 seed で局所最適脱出 | **採用済み**（勝率 +1pt、改善幅は逓減） |
| ~~Gen-3-E: selfNearEnd 追加 + ES~~ | 終局意識の特徴量 | **不採用**（過学習、-3.5pt） |
| ~~Gen-3-F: 本格 warm-start ES (100局/世代)~~ | noise 削減で真の改善検出 | **採用済み**（勝率 +0.5pt、1 手 -13% 高速化） |
| ~~Gen-3-G: smart gift heuristic 改修~~ | hasNoMoreTurns で target をフィルタ | **不採用**（smart 強化が副作用、-1.5pt）|
| ~~Gen-3-G-2: mcts 専用 gift heuristic~~ | mcts だけに hasNoMoreTurns 適用 | **不採用**（mcts simulation で gift selection を扱えない、-1pt）|
| ~~Gen-3-H: simulation 内 gift selection を smart heuristic で自動進行~~ | shrink で gift selection を越える | **不採用**（smart 妨害的すぎてシミュ評価が悲観化、-1.5pt）|
| ~~Gen-3-I: simulation 内 gift selection を random で進行~~ | smart heuristic の偏りを避ける | **不採用**（-2.5pt、 3 通り全部失敗で gift 周りは MCTS 構造的限界） |
| ~~Gen-3-J: per-AI weights 構造~~ | mcts と smart で別 weights を渡せる API へ拡張 | **構造採用**（vs smart で +0.5pt、ブラウザ DEFAULT は据置） |
| Gen-3-K: AlphaZero 風 NN（基盤）| 方策・価値ネットの学習基盤を整備、本格学習は次セッション | 大幅強化見込み（次フェーズ） |
| Gen-3-D: フェーズ 3 として AlphaZero 風（NN）| 方策/価値ネットの学習 | 大幅強化（実装コスト高、Python or tfjs-node-gpu） |

### `--weights` と `--mcts-weights` の使い分け

```bash
# ベンチ全体（全 AI）の評価関数重みを差し替え
npx tsx ai/scripts/bench.ts --weights ai/data/tuned-weights.json \
  --games 200 --strategies mcts,smart,smart,smart --rotate --seed 1001

# mcts のみ別重み（Gen-3-J で追加）— smart は default 重みのまま
npx tsx ai/scripts/bench.ts --mcts-weights ai/data/tuned-weights-gen3j.json \
  --games 200 --strategies mcts,smart,smart,smart --rotate --seed 1001

# mcts ラッパー戦略（GEN_3B_WEIGHTS 固定）
npx tsx ai/scripts/bench.ts \
  --games 200 --strategies mctsTuned,smart,smart,smart --rotate --seed 1001
```

### Gen-3-K（ニューラルネット）の運用

#### ファイル構成
```
ai/scripts/nn/
  model.ts      ネットワーク定義 (createModel / saveModel / loadModel / compileForTraining)
  dataset.ts    自己対戦データ生成 (generateSelfPlayGame / generateDataset)
  train.ts      学習ループ CLI
```

#### 学習実行（2 段階推奨：warm-up → AlphaZero）
```bash
# Phase 1: warm-up（mctsAI 自己対戦でデータ生成 → 教師あり学習）
npx tsx ai/scripts/nn/train.ts \
  --games 50 --iter 3 --batch 256 --epochs 3 --seed 1000 \
  --selfplay mcts --out ai/models/az-v2-warm

# Phase 2: AlphaZero ループ（学習モデルで neuralMcts 自己対戦 → 学習）
#          Gen-3-K4 の --mcts-batch 16 で 8x 高速化
npx tsx ai/scripts/nn/train.ts \
  --games 200 --iter 5 --batch 256 --epochs 3 --seed 2000 \
  --selfplay neural --init ai/models/az-v2-warm --mcts-batch 16 \
  --out ai/models/az-v2
```

#### ベンチ
```bash
# 学習モデル vs smart x3 (rotate 付き)
npx tsx ai/scripts/bench-neural.ts ai/models/az-v2 --games 50 --seed 1001 --silent --json
```

#### ファイル構成（追加）
```
ai/scripts/nn/
  model.ts           ネットワーク定義 (createModel / saveModel / loadModel)
  dataset.ts         自己対戦データ生成 (generateSelfPlayGame / generateSelfPlayGameWithModel)
  neuralMcts.ts      ネットワーク誘導 MCTS (decideActionNeural)
  train.ts           学習 CLI (--selfplay mcts|neural)
ai/scripts/
  bench-neural.ts    neural モデル vs smart x3 ベンチ
```

学習済みモデルは tfjs 標準形式 (`model.json` + `weights.bin`)。
将来ブラウザ側で `tf.loadLayersModel('/meteo-night/models/<gen>/model.json')` で読み込み可能。

#### 現状の制限（Gen-3-K5 以降で対応）
- **学習量不足**: 400 games の AlphaZero でも vs smart 2%。Gen-3-K4 の 8x 速度向上で大規模化が現実的に
- ~~**NN 呼び出しがボトルネック**~~ → **Gen-3-K4 で解決**（batch=16 で 8x 高速化）
- **ブラウザ推論ラッパー** (`src/ai/neuralAI.ts`) は雛形のみ、tfjs 実 import は実用モデル完成後
- **GPU 学習**: 現状 CPU 版 `@tensorflow/tfjs-node`、本格学習時に `@tensorflow/tfjs-node-gpu` に切り替え（CUDA セットアップ要）
- **mean-field 仮定**: neuralMcts では path 上の全 node に leafValue を同符号で backup（多人数特化未対応）
- **ネットワーク容量**: 18K パラメータ（隠れ 64×2 層）は小さい可能性。本格時は数十万パラメータも検討
- **Virtual loss 未実装**: batch 推論で同一 leaf 集中を完全には防げない（実用上は seed 多様性で mitigate）
