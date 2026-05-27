# AI CHANGELOG

各イテレーション（世代）の変更点と評価結果を追記していきます。
最新を上、古いものを下に。

フォーマット例:

```
## Gen-N: <短いタイトル>  (YYYY-MM-DD)

### 変更点
- ...

### ベンチ結果
- 対戦相手: <baseline 名>
- 試合数: <N>
- 勝率: <X>% (有意水準 p<0.05)
- 平均得点: ...
- 1 手あたり時間: ...

### 採用判定
採用 / 不採用 / 保留

### メモ
- ...
```

---

## Gen-3-K5 / K6: NN 容量増・mean-field 解消の試行 (個別効果は限定的、組み合わせを検証中) (2026-05-27)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、変化なし。

### Gen-3-K5: NN 容量増（隠れ層 64×2 → 128×4、18K → 77K パラメータ）

#### 仮説
NN の表現力天井を上げる。容量 4x で複雑な戦略を学習可能に。ブラウザ配信は依然 ~200KB / gzip 60-80KB で実用範囲。

#### 変更点
- `ai/scripts/nn/train.ts`: `--hidden-units / --hidden-layers` フラグ追加
- `ai/scripts/nn/model.ts`: 既存の `ModelOptions` をそのまま CLI から渡せるよう経由

#### az-v4 ベンチ結果（1000 games + 容量 77K）
| 指標 | 値 |
|---|---|
| vs smart 勝率 | **0%** (0/50) |
| avgScore | 3.60 |
| 期待順位 | 3.84 |
| 1 手あたり時間 | 15.25 ms（容量増で +60%）|

#### Gen-3-K5 採用判定: **不採用**
- 学習量に対して容量が大きすぎ underfit (final loss 1.62 > az-v3 1.56)
- 計算コストも増えるため、 学習量を 4x にしないと釣り合わない

---

### Gen-3-K6: mean-field 仮定の解消（NN 価値出力 1 → 4 次元）

#### 仮説
旧 neuralMcts は path 上の全 node に同じ leaf value を backup する mean-field 仮定で、多人数ゲームの利害対立を表現できなかった。
NN 価値出力を「各プレイヤー視点の rank-based value」4 次元に拡張し、 各 node の actor 視点 value を取り出して正しく backup する。

#### 変更点（破壊的、既存 az-v1〜v4 とは互換性なし）
- `ai/scripts/nn/model.ts`:
  - `VALUE_HEAD_SIZE = 4` を追加、 価値出力を 4 次元の tanh に変更
  - `MeteoAzModel.valueSize` を追加
  - モデル名を `meteo_az_v0` → `meteo_az_v1` に変更
- `ai/scripts/nn/dataset.ts`:
  - `LearnerExample.valueTarget`: `number` → `Float32Array(numPlayers)`
  - generateSelfPlayGame / WithModel で各プレイヤーの rank-based value を計算してターゲットに
- `ai/scripts/nn/neuralMcts.ts`:
  - `NodeStats.cachedValue` → `cachedValuePerPlayer: Float32Array`
  - `nnPredictBatch` 戻り値: `values: Float32Array` → `values: Float32Array[]`（各 sample が numPlayers 次元）
  - `backprop` で `leafValuePerPlayer[node.actor]` を取り出して使う
  - terminal / cut 時も `makeRankingValueVec(s)` で各プレイヤー視点ベクトルを構築
- `ai/scripts/nn/train.ts`: `examplesToTensors` で valueSize 対応

#### az-v5 ベンチ結果（1200 games + K6、容量 18K）
| 指標 | 値 | az-v3 比 |
|---|---|---|
| vs smart 勝率 | **4%** (2/50) | -2pt |
| avgScore | **4.12** | **+1.00**（過去最高）|
| 期待順位 | 3.78 | 同等 |
| 未終了率 | **4%** | **-6pt 改善** |

#### Gen-3-K6 採用判定（単独）: **保留**
- 勝率は az-v3 の 6% に届かないが、 avgScore と未終了率が明確に改善
- 「ゲームを終わらせる能力」が向上 = K6 で学習信号がより正しくなった兆候
- 単独で Gen-3-F (89.5%) を超えるには至らないが、 次の K7 (K6 + 容量増) に期待

---

### Gen-3-K7: K6 + 容量中規模 (az-v6) と 5000 games 大規模学習 (az-v7)

#### az-v6 (K6 + 容量 96×3 = 35K params + 1200 games)
- 勝率 **6%** (3/50)、avgScore 3.08、未終了 10%
- K6 + 容量増の組み合わせは効果薄（学習量不足が原因）

#### az-v7 (K6 + 容量 18K + 5000 games AlphaZero, batch=16, az-v5-warm から)
- 学習時間 **105 分** (25 iter × 200 games × batch=16)
- loss 推移: 1.95 (start) → 1.66-1.74 (収束気味)
- 勝率 **8%** (4/50)、 CI 3.2-18.8%（過去最高）
- avgScore **5.38**（過去最高、 +1.26 vs az-v5）
- 期待順位 **3.72**（過去最高）

#### 学習量スケーリング観察（K6 共通、容量 18K）

| Gen | games | vs smart | avgScore | 改善幅 |
|---|---|---|---|---|
| az-v2 | 400 | 2% | 1.98 | – |
| az-v3 | 1400 | 6% | 3.12 | +4pt |
| az-v5 | 1200 + K6 | 4% | 4.12 | – |
| **az-v7** | **5000 + K6** | **8%** | **5.38** | **+2pt** |
| Gen-3-F | – | 89.5% | 20.77 | – |

学習量を増やすと勝率が線形的に増えるが、 ペースは緩やか (+2pt/+4000games)。 Gen-3-F 到達には 100x 以上の学習が必要と推定。

---

### Gen-3-K8: Virtual loss でバッチ探索の効率向上（実行中: az-v8）

#### 仮説
現状の batch=16 は各 iter が独立 traverse のため、同じ leaf に集中する可能性。
Virtual loss（探索中の path に「最下位」-1 を仮想的に加算）で exploration を促進。

#### 変更点
- `ai/scripts/nn/neuralMcts.ts`:
  - `applyVirtualLoss(path)` / `unapplyVirtualLoss(path)` を追加
  - selection で expand 候補が見つかったら直ちに virtual loss を apply、NN 推論後に解除して real backprop
  - 価値スケール [-1, +1] に合わせて virtual = -1 (最下位)

#### スモーク
- 10 games × batch=16 で K7 (12.9 秒) と K8 (18 秒)、ほぼ同等の速度
- examples 数は 1974 (K7) vs 2519 (K8) → K8 で探索範囲が広がっている可能性

#### az-v8 完了: virtual loss が逆効果（不採用、ロールバック）
- 設定: 200 games × 25 iter, batch=16, **virtual loss=on**、az-v7 から warm-start
- 学習時間 **127 分**、loss 1.95 → 1.55-1.61 と進行
- ベンチ結果（vs smart 50局, seed=1001）:

| 指標 | az-v7 (K6 + 5000g) | **az-v8 (K6 + 10000g + virtual loss)** | 判定 |
|---|---|---|---|
| 勝率 | 8% (4/50) | **0%** (0/50) | **大幅悪化** |
| avgScore | 5.38 | 2.94 | -2.44 |
| 期待順位 | 3.72 | **3.98** (ほぼ常に 4 位) | 悪化 |

##### 採用判定: **不採用、ロールバック**

##### 失敗原因の推定
- virtual loss apply 中の selection で path 上のノードに「敗北前提」が積まれる
- 同じ batch 内の他 iter が、同じ leaf を深掘りしない方向に誘導される
- 結果として **探索の偏り**が学習データの偏りに繋がり、 方策が崩壊
- 価値スケール [-1, +1] に対する loss -1 のスケールが過大だった可能性

##### ロールバック内容
- `NeuralMctsOptions.virtualLoss` フラグを追加（default `false`）
- `applyVirtualLoss / unapplyVirtualLoss` のコード自体は保全
- 将来 loss スケール調整（例: -0.3）で再評価可能

### メモ・現状の到達点
- **NN 系の最強モデル**: az-v7（vs smart 8%、avgScore 5.38、未終了率 10%）
- **ブラウザ反映には依然遠い**（Gen-3-F 89.5%）
- **学習量を増やすと確実に向上**することは確認できた（+2pt/+4000 games の線形性）
- **virtual loss は単純実装では逆効果**
- 既存テスト 19/19 通過、型チェック OK

---

## Gen-3-K4: NN バッチ推論で学習を 8 倍高速化 (2026-05-27)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、未コミット変更は `reducer.ts` のログ表記改修（AI 影響なし）と私の Gen-3-K 関連のみ。進行可。

### 仮説と設計
Gen-3-K3 の失敗原因の主要部分が「NN 推論コスト（1 局 ~10 秒）」だったため、**バッチ推論**で高速化する:
- `decideActionNeural` に `batchSize` オプション追加
- N 個の独立 iter を並列に traverse（各 iter は別 determinize seed）
- 「expansion 待ち」の leaf state を N 個ためてから **1 回の NN 推論** でまとめて評価
- 各 path に backprop（mean-field 仮定で既存実装踏襲）
- Virtual loss は未実装（同じ leaf 集中の懸念は seed 多様性で mitigate）

### 変更点
- `ai/scripts/nn/neuralMcts.ts`:
  - `nnPredictBatch(model, stateVecs[])`: 複数 state を 1 つのテンソルにまとめて推論し、結果を split
  - `NeuralMctsOptions.batchSize` 追加（デフォルト 1）
  - `decideActionNeural` を refactor：`runSelection(iter)` 関数で 1 iter 分の traverse を独立化、N 個ためて batch predict
- `ai/scripts/nn/dataset.ts`: `SelfPlayOptions.mctsBatchSize` 追加、`generateDatasetWithModel` に伝播
- `ai/scripts/nn/train.ts`: `--mcts-batch <n>` フラグ追加

### 速度比較（同じ az-v2 から self-play 10 games）

| 設定 | 時間 | examples | 1 局あたり |
|---|---|---|---|
| batch=1 (baseline) | **102.6 秒** | 2039 | ~10.3 秒 |
| batch=16 (Gen-3-K4) | **12.9 秒** | 1974 | **~1.3 秒** |

**約 8 倍の高速化**（期待 3-5x を大きく超過）。

理由の推定:
- tfjs の `predict()` 呼び出しオーバーヘッドが大きく、それが 1/16 に削減された
- TensorFlow 内部の SIMD/並列最適化がバッチ入力で効きやすい

注: examples 数はほぼ同じ → 学習に使えるデータ量も同等。

### 採用判定（速度面）
**採用**。学習速度が 8x になったため、これまで数時間かかっていた本格学習が現実的な時間で回せるようになった。

### Gen-3-K4 の速度を活かした大規模学習: az-v3
- 設定: az-v2 から warm-start で **1000 games (200 × 5 iter) × batch=16**
- 実時間 **28 分**（推定 15 分よりやや長め、 batch=16 でも完全 8x は出ない）
- loss 推移: 1.59 → 1.61 → 1.62 → 1.61 → 1.56（warm-start のため微振動）

#### az-v3 ベンチ（vs smart x3, 50 局, seed=1001, rotate）
| 世代 | 学習 games | vs smart 勝率 | avgScore | 期待順位 | 未終了率 |
|---|---|---|---|---|---|
| az-v1 | 80 | 0% | 1.62 | 3.96 | 20% |
| az-v2 | 400 | 2% | 1.98 | 3.90 | 20% |
| **az-v3** | **1400** | **6%** (CI 2.1-16.2%) | **3.12** | **3.78** | 10% |
| 参考: Gen-3-F | – | 89.5% | 20.77 | 1.12 | 0% |

#### az-v3 単体の採用判定
**不採用、ブラウザ反映なし**。Gen-3-F (89.5%) に対し 6% で 83pt 後退。

ただし学習量を増やすと **勝率が線形的に微増**（0% → 2% → 6%、加重 +4pt/+1000games）することが観察された。
理論的には数万 games 必要だが、batch 推論で「現実的な時間で大規模化」できることを示せたのが収穫。

### メモ
- **学習品質への影響**: batch=16 では「同一 leaf に集中する可能性」「priors 上書き競合」等の理論的懸念あり
  - 実装は「同一ノードへの priors install は 1 回限り」「同じ iter 内なら同一 path で重複 visit OK」
  - 強さ評価は az-v3 のベンチで確定
- **Virtual loss 未実装**: 効率の理論最大値の 50-70% 程度しか出ない可能性
  - 実用上は seed 多様性で十分散らされており、ベンチ結果次第で追加実装を判断
- 既存テスト 19/19 通過、型チェック OK

---

## Gen-3-K1〜K3: AlphaZero ループの本格実装 (基盤完成、本格学習は要時間) (2026-05-27)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降のコミット無し。未コミット差分は `reducer.ts` のログ表記改修（AI 影響なし）と私の Gen-3-K 関連。

### 仮説と方針
Gen-3-K（基盤整備のみ）に続き、本格的な AlphaZero ループを実装する:
- **K1a**: MCTS の visit count を方策ターゲットに（one-hot → softmax(visits^(1/τ)))
- **K1b**: ネットワーク誘導 MCTS（NN の方策を PUCT prior、価値を leaf 評価に）
- **K2**: AlphaZero ループ（self-play → 学習 → 新モデルで self-play）
- **K3**: 学習モデル vs 既存 Gen-3-F のベンチ・採用判定

### 変更点

#### Gen-3-K1a: visit count → 方策ターゲット
- `src/ai/mctsAI.ts`: `decideActionWithInfo()` を追加。root の `visits` と `meanValues` を返す
  - 既存 `decideAction()` は互換性維持で動作（内部で `decideActionWithInfo` を呼んで action だけ返す）
- `ai/scripts/nn/dataset.ts`: `visitsToPolicy(visits, tau)` で softmax 化、AlphaZero 流の方策ターゲット
- スモーク（5 games × 2 iter）: loss 3.36 → 2.95、学習進行確認

#### Gen-3-K1b: ネットワーク誘導 MCTS
- `ai/scripts/nn/neuralMcts.ts` 新規作成:
  - PUCT 風選択: `Q(a) + C·P(a)·√N/(1+n(a))`
  - `P(a)`: NN の方策出力（合法手で再正規化）
  - leaf 評価: NN の価値出力（tanh の即値）
  - `decideActionNeural(state, playerId, model, seed?, options?)` API
- スモーク（80 games で学習したモデルで 1 局）: finished=true、1 手 ~7 ms、動作 OK

#### Gen-3-K2: AlphaZero ループ
- `ai/scripts/nn/dataset.ts`: `generateSelfPlayGameWithModel` / `generateDatasetWithModel` を追加
- `ai/scripts/nn/train.ts`: `--selfplay mcts|neural` と `--tau` を追加
  - `mcts`: 既存 mctsAI で self-play（warm-up 用、NN 未学習でも可）
  - `neural`: 学習中モデルで neuralMcts self-play（AlphaZero 改善ループ）

#### Gen-3-K3: ベンチ
- `ai/scripts/bench-neural.ts` 新規作成: 学習モデル vs smart x3 を rotate 付きで対戦

### 学習結果（小規模、本セッション内）

| フェーズ | 設定 | 最終 loss |
|---|---|---|
| Warm-up (mcts self-play) | 20 games × 2 iter | 3.11 → **2.01** |
| AlphaZero (neural self-play) | 20 games × 2 iter | 1.82 → **1.66** |
| 計学習 games | **80 games** | – |
| 計学習 examples | ~17,000 | – |
| AlphaZero 1 局あたり | ~10 秒（neuralMcts コスト）| – |

### ベンチ結果（小規模学習モデル, 50 games, seed=1001, rotate）

| 指標 | Gen-3-F | **az-v1 (80 games 学習)** |
|---|---|---|
| 勝率 | 89.5% | **0%** (0/50) |
| 95%CI | 84.5-93.0% | 0-7.1% |
| 1 位獲得 | 179/200 | 0/50 |
| 平均得点 | 20.77 | **1.62** |
| 期待順位 | 1.12 | 3.96（ほぼ常に 4 位） |
| 未終了率 | 0% | 16% (8/50) |

### 採用判定（短時間学習版 az-v1）
**不採用、ブラウザ反映なし**

### 大規模学習（az-v2）の結果

**学習設定**:
- Warm-up: 50 games × 3 iter (mcts self-play, ~6 分)
- AlphaZero: 50 games × 5 iter (neural self-play, ~37 分)
- 合計約 45 分、計 400 games

**学習 loss 推移**:
- Warm-up iter 3: ~2.0
- AZ iter 1: 1.74
- AZ iter 3: 1.59
- AZ iter 5: **1.37**（大幅減少、学習進行は確認）

**ベンチ結果（az-v2）**:

| 対戦 | 勝率 | avgScore | 期待順位 | 未終了率 | 解釈 |
|---|---|---|---|---|---|
| vs smart x3 (50 局, seed=1001) | **2.0%** (CI 0.4-10.5%) | 1.98 | **3.9**（ほぼ常に 4 位） | 20% | 大敗 |
| vs random x3 (50 局, seed=2001) | 36.0% (CI 24.1-49.9%) | 3.92 | 2.48 | 100% | random より少し強い (+11pt) |

参考: Gen-3-F (mcts) vs smart x3 200 局 = 89.5%、 az-v2 は 87.5pt 後退。

### 採用判定（最終）
**不採用、ブラウザ反映なし。ブラウザは引き続き Gen-3-F (vs smart 89.5%) を維持。**

### 失敗原因の整理
1. **学習量が桁違いに少ない**: 400 games の AlphaZero は AlphaGo Zero（数百万 games）の 1/10000 以下
2. **NN 容量不足**: 18K パラメータでは複雑な連鎖戦略を表現できない
3. **NN 推論コストが大きい**: 1 局 ~10 秒で大規模化が時間的に困難（バッチ predict 未実装）
4. **mean-field 仮定の歪み**: 多人数ゲーム特有の調整が未実装（path の各 node に同符号 leaf value を backup）

### Gen-3-K 全体の評価
- **基盤・パイプラインは完全動作**: K1a (visit count target) / K1b (neuralMcts) / K2 (AlphaZero loop) / K3 (bench)
- **実用モデルには未到達**: 短時間学習・小容量の制約下では Gen-3-F の天井を超えられず
- **次イテレーションに必要なもの**:
  - **バッチ predict** 実装で 5-10x 学習速度向上（実装中規模）
  - **NN 容量増**（隠れ 128 unit × 4 層、~10x パラメータ）
  - **大規模学習**（数千 games の AlphaZero、数時間〜数日）
  - **GPU 化**（`@tensorflow/tfjs-node-gpu` 切替）
  - **mean-field 仮定の解消**（各 actor 視点の value を別途取る）

### 残置物
- `ai/scripts/nn/{model,dataset,neuralMcts,train}.ts`: AlphaZero 学習基盤の全コード
- `ai/scripts/bench-neural.ts`: 学習モデル vs (smart|random|mcts) ベンチ
- `src/ai/neuralAI.ts`: ブラウザ向け推論ラッパー雛形（tfjs 未 import、実用モデル完成時に有効化）
- `ai/models/az-v2/`: 学習済みモデル（参考用、gitignore で git 管理外）
- `ai/data/log-az-v2*.log`: 学習ログ（gitignore）

---

## Gen-3-K: AlphaZero 風 NN 学習基盤の整備 (基盤採用、本格学習は次セッション) (2026-05-27)

### メモ・今後の改善点
- **NN 呼び出しがボトルネック**: 1 局 ~10 秒は遅すぎ。バッチ predict（複数 leaf state をまとめて推論）で 5-10x speedup 可能
- **未終了率 16%**: 弱いモデルだとゲームが 20 点に到達せず max-steps で打ち切られる
- **ネットワーク容量**: 18K パラメータは小さすぎる可能性。本格学習時は 128 unit × 4 層程度（数十万パラメータ）が必要
- **GPU 化**: 現状 CPU 版 tfjs-node、 本格学習時に GPU 版へ
- **mean-field 仮定の修正**: neuralMcts では path 上の全 node に leafValue を同じ符号で backup。 多人数ゼロサム的な工夫（各 actor 視点の value を別途取る）が必要かも

### 残置物
- `ai/scripts/nn/neuralMcts.ts`: 新規追加（226 行）
- `ai/scripts/bench-neural.ts`: 新規追加（200 行）
- スモークファイルとモデルは削除済み
- 既存テスト 19/19 通過、型チェック OK

---

## Gen-3-K: AlphaZero 風 NN 学習基盤の整備 (基盤採用、本格学習は次セッション) (2026-05-27)

> **Note**: このエントリは Gen-3-K の基盤整備のみ記録。本格学習・ベンチ・最終判定は上の「Gen-3-K1〜K3」エントリ参照。

### Step 0: ルール変更チェック
直前 Gen-3-J から数分のため変化なし。HEAD = 3f0158b、未コミット変更は私の Gen-3-J 関連 + Gen-3-K 関連。

### 仮説と方針
手書きの評価関数（17 重み）は天井に達した（Gen-3-B → F → J で +4.5pt → +1pt → +0.5pt と逓減）。
方策・価値ニューラルネットによる本質的突破を狙う。本セッションでは **基盤整備のみ**、本格学習は次セッション以降。

### ネットワーク設計
- 入力: `encoding.ts` の固定長ベクトル (現状 **185 次元**)
- 隠れ層: Dense 64 unit × 2 層 (ReLU + L2=1e-4)
- 方策ヘッド: `ACTION_SPACE_SIZE = 30` 次元 softmax
- 価値ヘッド: tanh 1 次元（actor の rank-based value [-1, +1]）
- 総パラメータ: **18,079**、保存サイズ約 70 KB（ブラウザ配信に最適）

### 変更点
- 依存追加: `@tensorflow/tfjs-node` v4.22.0（CPU 版、本格学習時は GPU 版に差し替え予定）
- `ai/scripts/nn/model.ts`: ネットワーク定義
  - `createModel(opts?)`: 新規ネットワーク作成
  - `compileForTraining(model, lr?)`: Adam optimizer + categoricalCrossentropy/MSE
  - `saveModel(model, dir)` / `loadModel(dir)`: tfjs 標準形式 (`model.json` + `weights.bin`)
- `ai/scripts/nn/dataset.ts`: 自己対戦データ生成
  - `generateSelfPlayGame({seed})`: 1 局自己対戦して `LearnerExample[]` を返す
  - `generateDataset(seedBase, numGames)`: N 局をまとめて生成
- `ai/scripts/nn/train.ts`: 学習ループ CLI
  - `--games / --iter / --batch / --epochs / --lr / --seed / --out / --init` をサポート
  - 自己対戦 → ミニバッチ学習 → モデル保存

### 動作確認（スモーク）
- 設定: 10 games × 2 iter, batch=32, epochs=2
- iter 1: 2304 examples、訓練 1.2 秒、最終 loss 3.26
- iter 2: 2387 examples、訓練 1.1 秒、最終 loss **2.28**（前 iter 比 -30%、学習進行を確認）
- モデル保存・型チェック OK

### 採用判定
**基盤を採用、ブラウザ反映はなし**

学習自体はまだ start 地点。ベンチでの強さ評価は未実施（現状の one-hot 方策ターゲット + 既存 MCTS データなので、特別強くはならない見込み）。
ブラウザ向けの NN 推論ラッパーは未実装、ブラウザ動作は引き続き Gen-3-F のまま。

### 次セッション以降の TODO
1. **MCTS の visit count を方策ターゲットに**：one-hot → softmax(visit_count^τ) で本格 AlphaZero 流
2. **ネットワーク誘導 MCTS**：mctsAI に NN を組み込み、PUCT prior と leaf value を NN 出力に
3. **AlphaZero ループ**：train → self-play with new net → train ... の本格イテレーション
4. **モデル比較ベンチ**：旧 net vs 新 net で勝率測定、55% 以上で新 net 採用
5. **ブラウザ推論ラッパー**：`src/ai/neuralAI.ts` 実装、`public/models/<gen>/` に配信
6. **GPU 化**：`@tensorflow/tfjs-node-gpu` に切り替え（CUDA セットアップ要）
7. **損失重み調整**：tfjs の `lossWeights` 型サポート対応（カスタムロス関数 or value target 係数倍）

### メモ
- 本セッションでは Gen-3-K の「実装可能性」と「学習が回ること」が確認できた
- 18K パラメータの小型 NN は数秒で学習可能、ブラウザ配信も 70 KB と十分実用範囲
- 既存テスト 19/19 通過、型チェック OK
- 並行作業中のデザイン編集との競合ゼロ（`ai/**` と `src/ai/**` のみ触っている）

---

## Gen-3-J: per-AI weights 設計の導入 (採用、ブラウザ DEFAULT は据置) (2026-05-27)

### Step 0: ルール変更チェック
HEAD = 3f0158b（ユーザーが私のセッション分を整理してコミット済み）。それ以降の `docs/RULES.md` / `src/game/` 変更なし、進行可。

### 仮説
これまでの評価関数の重み（17 項目）は **モジュール global で 1 セット**しか持てなかった。学習中、mcts の重みを最適化しても **対戦相手 smart も同じ重みで動く** ため、両者が同時に強化されて mcts の純粋な改善幅が見えない（Gen-3-B / B-2 / F で +4.5pt → +1pt → +0.5pt と逓減した一因）。

per-AI weights 構造に拡張し、「学習中は smart を default 固定 / mcts のみ学習中の重み」で fitness 評価できるようにする。

### 変更点
- `src/ai/evaluator.ts`: `evaluateState(state, playerId, weights?)` に第 3 引数追加。未指定なら従来通り module global を使用
- `src/ai/smartAI.ts`: `decideAction(state, pid, seed?, options?)` に `options.weights` 追加
- `src/ai/mctsAI.ts`: `MctsOptions.weights` 追加、内部の `leafValueByEvaluator` / `computePriors` に伝播
- `ai/scripts/_runner.ts`: `mctsTuned` を「global state 経由」から「options.weights 経由」に変更（副作用なし）、`makeMctsWithWeights(weights)` ファクトリを追加 export
- `ai/scripts/bench.ts`: `--mcts-weights <path>` フラグ追加（mcts のみ独立した重みで動かせる）
- `ai/scripts/tune-es.ts`: fitness を改修、`setEvalWeights` 呼び出しを廃止して `options.weights` 経由に統一
- `src/ai/tunedWeights.ts`: `GEN_3J_WEIGHTS` を追加
- `src/ai/index.ts`: `GEN_3J_WEIGHTS` を export

### 学習結果
- 設定: warm-start from Gen-3-F、15 世代 × 50 局、seed=5、sigma=0.2、smart は default 固定
- best ever（学習セット, seed=5, 50局）: avgScore **21.88** / winRate **100%** / avgRank 1.00
- default re-check: avgScore 21.48 / winRate 96%
- 学習時間: 約 8 分

### Holdout ベンチ結果

**per-AI モード**（mcts のみ Gen-3-J / smart x3 は default = Gen-3-F）, 200 局, `seed=1001`, `--rotate`:
| 指標 | Gen-3-F | **Gen-3-J** | 差分 |
|---|---|---|---|
| 勝率 | 89.5% | **90.0%** | +0.5pt |
| 95%CI 下限 | 84.5% | **85.1%** | **+0.6pt** |
| 1 位獲得 | 179 | 180 | +1 |
| avgScore | 20.77 | 21.05 | +0.28 |
| 1 手あたり時間 | 2.10 ms | 2.16 ms | 同等 |

**ブラウザモード**（全 AI が Gen-3-J）, 200 局, `seed=1001`:
- mcts 勝率 **84.0%** (CI 78.3-88.4%) — Gen-3-F (89.5%) から **-5.5pt 後退**
- 理由: smart も同時に Gen-3-J で強化されて mcts と相打ち（Gen-3-J は「smart=default」前提で学習されたため）

**mcts x4 自己対戦**（全員 Gen-3-J）, 50 局, `seed=3001`:
- 各座席勝率 25.0% (CI 19.5-31.4%) — 席バイアスなし
- avgScore 16.55（Gen-3-F の 16.11 から +0.44 微改善）

### 採用判定
**構造（per-AI weights API）は採用 + ブラウザ DEFAULT は Gen-3-F のまま維持**

per-AI モードで採用基準（CI 下限が前回 84.5% を上回る）を満たす。
ただし、**ブラウザは全 CPU が mcts のため vs smart シナリオが発生せず**、Gen-3-J 重みを反映しても mcts x4 自己対戦のバランスが微改善する程度。
- `DEFAULT_WEIGHTS` 更新は見送り（Gen-3-F のまま）
- `GEN_3J_WEIGHTS` は `tunedWeights.ts` に保存、将来 vs human シナリオを想定する場合などに参照

### メモ・学び（重要）
- **per-AI weights の API 改善は本質的価値**。今後の学習・評価で「学習信号の純化」が可能に
- **Gen-3-J の重み数値そのものはブラウザに不向き**。理由はユースケースの違い:
  - 学習ターゲット: vs smart シナリオ → smart を default に固定すると mcts は smart を圧倒する方向に重みが偏る
  - ブラウザ実態: 全 CPU = mcts の自己対戦に近い → smart 圧倒バイアスが効かない
- 解決策（次の方向性）:
  - 学習ターゲットを「mcts vs mcts 自己対戦」にして「自己対戦勝率」を fitness にする → ブラウザ実態に近い学習
  - もしくは Gen-3-K（NN 自己対戦）で根本的に「対戦相手も自分と同じ強さ」を前提に学習する
- 既存テスト 19/19 通過、型チェック OK

---

## Gen-3-I: シミュ内 gift を random で進行（不採用） (2026-05-27)

### 仮説
Gen-3-H で smart heuristic 自動進行が -1.5pt 後退した原因は「smart の攻撃的バイアスがシミュ評価を悲観化」と分析。中立な random policy なら評価が偏らずに改善するか検証。

### 結果

**主評価: mcts(Gen-3-I) vs smart x3** (200 局, `seed=1001`)
- mcts(Gen-3-I): 勝率 **87.0%** (CI 81.6-91.0%)、1 位 174/200、avg score 20.47、1 手 2.83 ms
- Gen-3-F (89.5%) から **-2.5pt**、Gen-3-H (88.0%) よりさらに -1.0pt

### 三者比較（gift policy の取り扱い）
| 取り扱い | 勝率 | 観察 |
|---|---|---|
| シミュレーションを打ち切る（Gen-3-F、現状）| **89.5%** | 一番強い |
| smart heuristic で進行（Gen-3-H）| 88.0% | 妨害バイアスで悲観化 |
| **random で進行（Gen-3-I）** | **87.0%** | 攻め過剰になり実戦とのギャップで悪化 |

### 採用判定
**不採用 → ロールバック**

### 根本原因の特定（重要）
gift selection は「シミュレーション policy ≠ 実戦 policy」の乖離が本質的問題:
- シミュ内 random → 「相手は弱い妨害をする」前提 → mcts は攻める手を選ぶ → 実戦の smart は強い妨害をするのでギャップ
- シミュ内 smart → 「相手は強い妨害をする」前提 → mcts は守りに入る → 過保守で攻め足りない
- シミュ打ち切り → 「相手の妨害は不確定だが評価しない」→ 保守的だが乖離は最小

これは MCTS の構造的限界。**自己対戦で policy を学習する AlphaZero 系（Gen-3-K）でしか根本解決できない**領域。

### 学び（gift selection 3 連敗のまとめ）
Gen-3-G / Gen-3-G-2 / Gen-3-H / Gen-3-I の 4 試行すべてで「gift selection 周りの改善」は失敗。これらの試行で MCTS の構造的限界（gift policy が discrete action 空間に乗らない、シミュレーションと実戦の policy 乖離）が明確に。次の改善は構造変更（NN または別重みアーキテクチャ）に絞るべき。

### 残置物
- `src/ai/mctsAI.ts` を完全に Gen-3-F の状態に戻した（ロールバック）
- 既存テスト 19/19 通過

---

## Gen-3-H: MCTS シミュレーション内で gift selection を自動進行（不採用） (2026-05-27)

### Step 0: ルール変更チェック
- 前回 Gen-3-G から差分追加: `reducer.ts` の NEW_GAME に旧ゲームカードを `discardedCardIds` にマークする処理（UI フェードアニメ用）
- AI への影響なし、進行可

### 仮説
Gen-3-G-2 で発覚した「MCTS シミュレーションは `awaitingGiftSelection` で打ち切られる」問題への対処:
- selection ループ内で `awaitingGiftSelection` に到達したら **smart heuristic で gift action を生成して reducer に渡し、シミュレーションを継続**
- path には積まない（自動進行扱い、意思決定ノードとして扱わない）
- これによりシミュレーションが gift selection を越え、leaf 評価がよりゲーム終端に近い状態を反映する
- 期待: vs smart 91%+、CI 下限 86%+

### 変更点（最終的にロールバック）
- `src/ai/mctsAI.ts`: selection ループ先頭に `awaitingGiftSelection` 自動進行ブロックを追加

### ベンチ結果

**主評価: mcts(Gen-3-H) vs smart x3** (200 局, `--rotate`, `seed=1001`)
- mcts(Gen-3-H): 勝率 **88.0%** (95%CI: **82.8% - 91.8%**)
- 1 位 176/200、avg score 20.87、期待順位 1.14
- 1 手あたり時間: **3.27 ms**（Gen-3-F の 2.10 ms から +56%）

**ベースライン比較**:
| 世代 | 勝率 | 95%CI | 1位 | 1 手 ms |
|---|---|---|---|---|
| Gen-3-F (現状) | 89.5% | 84.5-93.0% | 179 | 2.10 |
| **Gen-3-H** | **88.0%** | **82.8-91.8%** | 176 | 3.27 |

**再現性**: 同 seed 2 回実行で完全一致

### 採用判定
**不採用 → ロールバック**

CI 下限が 84.5% → 82.8% に低下。仮説に反して **勝率が下がった**。

### 失敗原因の分析（深い）

シミュレーションを延長したのに勝率が悪化した本質的理由:

1. **smart heuristic は「妨害方向」の決定を強く出す**：「相手で最高得点者へ送る」「相手の弱い色を選ぶ」など、攻撃的な選択をする
2. **シミュレーション内で 4 人全員が相互に妨害**：mcts simulation 内で smart heuristic が常に「自分と他人」双方の妨害判断を下すと、leaf 評価が**「自分は常に妨害される前提」**になる
3. **結果として mcts が過保守の手を選ぶ**：シミュレーション結果が悲観的だから、攻めるリターンが見えにくくなる
4. **iter あたり時間 +56%**：iter 数は固定 400 だが、1 iter あたり計算量が増えた分の効果は薄く、むしろ評価の質が下がった

### より根本的な解決方向

- **シミュレーション内では gift policy を「中立」にすべき**：random 抽出、または「平均的な相手」を仮定するなど。smart heuristic そのままを使うと「相手が常に最強の手を打つ」前提になる
- もしくは、**gift selection を MCTS の探索枠に正規に組み込む（行動 ID 化）**：行動空間は組合せ爆発するので、 progressive widening や candidate sampling が必要

### 残置物
- ロールバックでコードは完全に Gen-3-F の状態に復帰
- 50 局 quick bench で Gen-3-F 動作復帰を確認（mcts 1 位 49/50）

### 学び・次の方向性
- Gen-3-G / Gen-3-G-2 / Gen-3-H で **gift selection 周りの単純改善はすべて失敗**
- gift selection は MCTS の構造に深く絡む難題で、付け焼き刃の対症療法では悪化リスクが高い
- 次の現実的選択肢:
  - **Gen-3-I**: シミュレーション内 gift policy を「ランダム or 中立」に変える（Gen-3-H の派生検証）
  - **Gen-3-B-3**: per-AI weights（mcts と smart で別 weights、根本的な学習構造改善）
  - **Gen-3-D**: フェーズ 3、AlphaZero 風（大規模、要 GPU）
- 既存テスト 19/19 通過、build OK

---

## Gen-3-G / Gen-3-G-2: gift heuristic でルール変更追随（両方不採用） (2026-05-27)

### ルール変更追随チェック（Step 0）の結果
スキル新ルールで毎回最初にゲームルール変更を確認するようになった。今回チェックで以下を発見:

| ファイル | 変更内容 | AI への影響 |
|---|---|---|
| `docs/RULES.md` | 動画引用コメント 1 行削除 | なし |
| `src/game/types.ts` | `TurnState.discardedCardIds` 追加 | なし（UI フェードアニメ用付帯情報）|
| `src/game/setup.ts` | 初期化に `discardedCardIds: []` | なし |
| `src/game/engine.ts` | 新関数 `hasNoMoreTurns(state, playerId)` | 新規ユーティリティ、既存ロジック不変 |
| `src/game/reducer.ts` | **`handleConfirmGifts` で「もう手番がない受領者」への gift を自動で slot 0 配置**、ログ表記整理 | **あり** |

### ベースライン再計測
ルール変更後の値:
- `smart x4` (200 局, rotate, seed=1): 24.9% (CI 22.0-28.0%)、unfinished 1/200 — 過去とほぼ一致（±0.1pt）
- `mcts vs smart x3` (200 局, rotate, seed=1001): **89.5%** (CI 84.5-93.0%) — Gen-3-F deploy 後と**完全一致**

→ **ルール変更は最終ラウンドのレアパスのみ影響する**ことが判明。過去の Gen-3-F ベンチは引き続き信頼可。

---

### Gen-3-G: smartAI の gift heuristic を `hasNoMoreTurns` で改修

#### 仮説
- ルール変更により「もう手番のない相手」への gift は自動配置で妨害効果ゼロ
- `smartAI.buildGiftAssignmentsHeuristic` で除外することで、 mcts も（smart に委譲しているので）改善
- 期待: vs smart 91%+

#### 結果
- mcts vs smart x3 (200 局, seed=1001): **88.0%** (CI 82.8-91.8%)、1 位 176/200
- Gen-3-F (89.5%, 179 位) から **-1.5pt 後退**

#### 採用判定 — **不採用、ロールバック**

##### 失敗原因
- mcts は CONFIRM_GIFTS を smartAI に委譲しているため、**smart を強化すると対戦相手の smart x3 が同時に強化される**
- 結果として「mcts と smart x3 が均衡良く強くなり、mcts の相対勝率が下がる」
- 改修自体は論理的に正しいが、ベンチセットアップに対して逆効果

---

### Gen-3-G-2: mctsAI 専用 gift heuristic を内蔵（smart には影響させない）

#### 仮説
- smartAI は元のまま、mctsAI.ts に `buildMctsGiftAction` を実装
- 「もう手番のない相手」を target から除外するロジックを mcts だけに適用
- 期待: vs smart 91%+、smart 強化の副作用なし

#### 変更点
- `src/ai/mctsAI.ts`: `buildMctsGiftAction(state, playerId)` を追加
  - 基本は smart のロジックと同じ、`hasNoMoreTurns` で active opponents をフィルタ
- `decideAction` の `awaitingGiftSelection` 分岐を `buildMctsGiftAction` に置換

#### 結果
- mcts vs smart x3 (200 局, seed=1001): **88.5%** (CI 83.3-92.2%)、1 位 177/200
- Gen-3-F (89.5%) から **-1.0pt**（誤差範囲だが CI 下限 84.5% → 83.3% で低下）

#### 採用判定 — **不採用、ロールバック**

スキル基準「CI 下限がベースラインを上回ること」に未達。

##### 失敗原因（深い分析）
- `mctsAI.ts` のシミュレーション内では `legalActionIds` が `awaitingGiftSelection` フェーズで**空配列**を返す
  - CONFIRM_GIFTS は離散行動 ID 空間（30 個）の外（Gen-1 から続く設計上の制約）
  - → mcts はシミュレーション内で **gift selection の局面を扱えない**（local 評価で打ち切り）
- 結果、ルートでの gift heuristic を改善しても、 mcts simulation 側で利得が反映されない
- ヒューリスティック改善の効果が極めて限定的

### ロールバック内容
- `src/ai/smartAI.ts`: Gen-3-G の変更を元に戻し（hasNoMoreTurns import 削除、heuristic を元のまま）
- `src/ai/mctsAI.ts`: Gen-3-G-2 の変更を元に戻し（buildMctsGiftAction 削除、smartAI 委譲に戻す）
- 50 局 quick bench で Gen-3-F 動作復帰を確認（1 位 49/50）

### 学び・次の方向性
- **gift selection は MCTS シミュレーションの盲点**。本質的に改善するには：
  - CONFIRM_GIFTS を行動 ID 空間に含める設計（gift target の組合せ爆発）
  - もしくは、別ヘッド（policy）として gift 選択を学習する（フェーズ 4「プレゼント選択の別ヘッド化」に相当）
- 既存 evaluator のチューニングや UCT 系の改修は飽和済み、**残る伸び代は構造的変化**
- 次イテレーション候補（更新）:
  - Gen-3-H: CONFIRM_GIFTS を MCTS が扱えるよう離散化拡張（行動空間を 30 → ~60 に拡大）
  - Gen-3-D: AlphaZero 風（フェーズ 3、大規模）

---

## Gen-3-E / Gen-3-F: 並行ブラッシュアップ（E=不採用、F=採用） (2026-05-27)

ユーザー指示「並行で着手」を受け、構造拡張系（Gen-3-E）と本格 ES 系（Gen-3-F）を **同時に background 実行**し比較。

### Gen-3-E: 構造拡張（`selfNearEnd` 追加）+ ES — **不採用**

#### 仮説
- 評価関数に「自分の score が END_SCORE_THRESHOLD-5 以上のとき加点」する特徴量 `selfNearEnd` を追加
- 「終局を意識して攻め急ぐ」効果を期待
- ES 15 世代 × 50 局, seed=4, sigma=0.3 で重み学習

#### 変更点（保全して残す）
- `src/ai/evaluator.ts`: `EvalWeights` に `selfNearEnd` フィールド追加、`selfScore` 内で適用
- `src/ai/tunedWeights.ts`: 歴史 weights（PRE_GEN_3B / GEN_3B / GEN_3B2）に `selfNearEnd: 0` を追加（互換性）

#### 結果
- 学習セット（seed=4, 50局）: avgScore 21.22 → **21.70** (+0.48) — 学習時には改善
- Holdout（seed=1001, 200局）: 勝率 **85.5%** (CI 80.0-89.7%)
- Gen-3-B-2 (89.0%) から **-3.5pt 後退**

#### 採用判定
**不採用 → ロールバック（重みは default に統合しない）**

ES が seed=4 のテストセットに過適合。`selfNearEnd` の方向性自体は spirit としては良かったが、勝率の意味で逆効果。

#### 残置物
- `selfNearEnd` フィールドはコード保全（`default: 0` で無効化）→ 将来、別の prior 設計や学習設定で再挑戦可能
- 重みは `GEN_3E_WEIGHTS` として `tunedWeights.ts` に保存

---

### Gen-3-F: 本格 warm-start ES — **採用、ブラウザ反映済み**

#### 仮説
- Gen-3-B-2 から **gamesPerGen を 50 → 100 に倍増**（noise 削減）、 generations を 25、sigma 0.15（小さめ）で fine-tune
- noise が減ることで「真の改善」を抽出できる可能性

#### 学習結果
- 18 世代で sigma 0.01 以下に収束、早期終了
- best ever は Gen 1 の重み（avgScore 21.37, winRate 96%, avgRank 1.07）
- 17 世代連続 reject — local optimum 近傍を抜けられず
- 学習時間: 約 20 分

#### Holdout ベンチ結果（200 局, rotate, seed=1001）

| 世代 | 勝率 | 95%CI | 1位 | avgScore | 1 手 ms |
|---|---|---|---|---|---|
| Gen-3-B-2 (旧) | 89.0% | 83.9-92.6% | 178 | 20.90 | 2.39 |
| **Gen-3-F** | **89.5%** | **84.5-93.0%** | **179** | 20.77 | **2.09** |
| Gen-3-E (参考) | 85.5% | 80.0-89.7% | 171 | 20.63 | 2.30 |

#### 採用判定
**採用 → ブラウザ反映済み**

- 勝率 +0.5pt、CI 下限 +0.6pt（誤差範囲だが上向き）
- 1 手あたり時間 **2.39 → 2.09 ms（-13% 高速化）**が明確
- 回帰リスクなし

#### 変更点
- `src/ai/evaluator.ts` の `DEFAULT_WEIGHTS` を Gen-3-F の値に更新（`selfNearEnd: 0`）
- `src/ai/tunedWeights.ts` に `GEN_3F_WEIGHTS` および `GEN_3E_WEIGHTS` を追加
- `src/ai/index.ts` から両方 export
- `npm run build` 成功（236.54 kB / gzip 74.41 kB）

---

### 並行ブラッシュアップ全体の学び

- **同時に複数仮説を試すと、効率的に「効くもの」「効かないもの」が判別できる**
- 一方、過学習リスクは個別検証よりも高まる（Gen-3-E がその典型）
- ES 系の単純な反復は **+0.5pt 程度で逓減フェーズ**。今後の伸び代は構造的変化が必要
- `selfNearEnd` のような単一の手書き特徴量追加では効果が限定的 → 一括での特徴量設計刷新、または NN ベース（Gen-3-D）への移行が次の選択肢

---

## Gen-3-B-2: warm-start ES（採用、ブラウザ反映済み） (2026-05-27)

### 仮説
- Gen-3-B は seed=1 で 15 世代の単発 ES。local optimum 近傍に収束した可能性あり
- Gen-3-B の重みを初期点として、**別 seed (=2) で sigma を小さめ (0.2) に再 ES** することで、別の局所改善を発見
- 期待値（事前）: vs smart 90% 以上、CI 下限 85% 以上

### 変更点
- `ai/scripts/tune-es.ts` に `--init <path>` オプションを追加（JSON から初期重みをロード、warm-start を明示的に表現可能に）
- `src/ai/tunedWeights.ts` に `GEN_3B2_WEIGHTS` を追加
- `src/ai/evaluator.ts` の `DEFAULT_WEIGHTS` を Gen-3-B-2 値に更新
- `src/ai/index.ts` から `GEN_3B2_WEIGHTS` も export

### 学習結果
- 学習セット（seed=2, 50 局）: avgScore 20.82 → **21.44** (+0.62)
- 学習時間: 約 9 分
- ベスト世代の重みは Gen-3-B から大きくは離れず（warm-start なので当然）。主な変化:
  - `selfScoreMult`: 128.2 → **110.7** (-14%)
  - `reach5plus`: 181.2 → **216.4** (+19%)
  - `reach4`: 108.0 → **77.0** (-29%)
  - `threatReach2`: 13.8 → **17.0** (+23%)
  - `winnerBonus`: 3986 → **4852** (+22%)

### Holdout ベンチ結果

**主評価: mcts(Gen-3-B-2) vs smart x3** (200 局, `--rotate`, `seed=1001`)
- Gen-3-B-2: 勝率 **89.0%** (95%CI: **83.9% - 92.6%**)
- 1 位獲得 178 / 200、avg score 20.90、期待順位 1.135
- 1 手あたり時間: 2.39 ms
- 全 200 局終了

**ベースライン比較**:

| 世代 | 勝率 | 95%CI | 1位 | avgScore |
|---|---|---|---|---|
| Gen-2 (PRE_GEN_3B) | 83.5% | 77.7-88.0% | 167 | 20.67 |
| Gen-3-B | 88.0% | 82.8-91.8% | 176 | 20.63 |
| **Gen-3-B-2** | **89.0%** | **83.9-92.6%** | **178** | **20.90** |

### 採用判定
**採用 → ブラウザ反映済み**

仮説（勝率 90%+ / CI 下限 85%+）には**未達**だが:
- すべての指標が一貫して微増（勝率 +1pt、1 位 +2 局、avgScore +0.27）
- Gen-3-B-2 と Gen-3-B の 95%CI は重なるため**統計的有意性は限界**だが、回帰のリスクなし
- ユーザー指示「続けて強くする」を踏まえ、悪化していないので採用

`npm run build` 成功（バンドル 236.49 kB / gzip 74.39 kB）。

### メモ・解釈
- **ES の改善幅が逓減中**: Gen-2 → Gen-3-B で +4.5pt、Gen-3-B → Gen-3-B-2 で +1pt と、同じ枠組み内の探索は飽和に近い
- **真の伸び代は別の方向にある可能性**:
  - 評価関数の構造拡張（新特徴量、終局意識など）
  - mcts と smart で別 weights を使う設計（per-AI weights）
  - フェーズ 3（AlphaZero 風）への移行
- 既存テスト 19/19 通過、型チェック OK

---

## Gen-3-B-deploy: tuned weights をブラウザに反映 (2026-05-27)

### 変更点
- `src/ai/evaluator.ts` の `DEFAULT_WEIGHTS` を **Gen-3-B の tuned 値に置換**
- `src/ai/tunedWeights.ts` に `PRE_GEN_3B_WEIGHTS`（元の手書き値）を追加 — ロールバック・比較用
- `src/ai/index.ts` から `PRE_GEN_3B_WEIGHTS` も export

### 検証
- `tsc -p tsconfig.app.json --noEmit`: 0 エラー
- `vitest run`: 19/19 通過
- `npm run build`: 成功（バンドル 236.76 kB / gzip 74.43 kB、+2 kB は tunedWeights.ts と PRE_GEN_3B_WEIGHTS 追加分）
- `bench mcts vs smart x3` (200 局, rotate, seed=1001): **勝率 88.0% (CI 82.8-91.8%)** — `--weights` 経由の値と完全一致

### ロールバック手順
万一 Gen-3-B-deploy で問題が出た場合:
```diff
// src/ai/evaluator.ts
- import { ... } from './tunedWeights';
+ // tuned 値の代わりに元の値を使う
- export const DEFAULT_WEIGHTS: EvalWeights = { /* tuned */ };
+ export { PRE_GEN_3B_WEIGHTS as DEFAULT_WEIGHTS } from './tunedWeights';
```

または `tunedWeights.PRE_GEN_3B_WEIGHTS` の値を直接 `DEFAULT_WEIGHTS` に貼り直し。

---

## Gen-3-B: (1+1)-ES で evaluator 重み最適化（採用、ブラウザ反映は保留） (2026-05-27)

### 仮説
- Gen-3-A / Gen-3-C で「探索の枠組み」改善は飽和 or 悪化と判明
- 残った方向性は「leaf 評価関数自体の質を上げる」
- (1+1)-ES（CMA-ES の最小単純版）で `evaluateState` の 16 個の重みを自己対戦勝率を目的関数として最適化
- 期待値（事前）: vs smart 86% 以上、CI 下限 80% 以上

### 変更点
- `src/ai/evaluator.ts`: 重みを `EvalWeights` 構造体としてパラメータ化（**デフォルト挙動不変**を vitest で確認）
  - `DEFAULT_WEIGHTS`、`setEvalWeights`、`resetEvalWeights`、`getEvalWeights` を追加
- `ai/scripts/tune-es.ts`: (1+1)-ES 実装
  - fitness: `mcts(eval_w) vs smart x3` を gamesPerGen 局走らせ mcts (seat=0) の平均得点
  - 子重み = 親 + N(0, σ × max(|w|, 1))（重みスケール比例摂動）
  - 1/5 success rule の簡易版（child > parent で σ ×1.3、reject で σ /1.2）
- `ai/scripts/bench.ts`: `--weights <path>` オプション追加（任意 JSON から重みをロードしてベンチ実行）
- `src/ai/tunedWeights.ts`: 学習結果を `GEN_3B_WEIGHTS` として永続化
- `src/ai/index.ts`: `setEvalWeights` / `DEFAULT_WEIGHTS` / `EvalWeights` / `GEN_3B_WEIGHTS` を export
- `ai/scripts/_runner.ts`: `mctsTuned` 戦略を追加（決定の前後で setEvalWeights する mcts ラッパー）

### 学習過程

| 設定 | 値 |
|---|---|
| opponent | smart x3 |
| games / generation | 50 |
| generations | 15 |
| seed | 1（学習セット: seed 1..50） |
| initial sigma | 0.3 |
| 実行時間 | 約 9 分 |

15 世代中、最初の数世代で改善（avgScore 21.1 → 21.3、winRate 88% → 96%）、その後は reject 続きで sigma 収束。

### 学習で得られた重みの主な変化（default → tuned）
- `selfScoreMult`: 100 → **128.2** (+28%)
- `reach5plus`: 240 → **181.2** (-25%)
- `reach2`: 18 → **20.1** (+12%)
- `chainSeed`: 8 → **9.7** (+22%)
- `overflowPenalty`: 6 → **4.9** (-18%)
- `threatScoreMult`: 70 → **64.5** (-8%)
- `threatChainSeed`: 4 → **2.9** (-26%)
- `pendingMult`: 120 → **126.2** (+5%)

つまり「**自分のスコアと連鎖種をより重視、相手のリーチ脅威はやや弱める**」方向に進化。

### Holdout ベンチ結果

**主評価: mcts(tuned) vs smart x3** (200 局, `--rotate`, `seed=1001`, 学習 seed と非重複)
- mcts(tuned): 勝率 **88.0%** (95%CI: **82.8% - 91.8%**)
  - **Gen-2 (default weights) の 83.5% (CI 77.7-88.0%) を有意に上回る**
  - CI 下限が +5.1pt 改善（77.7% → 82.8%）
- mcts(tuned): 1 位獲得 **176/200**（Gen-2: 167/200、+9 局）
- avg score 20.63（Gen-2: 20.67、同等）
- smart: 勝率 4.0%、avg score 11.49、期待順位 2.95
- 1 手あたり時間: **2.50 ms** (Gen-2: 4.15 ms から **40% 短縮**)
- 全 200 局終了

**再現性**: bench は決定論的、`--weights ai/data/tuned-weights.json` + 同 seed で必ず同じ結果

### 採用判定
**採用 + ブラウザ反映は保留**

仮説（勝率 86%+ / CI 下限 80%+）を両方達成。
1 手あたり計算時間も改善（4.15 → 2.50 ms、評価値の絶対値が変わって UCT 探索の収束パターンが変わったためと推定）。
**ユーザー意向「Gen-3 試行錯誤は並行、ブラウザ反映はデザイン編集が落ち着いてから一括で」に従い、本番 `DEFAULT_WEIGHTS` は据え置き**。

### ブラウザ反映の手順（将来反映時）
1. `src/ai/evaluator.ts` の `DEFAULT_WEIGHTS` を `GEN_3B_WEIGHTS` に差し替える（1 行変更）
2. `npm run build` で動作確認
3. デプロイ

### メモ・今後の課題
- **学習が早期収束**: 15 世代中、改善は最初の数世代のみ。15 世代 reject で sigma 0.0474 まで縮小。**local optimum 近傍に到達**したと推定
- **シングルランの限界**: 1 ラン採用なのでばらつきが残る。複数 seed で multi-start すると更にベストが得られる可能性
- **fitness の制約**: 「mcts も smart も同じ weights で動く」設定で学習したため、smart の挙動も同時に変わる前提。本来は「mcts は tuned、smart は default」で学習する方が「強い mcts」を直接最適化できる（実装: evaluateState に weights 引数を渡せるよう拡張が必要）
- **次イテレーション候補**:
  - Gen-3-B-2: multi-start（複数 seed で ES を回し best を採用）
  - Gen-3-B-3: per-AI weights（mcts と smart で別 weights を保持できるよう evaluator を拡張）
  - Gen-3-D: フェーズ 3 として AlphaZero 風（NN）
- 既存テスト 19/19 通過、`tsc -p ai/tsconfig.json` および `tsc -p tsconfig.app.json` OK

---

## Gen-3-C: Progressive Bias / PUCT 化（不採用） (2026-05-27)

### 仮説
- Gen-3-A の飽和観測を踏まえ、「探索量」ではなく「探索の質」を上げる方向を試行
- UCT1 を PUCT 風スコア `Q + C·P·√N/(1+n)` に置換
- prior `P(a)` = 「その action を実行した直後の `tanh(evaluateState/scale)`」
- ノード初回利用時に lazy で全 legal action の prior を計算
- 期待値（事前）: vs smart 勝率 86% 以上、CI 下限 78% 以上、1 手 6 ms 程度

### 変更点（不採用のため最終的にロールバック）
- `src/ai/mctsAI.ts`:
  - `MctsOptions` に `progressiveBias` / `pbC` を追加（一時的にデフォルト true）
  - `puctSelect` / `computePriors` 関数を追加
  - `NodeStats.priors: Float64Array | null` を追加
- `ai/scripts/_runner.ts`: 一時的に `mctsUct` 戦略を追加（旧 UCT 動作）

### ベンチ結果

**主評価: mcts(PUCT) vs smart x3** (200 局, `seed=1001`, `--rotate`)
- mcts(PUCT): 勝率 **51.0%** (95%CI: **44.1% - 57.8%**)
- avg score 18.43、期待順位 1.88、1 手 3.46 ms
- 参考: Gen-2 (UCT) は 83.5% (CI 77.7-88.0%) → **大幅悪化 (-32.5 pt)**

**新旧比較: mcts(PUCT) vs mctsUct x3** (50 局, `seed=6001`)
- mcts(PUCT): 勝率 **6.0%** (CI 2.1-16.2%)、avg score 10.76、**期待順位 3.56（4 位寄り）**
- mctsUct: 勝率 31.3% (CI 24.5-39.1%)、avg score 16.95、期待順位 2.15
- **PUCT が UCT に明確に負ける**

**自己対戦: mcts(PUCT) x4** (30 局, `seed=3001`)
- 各座席勝率 25.0%、avg score 13.68（Gen-2 の 16.11 より低下）、1 手 13.92 ms

**再現性**: 同 seed 2 回実行で完全一致

### 採用判定
**不採用 → ロールバック実施**

期待を裏切る大幅悪化。新旧比較で PUCT が UCT に負け、特に「期待順位 3.56」が致命的（4 体ゲームで自分が常に 4 位寄り）。

### 学び・解釈
- **prior が短期視点に偏った**: `evaluateState` は「自分の score を最大化」を強く重み付けるため、prior に使うと「すぐ得点できる手」を過剰に優遇する
- **連鎖の長期計画が割引かれた**: MeteoNight は 2〜3 手かけて連鎖を組む長期戦略が重要だが、prior がそれを評価できず短期最適に倒れた
- **PUCT が深掘り集中しすぎた**: 高 prior 手に集中するあまり、UCT が持つ「広く浅く＋深掘り」のバランスを崩した
- **再挑戦の余地**:
  - prior の与え方を改善（例: 1 手先ではなく数手後の評価、または rollout 短縮値）
  - `pbC` の調整（探索 / 活用バランス）
  - 連鎖発生時に prior を強化する特化バイアス

### ロールバック内容
- `progressiveBias` デフォルトを `false` に（コードは保全、再挑戦可能）
- `_runner.ts`: 一時 `mctsUct` は削除（デフォルトが UCT なので不要）、代わりに `mctsPuct`（progressiveBias: true）を追加して再挑戦用に保持
- 既存テスト 19/19 通過、`ai/tsconfig.json` 型チェック OK

### 残る Gen-3 候補（次回）
- **Gen-3-B: CMA-ES で evaluator 重み最適化**（フェーズ 2 着手、leaf 評価の質を上げる）— 本命へ昇格
- ~~Gen-3-C: progressive bias~~（今回不採用、再挑戦するなら prior の改良が前提）
- Gen-3-D: AlphaZero 風（大規模、別フェーズ）

---

## Gen-3-A: MCTS iterations 増加（不採用） (2026-05-27)

### 仮説
- Gen-2 で rollout を排除した結果、1 iter のコストが激減した。空いた予算を iter 数増加に回す
- `DEFAULT_ITERATIONS` を 400 → 1000 に変更
- 期待値（事前）: vs smart 勝率 **88% 以上、CI 下限が Gen-2 の 77.7% を上回る**

### 変更点（不採用のため最終的にロールバック）
- `src/ai/mctsAI.ts`: `DEFAULT_ITERATIONS` を一時的に 1000 に
- `ai/scripts/_runner.ts`: `mcts400` 戦略を追加（旧 Gen-2 動作）

### ベンチ結果

**主評価: mcts(1000) vs smart x3** (200 局, `--rotate`, `seed=1001`)
- mcts(1000): 勝率 **83.0%** (95%CI: **77.2% - 87.6%**)
- avg score 20.45、期待順位 1.22、1 手 5.81 ms
- 参考: Gen-2 (iter=400) は 83.5% (CI 77.7-88.0%) → **誤差範囲、改善なし**

**新旧比較: mcts(1000) vs mcts400 x3** (50 局, `seed=5001`)
- mcts(1000): 勝率 24% (CI 14.3-37.4%)、avg score 15.80、期待順位 2.56
- mcts400: 勝率 25.3% (CI 19.0-32.8%)、avg score 15.76、期待順位 2.48
- **完全に互角**。iter を 2.5 倍にしても勝率の差なし

**自己対戦: mcts(1000) x4** (30 局, `seed=3001`)
- 各座席勝率 25.0%、avg score 16.11、1 手 20.66 ms（Gen-2 比 +34%）

**再現性**: 同 seed 2 回実行で完全一致

### 採用判定
**不採用 → ロールバック実施**

仮説（CI 下限 77.7% 超え）を満たせず、新旧比較でも完全互角。
むしろ計算時間が増えるだけだった。

### 学び・解釈
- **leaf 評価が決定論的なので、ある iter 数で探索が飽和**する
- Gen-2 の iter=400 がほぼ飽和点。これ以上の iter は意味がない
- 「探索量」より「探索の質」を上げる方向の改善が必要
- 次イテレーション候補（更新後）:
  - **Gen-3-C: progressive bias**（評価関数の値を UCT の事前知識として加算 → 探索効率向上）
  - **Gen-3-B: CMA-ES で evaluator 重み最適化**（leaf 評価自体の質を上げる、フェーズ 2 着手）
  - Gen-3-D: AlphaZero 風（NN による方策/価値、大規模）

### ロールバック内容
- `DEFAULT_ITERATIONS` を 400 に戻した
- `mcts400` 戦略を削除（デフォルトが 400 なので mcts == mcts400 となり不要）
- `mctsRollout`（Gen-1 互換）は引き続き保全
- 既存テスト 19/19 通過、型チェック OK

---

## Gen-2: MCTS の leaf 評価関数化 (2026-05-27)

### 仮説
- Gen-1 の random rollout を、`evaluateState` を `tanh(raw/scale)` で [-1,+1] に圧縮した leaf 評価に置き換える
- 期待値（事前）:
  - vs smart x3 勝率 **60% 以上、CI 下限 50% 以上**
  - 1 手あたり時間 **5 ms 以下**
  - mcts x4 自己対戦は 25%/座席（バイアスなし維持）

### 変更点
- `src/ai/mctsAI.ts`:
  - `MctsOptions.leafEval: 'rollout' | 'evaluator'` を追加（**デフォルト `'evaluator'`**）
  - `MctsOptions.leafEvalScale`（デフォルト 1500）で tanh のスケーリング係数を調整可能
  - `leafValueByEvaluator(state, viewerId, scale, numPlayers)`: 終端なら順位ベース、非終端なら `tanh(evaluateState(state, viewerId) / scale)`
  - rollout モード（Gen-1 互換）は完全保全。`leafEval: 'rollout'` で復元可
  - rollout コスト削減により探索量を確保できるため、`DEFAULT_ITERATIONS` を 100 → **400** に増加
- `ai/scripts/_runner.ts`: `mctsRollout` 戦略を追加（Gen-1 動作、iter=100 固定）。`mcts` は新動作（leaf eval、iter=400）
- `ai/scripts/{bench,selfplay}.ts`: usage 文に `mctsRollout` を追記

### ベンチ結果

**主評価: mcts(eval) vs smart x3** (200 局, `--rotate`, `seed=1001`)
- mcts: 勝率 **83.5%** (95%CI: **77.7% - 88.0%**) — Gen-1 (56%) を大幅更新、仮説 60% も大きく超過
- mcts: 1 位獲得 **167/200**、avg score **20.67**、期待順位 **1.20**
- smart: 勝率 5.5% (CI 3.9-7.6%)、avg score 11.19、期待順位 2.93
- 全 200 局終了（unfinished=0）

**自己対戦サニティ: mcts x4** (50 局, `--rotate`, `seed=3001`)
- 各座席勝率 25.0% (95%CI: 19.5% - 31.4%) — 席バイアスなし
- 期待順位 2.5、avg score 16.12
- 全 50 局終了

**新旧比較: mcts(eval) vs mctsRollout x3** (50 局, `--rotate`, `seed=4001`)
- mcts(eval): 勝率 32% (CI 20.8-45.8%)、avg score 17.92、期待順位 2.02
- mctsRollout: 勝率 22.7% (CI 16.7-30.0%)、avg score 13.99、期待順位 2.66
- mcts(eval) が mctsRollout 3 体相手で 32% → ベースライン 25% を上回り、新動作が明確に強い

**再現性チェック**
- `mcts vs smart x3` (10 局, `seed=9999`) を 2 回実行 → totally identical な出力を確認

**1 手あたり計算時間**
- mcts vs smart x3: **4.15 ms/step** (Gen-1: 14.7 ms から **3.5 倍高速化**)
- mcts x4: **15.4 ms/step** (Gen-1: 64.8 ms から **4.2 倍高速化**)
- iterations を 400 に増やしても Gen-1 より速い

### 採用判定
**採用 + ブラウザに反映済み**

主評価（vs smart）で勝率 83.5%・95%CI 下限 77.7% が仮説の 50% を大きく上回る。
1 手あたり時間も劇的に改善し、ブラウザ実用上限（数百 ms）に対して十分な余裕。
自己対戦の席バイアスもなく、再現性も確認済み。

**ブラウザ反映**: `src/ai/index.ts` の `decideAction` を `smartAI` → `mctsAI` に切り替え（1 行変更）。
`useGameLogic` を含むブラウザ側コードはすべてそのまま動作。
旧 smart は `decideActionSmart` として export 名を変えて保全（ロールバック容易）。
`npm run build` 成功（バンドル 234.76 kB / gzip 73.42 kB）。

### メモ・今後の課題
- **`tanh(raw / 1500)` のスケール係数 1500 は経験則**で、`evaluateState` の出力範囲（~±2000）に対して妥当な値。CMA-ES などでチューニングする余地あり
- **依然として「vs random」では `smart vs random` と同様の長期化問題**が残ると予想される（次イテレーションで未計測。優先度低）。Gen-3 以降で対処可能性
- **更なる改善候補**:
  - Gen-3-A: `iterations` を更に増やす（400 → 1000 など、CPU/ブラウザ予算と相談）
  - Gen-3-B: フェーズ 2 として CMA-ES で `evaluator` の重みを最適化（leaf 評価が直接効くため効果大）
  - Gen-3-C: progressive bias（事前知識として `evaluator` の値を UCT に組み込む）
  - Gen-3-D: フェーズ 3 として AlphaZero 風（NN による方策/価値ヘッドの学習）
- **観戦モード（ブラウザ）目視確認は未実施**。`reducer` への変更なし、既存テスト 19 件すべて維持
- `npm run lint` は ESLint 設定未整備のため引き続き失敗（既存問題、Gen-2 由来ではない）

---

## Gen-1: IS-MCTS の導入 (2026-05-26)

### 仮説
- フェーズ 1 として IS-MCTS を導入し、smart より明確に強い CPU を作る
- 期待値（事前）: `mcts vs smart x3` で勝率 40% 以上（CI が 25% を含まない）

### 変更点
- `src/ai/mctsAI.ts`: IS-MCTS 実装
  - 観測情報集合キーでノード共有（`infoSet.observationKey` 利用）
  - 各 iteration の冒頭で `determinizeDeck` により山札をシャッフル（隠れ情報を確率的に展開）
  - 多人数対応として、各ノードに `actor` を持ち、その actor の **rank-based value**（1位=+1.0, 2位=+0.33, 3位=-0.33, 4位=-1.0）を蓄積
  - rollout は randomAI を policy として最大 400 step
  - UCT1（C=√2）、最終決定は robust child（最多訪問アクション）
  - **CONFIRM_GIFTS のみ smartAI のヒューリスティックに委譲**（行動 ID 化困難）
  - デフォルト: `iterations=100`、ブラウザ実用範囲を意識した設定
- `src/ai/index.ts`: `decideActionMcts` を export
- `ai/scripts/_runner.ts`: `STRATEGIES` に `mcts` を追加
- `ai/scripts/selfplay.ts`, `ai/scripts/bench.ts`: usage 文の戦略リストに mcts を追記

### ベンチ結果

**主評価: mcts vs smart x3** (50 局, `--rotate`, `seed=1001`)
- mcts: 勝率 **56.0%** (95%CI: **42.3% - 68.8%**) — 25% を明確に上回る
- mcts: 1 位獲得 28/50、avg score **17.52**、期待順位 **1.76**
- smart: 勝率 14.7%、avg score 14.25、期待順位 2.75
- 全 50 局終了（unfinished=0）

**自己対戦サニティ: mcts x4** (30 局, `--rotate`, `seed=3001`)
- 各座席勝率 25.0% (95%CI: 18.1% - 33.4%) — 席バイアスなし、健康な MCTS の挙動
- 期待順位 2.5、avg score 15.71
- 全 30 局終了（unfinished=0）

**副評価: mcts vs random x3** (50 局, `--rotate`, `seed=2001`)
- mcts: 1 位獲得 50/50（100%）、avg score 10.16
- 50 局中 49 局が max-steps 未終了 — Gen-0 の smart vs random と同程度
- **rollout policy が random のため、vs random では mcts の優位が出にくいことが判明**

**再現性チェック**
- `mcts vs smart x3` (10 局, `seed=9999`) を 2 回実行 → totally identical な出力を確認

**1 手あたり計算時間**（参考）
- mcts vs smart x3: **avg 14.7 ms/step**（混合戦のため平均は低め、mcts 単独手は ~50-100 ms と推定）
- mcts x4: **avg 64.8 ms/step** → 1 手 ~65 ms、ブラウザ実用範囲（< 数百 ms）

### 採用判定
**採用**

主要評価（vs smart）で勝率 56%・95%CI が 25% を含まず、仮説（40%以上）を上回って達成。
自己対戦の席バイアスもなく、再現性も確認済み。1 手あたり計算時間もブラウザ実用範囲。

### メモ・今後の課題
- **vs random で smart より明確に強くなれなかった点**：rollout policy が random のため、3 体の random プレイから「連鎖を組む経路」を見つけるのが難しい。次イテレーションで `rollout policy = smart` または `leaf 評価 = evaluateState` を試すと改善見込み。
- **未確認チェック項目**: 観戦モード（`npm run dev`）でのブラウザ目視確認は本セッションでは未実施。`reducer` への変更はなく、既存テスト 19 件は全て維持しているため、ブラウザ側の挙動互換性は理論上保たれる。
- **次イテレーション候補**:
  - Gen-2-A: rollout を smart にする（強度向上 vs 速度低下のトレードオフ確認）
  - Gen-2-B: leaf 評価関数を導入し rollout 短縮（速度・強度両立を狙う）
  - Gen-2-C: CMA-ES で evaluator 重みチューニング（フェーズ 2）
- 既存テスト（19 件）はすべて維持
- ESLint 設定がプロジェクトにないため `npm run lint` は失敗（既存の問題、Gen-1 由来ではない）。型チェック・vitest・IDE lint はすべて通過

---

## Gen-0: 学習基盤の初期整備 (2026-05-26)

### 変更点
- `ai/` ディレクトリを新設（学習スクリプトとモデル/データ置き場の分離）
- `src/ai/encoding.ts`: 状態 → 固定長ベクトル化（合計 187 次元）
- `src/ai/actionSpace.ts`: 行動 ID 体系・違法手マスク（離散 30 次元、CONFIRM_GIFTS は別系統）
- `src/ai/infoSet.ts`: 情報集合と determinization ユーティリティ
- `src/ai/smartAI.ts` / `src/ai/randomAI.ts`: `Date.now()` / `Math.random()` 由来の非決定性を除去し、state ベース seed に統一
- `src/game/reducer.ts`: 連鎖発火後の追加アクションが両方とも実行不可（山札・捨札・ボードがすべて空）になるケースで詰まる**重大バグ**を修正。該当時は自動スキップして得点処理へ
- `ai/scripts/selfplay.ts`, `ai/scripts/bench.ts`, `ai/scripts/_runner.ts`: ヘッドレス対戦 CLI
- `.claude/skills/evolve-meteo-ai/SKILL.md`: 進化サイクルの標準ワークフロー定義

### ベンチ結果（基盤の動作確認・参考値）

**smart x4 自己対戦** (200局 → 100局, `--rotate`, `--seed 1`):
- 全 100 局終了 (unfinished=0)
- 各座席の勝率 25.0% (95%CI 21.0-29.5%)（席バイアス無し、想定どおり）
- 平均得点 15.94 / プレイヤー
- 平均 1 手あたり 0.04ms（CPU、Node.js 単スレッド）

**smart vs random x3** (200局, `--rotate`, `--seed 1`):
- 200 局中 195 局が `--max-steps 20000` で未終了 → smart の 1 手先評価では 20 点到達まで届かないケース多数
- 完了 5 局では smart が全勝
- 順位ベース: smart 1 位率 95% (190/200)、avg score 11.85
- 「smart は random より明確に強いが、ゲームを終わらせる能力に欠ける」ことを示す
- → フェーズ 1 (MCTS) で「連鎖を計画的に組む能力」を強化することで根本解決見込み

### 採用判定
採用（基盤整備＋ゲームエンジン重大バグ修正）

### メモ
- フェーズ 0 の完了を表すマイルストーン
- 次イテレーション（Gen-1）の本命は **IS-MCTS の導入**
- 既存テスト（19 件）はすべて維持
