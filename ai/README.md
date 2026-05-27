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
| 3 | AlphaZero 風（tfjs-node-gpu で学習 → tfjs ブラウザで推論） | 未着手 |
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
| Gen-3-I: simulation 内 gift selection を **中立 policy**（random）で進行 | smart heuristic の偏りを避ける | 軽量検証、Gen-3-H の派生 |
| Gen-3-B-3: per-AI weights | mcts と smart で別 weights を使う設計 | 「mcts を強くする」直接最適化が可能に |
| Gen-3-D: フェーズ 3 として AlphaZero 風（NN）| 方策/価値ネットの学習 | 大幅強化（実装コスト高、Python or tfjs-node-gpu） |

### `mctsTuned` と `--weights` の使い方

```bash
# Gen-3-B の重みを bench 全体に適用
npx tsx ai/scripts/bench.ts --weights ai/data/tuned-weights.json \
  --games 200 --strategies mcts,smart,smart,smart --rotate --seed 1001

# mcts だけ tuned で動かす（ラッパー戦略）
npx tsx ai/scripts/bench.ts \
  --games 200 --strategies mctsTuned,smart,smart,smart --rotate --seed 1001
```
