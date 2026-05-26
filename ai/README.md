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
| 2 | 評価関数の重み自動チューニング（CMA-ES） | 未着手 |
| 3 | AlphaZero 風（tfjs-node-gpu で学習 → tfjs ブラウザで推論） | 未着手 |
| 4 | プレゼント選択の別ヘッド化 | 未着手 |

### 直近の改善候補（次イテレーション）

| 候補 | 仮説 | 期待効果 |
|---|---|---|
| Gen-3-A: iterations を 400 → 1000 に増やす | leaf eval が高速なので探索量で押せる | vs smart 勝率の更なる上昇（限界に近いかも） |
| Gen-3-B: CMA-ES で evaluator 重みを最適化（フェーズ 2） | leaf 評価が直接効くため重み調整の効果大 | vs smart で +α、smartAI 単体も同時強化 |
| Gen-3-C: progressive bias（事前知識を UCT に組み込む） | 訪問初期に evaluator の値を bias として加える | サンプル効率向上、収束高速化 |
| Gen-3-D: フェーズ 3 として AlphaZero 風（NN）| 方策/価値ネットの学習 | 大幅強化（実装コスト高、Python or tfjs-node-gpu） |
