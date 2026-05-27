---
name: evolve-meteo-ai-neural
description: 星を放つ夜 (MeteoNight) のニューラルネット AI（AlphaZero 風）を 1 イテレーション進化させる。tfjs-node(-gpu) でのモデル学習・ベンチ・ブラウザ配信を扱う。手書き AI は対象外。
disable-model-invocation: false
---

# NN AI 進化サイクル (1 イテレーション)

このスキルは AlphaZero 風 NN モデル（`az-vN`）を 1 つ進化させるための標準ワークフローです。
**対象**: `ai/scripts/nn/{model,dataset,neuralMcts,train}.ts`、`ai/scripts/bench-neural.ts`、`src/ai/neuralAI.ts`。
**対象外**: 手書き AI（smartAI / mctsAI / evaluator）→ `evolve-meteo-ai-handwritten` スキル参照。

**1 イテレーション = 1 改善仮説**。複数仮説を同時投入してはいけません。

## 前提

- `npm install` 済み（`tsx` と `@tensorflow/tfjs-node-gpu` が devDependency にある）
- **GPU 学習を行う場合**: `docs/GPU_SETUP.md` の手順で CUDA 11.8 + cuDNN 8 をインストール済み
  - 未セットアップなら CPU 版 `@tensorflow/tfjs-node` で動くが、学習速度は約 1/5〜1/10
- `src/game/` のゲームロジックを **学習側からも本番からも単一ソース**として使う

## 手順

### 0. ルール変更チェック（必ず最初に実行）

`evolve-meteo-ai-handwritten` の Step 0 と同じ。
ルール変更があれば、 NN 学習用の `dataset.ts` / `encoding.ts` / `actionSpace.ts` への影響も確認すること。

### 1. 現状把握

- `ai/CHANGELOG.md` の最新エントリを読み、最新の NN モデル（`az-vN`）とベンチ結果を確認
- `ai/README.md` 冒頭「現状最強モデル」を確認（NN 系最強モデルが何か、ブラウザ反映済みか）
- `ai/scripts/nn/` の現行実装を把握

### 2. GPU 環境確認

```bash
# GPU 認識確認
TF_CPP_MIN_LOG_LEVEL=1 npx tsx ai/scripts/nn/_smoke-gpu.ts 2>&1 | head -10
```

期待ログ:
- `backend: tensorflow`
- `Created device /job:localhost/.../device:GPU:0` が出れば GPU 認識
- 出なければ CPU フォールバック（学習速度が大幅低下）

GPU が認識されないときは `docs/GPU_SETUP.md` の手順を再確認。

### 3. 改善仮説の立案

`ai/README.md` の NN 系ロードマップから、 次の最小単位を 1 つ選ぶ。典型例:

- **学習量増**: 既存モデルから warm-start で +N games 追加
- **NN 容量増**: `--hidden-units` / `--hidden-layers` を増やす
- **アルゴリズム改善**: virtual loss / Dirichlet noise / progressive temperature scheduling
- **mean-field 解消後の細部チューニング**: tau, lr, batch
- **モデル間ベンチ**: 旧 az-vN vs 新 az-v(N+1) で 55% 以上なら新版採用

仮説を文章化し、 **期待する勝率向上幅** と **学習予算（games 数 × 時間）** を事前に書く。

### 4. 学習設定の決定と実行

#### 学習スクリプト（基本）

```bash
# Phase 1: warm-up（mctsAI 自己対戦データ）
npx tsx ai/scripts/nn/train.ts \
  --games <warm-games> --iter <warm-iter> --batch 256 --epochs 3 \
  --seed <seed-warm> --selfplay mcts \
  [--hidden-units <H> --hidden-layers <L>] \
  --out ai/models/az-v<N>-warm

# Phase 2: AlphaZero ループ（neuralMcts 自己対戦データ + 学習）
npx tsx ai/scripts/nn/train.ts \
  --games <az-games> --iter <az-iter> --batch 256 --epochs 3 \
  --seed <seed-az> --selfplay neural \
  --init ai/models/az-v<N>-warm --mcts-batch 16 [--tau 1.0] \
  --out ai/models/az-v<N>
```

#### 容量の目安（ブラウザ配信のため小型推奨）

| 容量 | hidden | パラメータ | 推奨用途 |
|---|---|---|---|
| 小 | 64×2 | 18K | プロトタイプ |
| 中 | 96×3 | ~35K | 試験的本格学習 |
| 大 | 128×4 | ~77K | 本格学習（GPU 前提） |
| 特大 | 256×6 | ~500K | 大規模 GPU 学習（要数日） |

#### 学習量の目安

| games 累計 | 期待強さ（vs smart） | 所要時間（CPU）| 所要時間（GPU）|
|---|---|---|---|
| 500 | 0-5% | ~10 分 | ~2 分 |
| 5000 | 5-10% | ~2 時間 | ~20 分 |
| 50000 | 推測 20-40% | ~20 時間 | ~3 時間 |
| 500000 | 推測 60-80% | ~9 日 | ~30 時間 |

（実測ベースの線形外挿、上振れ/下振れあり）

### 5. ベンチで採用判定

#### 学習モデルの強さ評価

```bash
# 主評価: vs smart x3
npx tsx ai/scripts/bench-neural.ts ai/models/az-v<N> \
  --opponent smart --games 50 --seed 1001 --silent --json

# 副評価: vs random x3（学習進行の最低限確認）
npx tsx ai/scripts/bench-neural.ts ai/models/az-v<N> \
  --opponent random --games 50 --seed 2001 --silent --json

# 旧 NN モデルとの直接対戦（採用判定に使う）
npx tsx ai/scripts/bench-neural.ts ai/models/az-v<N> \
  --opponent mcts --games 50 --seed 3001 --silent --json
```

#### 採用条件（NN 系特有）

- **vs smart の勝率が現状最強 NN モデル（前回 Gen の az-v(N-1)）を上回る**
- かつ 200 局以上で 95%CI が前回 CI の上限を超える（明確に改善）
- 1 手あたり時間が **ブラウザ実用範囲**
- 学習量が極端に大きい場合は overfit 警戒（loss は下がるがベンチが悪化していないか）

### 6. (採用なら) ブラウザ反映

ブラウザ反映には **`src/ai/neuralAI.ts` の実装** と **`@tensorflow/tfjs`（ブラウザ版）の bundle 追加**が必要。

#### 反映手順

1. `src/ai/neuralAI.ts` を実装で埋める
   - 雛形は既存（tfjs 未 import）
   - `ai/scripts/nn/neuralMcts.ts` から PUCT ロジックを移植
   - `import * as tf from '@tensorflow/tfjs'` （ブラウザ用）に切替
2. 学習済みモデルを `public/models/az-v<N>/` にコピー
   - `cp -r ai/models/az-v<N>/* public/models/az-v<N>/`
3. `src/ai/index.ts` の `decideAction` を `neuralAI` に差し替え
4. `npm run build` で動作確認（バンドルサイズが数百 KB〜1 MB 増えることを許容）
5. 観戦モード (`npm run dev`) で 1 ゲーム動作確認

#### バンドルサイズ警戒
- `@tensorflow/tfjs` 追加で約 500 KB-1 MB（gzip 後）が増える
- これは現状の 234 KB と比較して大幅増、ユーザー体感に影響しうる
- 反映前に「強さの改善が反映価値に見合うか」検討

### 7. 記録

`ai/CHANGELOG.md` に追記。フォーマット:

```
## Gen-3-K<n>: <短いタイトル> (YYYY-MM-DD)

### 仮説
- 学習設定: warm <W>games + AZ <A>games (合計 <total>games)
- ネットワーク容量: hidden <H>×<L> (~<P>K params)
- 期待勝率向上幅: ...

### 学習結果
- 実時間: ...
- 最終 loss: ...

### ベンチ結果
- vs smart x3: 勝率 X% (95%CI ...)
- vs random x3: 勝率 X%
- vs 前回モデル: 勝率 X%
- 平均得点: ...
- 1 手あたり時間: ...
- 未終了率: ...

### 採用判定
採用 / 不採用 / 保留

### メモ
- 学習トレンドの観察
- failure mode（不採用の場合）
```

## チェックリスト（コミット前）

- [ ] `npx tsc -p ai/tsconfig.json --noEmit` を通した
- [ ] `npx vitest run` を通した（NN 系は test 対象外だが、ゲームロジック改修があれば必要）
- [ ] ベンチ結果を CHANGELOG に記載した
- [ ] 学習モデル `ai/models/az-v<N>/` を保存した（gitignore で git 管理外）
- [ ] 学習ログ `ai/data/log-az-v<N>.log` を保存した

## 重要な原則

- **毎回最初にルール変更チェック（ステップ 0）を実行する**
- 1 イテレーション = 1 仮説
- ベンチは必ず `--seed 1001`（vs smart）等の固定 seed で測定
- 採用判定は **数字を見て客観的に**
- **追加 warm-start は overfit リスクあり**（過去 az-v8 / v9 で実証）

## 関連スキル / ドキュメント

- 手書き AI 系の進化: `evolve-meteo-ai-handwritten` スキル
- GPU セットアップ手順: `docs/GPU_SETUP.md`
- NN 系の過去の試行履歴: `ai/CHANGELOG.md` の Gen-3-K1〜K10
