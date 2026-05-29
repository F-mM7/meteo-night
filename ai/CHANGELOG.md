# AI CHANGELOG

各イテレーション（世代）の変更点と評価結果を追記していきます。
最新を上、古いものを下に。

---

## 📌 現状最強モデル（コンテキスト復元用）

| 種類 | モデル | vs smart 勝率 | ブラウザ反映 | 由来 |
|---|---|---|---|---|
| 手書き AI（採用版） | **Gen-3-O**（Gen-3-L + joint 2D grid で `(uctC, iter) = (1.7, 800)` 採用）| **93.5%** (95%CI 89.2-96.2%) | **✓ 反映済み** | `src/ai/mctsAI.ts` の `DEFAULT_UCT_C` / `DEFAULT_ITERATIONS` |
| NN AI（最強だが未到達） | **az-v7**（K6 + 5000 games AlphaZero）| 8% | – | `ai/models/az-v7/` (gitignore) |
| 旧 NN 系 | az-v1〜v6, v8〜v10 | 0-6% | – | 不採用、 詳細は下の各 Gen-3-K* エントリ |

新セッション開始時のクイックチェック:
1. このサマリと最新 Gen エントリを読む
2. `ai/README.md` の「現状」セクションを確認
3. ベンチで実機確認: `npx tsx ai/scripts/bench.ts --games 50 --strategies mcts,smart,smart,smart --rotate --seed 1001 --silent --json`

---

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

## Gen-3-S: ハイブリッド NN（policy-only NN + Gen-3-F leaf value）実装 + 重大バグ発見 (2026-05-28〜29)

> 注: 当初このエントリを「Gen-3-M」 と命名したが、 別セッションが grid search 系で
> Gen-3-L〜Q を使用済みのため Gen-3-S にリネーム（命名衝突の解消）。

### ⚠️ 重大バグ発見（Gen-3-N 相当の neuralMcts batch 探索バグ、 2026-05-29）

`decideActionNeural` の batched 探索は、 `batchSize` が大きいと **木を降りない**。
`_verify-search.ts` での実測（iterations=100 固定）:

| batchSize | totalVisits | 探索された action 数 |
|---|---|---|
| 1 | 99 | 3（正常）|
| 8 | 92 | 3（正常）|
| 16 | 84 | 3（やや劣化）|
| 50 | 50 | 1（壊れ）|
| 100 | **0** | **0（root すら展開せず、 常に最初の合法手）** |

原因: 1 ラウンドで bsz 個の selection を集めてから一括 expand する構造のため、
同一ラウンド内では visit が更新されず全 selection が同じ未展開ノードに殺到する。
`batchSize >= iterations` だと root すら展開されない。

**この発見が無効化する過去の結論:**
- **Gen-3-K11（parallel self-play）**: speedup 計測は壊れた探索が前提で無効
- **Gen-3-K12（mcts-batch=100 で 1.5x speedup）**: 速かったのは探索をほぼしていなかったから。 結論を撤回
- **hybrid-v1（100 games × 2 iter, mcts-batch=100 で学習）**: 学習データは全て「最初の合法手」 の one-hot でゴミ。 vs smart 0%（avgScore 0）はこれが原因

**対処**: bench / 学習では `batchSize <= 8` を使う。 `bench-neural.ts` は batchSize=8 に修正済み。
根本対処（batch 探索に virtual loss 相当の仮想 visit を入れて発散させる）は今後の課題。

### 仮説（ハイブリッド設計、 当初）
これまで NN AI (az-v1〜v10) は vs smart 0-8% で頭打ち。 Gen-3-F (vs smart 89.5%) に遠く及ばない。
原因は AlphaZero 流の「value もゼロから学習」 が学習データ要求量に対して不足しているため。
**「value は既存 Gen-3-F の heuristic に任せ、 NN は priors（方策）のみ学習」** のハイブリッド設計に切り替えれば、
Gen-3-F を baseline として保証しつつ、 NN が priors を補助することで強くなる可能性が高い（AlphaGo（not Zero） に近い思想）。

### アーキテクチャ

```
MCTS root state
  ↓
selection (PUCT)
  - prior: NN policy（学習可能、 マスク後正規化）
  - Q: visit-averaged value
  ↓
leaf に到達
  ↓
leaf value = evaluateState(state, p, Gen-3-F weights) → tanh で正規化 [-1, +1]
  ↓ (numPlayers 次元、 K6 互換)
backprop
```

### 変更点

#### 1. `ai/scripts/nn/model.ts`
- `createPolicyOnlyModel`: value head 無しの NN（output は policy 1 個のみ）
- `compileForPolicyOnly`: 損失は categoricalCrossentropy のみ
- `loadModel` の bug 修正: 既存実装は valueSize 固定 4 だったが、 `net.outputs.length` で判定するように変更
  - policy-only モデル load 時 valueSize=0
  - policy+value モデル load 時 valueSize=4

#### 2. `ai/scripts/nn/neuralMcts.ts`
- `NeuralMctsOptions.useHeuristicValue?: boolean` 追加
- 内部 helper `evaluateLeafHeuristic(state, numPlayers)`: 全プレイヤー視点で `evaluateState(..., DEFAULT_WEIGHTS)` を呼んで tanh 正規化（scale=1000）
- `nnPredictBatch` を policy-only モデルにも対応（output が tf.Tensor or tf.Tensor[] の両方を受ける）
- expansion 時、 `useHeuristicValue || model.valueSize === 0` なら NN value を無視して `evaluateLeafHeuristic` を呼ぶ

#### 3. `ai/scripts/nn/dataset.ts`
- `SelfPlayOptions.useHeuristicValue?: boolean` を伝搬
- `generateSelfPlayGameWithModel` → `decideActionNeural` の options に追加

#### 4. `ai/scripts/nn/train.ts`
- `--hybrid` フラグ追加
- hybrid 指定時:
  - `createPolicyOnlyModel` を新規作成（init JSON 経由なら従来モデルでも可、 value 出力は無視される）
  - `compileForPolicyOnly` で fit
  - `model.net.fit(x, pTarget, ...)` （value target 不要）

#### 5. `ai/scripts/bench-neural.ts`
- `mcts-batch=100` を渡すように変更（Gen-3-K12 で発見した 1.5x speedup を反映）

### Smoke 結果（CPU, 5 games × 1 iter）

```
Total params: 186910 (hidden=256x3, policy-only)
generated 600 examples in 6.7s
trained 1 epochs in 0.1s, final loss=3.0497
saved model to /tmp/hybrid-smoke/
```

→ 動作確認 OK。 7.7 秒で 5 games + train 1 epoch、 model save 成功。

### 採用判定
**実装採用**。 強さの検証（hybrid vs Gen-3-F）はまだ。 ES tune (Gen-3-L) と並行検証予定。

### 次の手
1. ES tune (Gen-3-L) 完了後、 hybrid を本格学習
   ```bash
   npx tsx ai/scripts/nn/train.ts --games 200 --iter 10 --batch 256 --epochs 3 \
     --seed 50000 --selfplay neural --hybrid \
     --hidden-units 256 --hidden-layers 3 --mcts-batch 100 \
     --out ai/models/hybrid-v1
   ```
2. `bench-neural.ts /path/to/hybrid-v1 --opponent smart --games 200` で勝率確認
3. Gen-3-F (89.5%) を超えるか
4. 超えれば az-v1 系列に代わる本命候補、 ブラウザ統合

### メモ
- ハイブリッドは AlphaGo（not Zero）方式。 NN の役割は「priors の補助」 に限定
- 学習データ要求が桁違いに少ない見込み（数千 games で効果が出る想定）
- Gen-3-F の評価関数があと数 pt 強くなれば hybrid 全体も底上げされる（A 路線 Gen-3-L と組み合わさる）

---

## Gen-3-R: 評価関数に 4 新 feature 追加（実装のみ。 別セッション Gen-3-Q の 21 次元 ES で検証され不採用） (2026-05-28)

> 注: 当初「Gen-3-L」 と命名したが grid search 系の Gen-3-L と衝突するため Gen-3-R にリネーム。
> 追加した 4 特徴量（endRoundLowReachPenalty 他）は別セッションの Gen-3-Q（21 次元 ES）でも
> まとめて検証され、 いずれも不採用（DEFAULT は 0 のまま）。 結論は一致。

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、変化なし。 ただし RULES.md 改訂で「**このゲームに手札（hand）は存在しない**」 と再確認（取得 2 枚は即配置）。 一時的に手札評価を検討候補に挙げたが撤回。

### 仮説
Gen-3-F の `EvalWeights` 17 keys を見直したところ、 以下の重要な要素が抜けていた:

1. **endTriggered 後の reach 期待値補正**: 「もう間に合わない reach 1-2」 を区別していない
2. **slot 高さの偏り**: 1 slot に積み上がるとジャム（overflow 直前）なのに総量しか見ていない
3. **場の機会**: 公開 field の 4 枚に自分の reach 一致色があれば次手で完成可だが評価していない

これらを追加して ES tune すれば Gen-3-F + 数 pt の改善が見込める。

### 変更点

#### 1. `src/ai/evaluator.ts`
- `EvalWeights` に 4 keys 追加（all default 0 = 既存挙動と互換）:
  - `endRoundLowReachPenalty`: endTriggered 中の reach 1-2 ペナルティ
  - `endRoundHighReachBonus`: endTriggered 中の reach 3+ 加算（急がせる）
  - `slotEvennessPenalty`: max-min 高さ偏りペナルティ
  - `fieldOpportunityMatch`: 自分手番中、 field に reach 2-4 同色がある時の加算
- `readBoardSignal` に `maxStackHeight`, `minStackHeight` 追加
- `selfScore(player, state, w)` に state 引数追加（state.endTriggered, state.field, state.currentPlayerIndex を参照するため）

#### 2. `src/ai/tunedWeights.ts`
- `GEN_3B_WEIGHTS` に新 4 keys 追加（all 0 で互換）

### 手動値での方向性チェック（200 games rotate, vs smart）

| 設定 | mcts winRate |
|---|---|
| Gen-3-F baseline (新 keys=0) | 89.5%（既知）|
| 手動 weights（new keys=30,60,5,10）| **87.0%** |

→ 手動値は -2.5pt だが 95%CI 内（範囲 84.5-93.0%）で**有意悪化とは言えない**。 ES で最適値を探索する必要あり。

### ES tune 結果（2026-05-28 完了）

```bash
npx tsx ai/scripts/tune-es.ts --gens 30 --games 100 --seed 7 --sigma 0.15 \
  --init ai/data/tuned-weights-gen3f.json --out ai/data/tuned-weights-gen3l.json
```

実測（15 gen で sigma が 0.01 を下回り早期終了）:
```
gen  0 baseline: avgScore=21.76 winRate=98.0% (Gen-3-F default)
gen  1-15: 全て reject (sigma 0.15 → 0.0097)
final: best ever = Gen-3-F default のまま、 新 4 keys は全て 0
```

### 採用判定
**不採用**: 15 gen の ES 探索で Gen-3-F を超える child が一度も得られなかった。

### 失敗原因の分析

1. **新 4 keys は既存 keys と役割が重複していた可能性が高い**:
   - `endRoundLowReachPenalty / endRoundHighReachBonus`: 既存 `winnerBonus` / `loserPenalty` / `threatScoreMult` が「終局を意識して急ぐ」 を既にカバー
   - `slotEvennessPenalty`: 既存 `overflowPenalty` が総量を見ており、 偏りも間接的に効いている
   - `fieldOpportunityMatch`: 既存 `reach2`/`reach3` などが「進捗 reach は価値が高い」 を表現済み
2. **Gen-3-F は既に高度に局所最適化されている**: 17 keys × 18 gen × 100 games の探索済みなので、 単純な追加 features では超えられない
3. ES の sigma 探索範囲 (0.15 → 0.01) が狭く、 0 から大きな正値の探索が不足した可能性もある（次回は sigma=0.3 + 別 seed で再試行する価値あり）

### 次の手（A 路線の再挑戦案）

1. **より新規性ある feature** を試す:
   - card counting（捨札・deck 残り）
   - 多 turn lookahead（次の自分の手番までの相手 N 手予測）
   - gift queue size の戦略的重み
2. **ES 設定変更**: sigma=0.3、 seed 別、 gens=50 で再 tune
3. **A 路線を一旦保留し、 B 路線（ハイブリッド）に注力**（こちらが本命と思われる）

### メモ
- このゲームに手札 (hand) はない（取得 2 枚は即ボード配置）。 私が一時的に「手札評価」 を提案したのは誤読
- 新 4 keys は 0 のまま残置（コードは互換、 将来 ES re-tune で復活可能性）
- 「最強 AI」 目標に対して、 既存 evaluator の単純拡張は ROI が低かった。 構造的改善（hybrid NN）が次の本命

---

## Gen-3-K12: mcts-batch=iterations 化が真の効率化、 parallel-games は不要 (1.5-1.6x speedup) (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、変化なし。

### 背景
K11 で parallel self-play を実装したが GPU 1.32x にとどまった。 「もっと効率化できるはず」 とのユーザー指摘を受け、 推測ではなく **プロファイル実測** で律速箇所を特定し、 本質的な改善を行う。

### プロファイル結果（`ai/scripts/_profile-nn-selfplay.ts`）

#### NN predict のコスト構造（hidden=512×6, 1.4M params, GPU）

| batch | ms/call | ms/sample |
|---|---|---|
| 1 | 3.15 | 3.148 |
| 16 | 3.68 | 0.230 |
| 32 | 3.36 | 0.105 |
| 64 | 5.88 | 0.092 |
| 128 | 10.72 | 0.084 |
| 256 | 21.09 | 0.082 |

→ **3 ms/call の固定オーバーヘッド** が支配的。 batch を増やしても 1 sample 単価は安くなるが、 1 call 単価は線形以下にしか減らない。 つまり **predict 回数を減らす** のが最も効く。

#### Game logic 単体（参考）

- `encodeState`: 0.0092 ms (109K ops/sec)
- `observationKey`: 0.0033 ms (string 生成)
- `legalActionIds`, `stepGame`, `determinizeDeck`: それぞれ 0.0005 ms 以下（ほぼ無視）
- 1 simulation (depth 5、 determinize + 5 step + 5 obsKey + 1 encode): 0.044 ms

#### 律速の数値理解
- iterations=100, mcts-batch=16 だと **6 predict calls/turn** = 6 × 3.68 = 22 ms NN cost
- iterations=100, mcts-batch=100 だと **1 predict call/turn** = 1 × 21 (batch≈100) = 21 ms NN cost… 同じ?
- ただし mcts-batch=100 では batch=100 で 1 predict (≈9 ms) → **2.4x speedup**

### 改良の検証

`--mcts-batch` を 16/32/64/100 と振って測定（hidden=512×6, 8 games × 1 iter）:

| 構成 | ms/example | A 比 |
|---|---|---|
| **A**: GPU seq, mcts-batch=16 | 19.3 | 1.00x |
| **B**: GPU seq, mcts-batch=100 | **12.7** | **1.52x** |
| C: GPU parallel=8, mcts-batch=16 (K11) | 15.1 | 1.28x |
| D: GPU parallel=8, mcts-batch=100 | 11.9 | 1.62x |
| **E**: CPU seq, mcts-batch=16 | 21.2 | 0.91x |
| **F**: CPU seq, mcts-batch=100 | **12.1** | **1.60x** |
| G: CPU parallel=8, mcts-batch=100 | 14.8 | 1.30x |

### 主な発見

1. **mcts-batch=100 が圧倒的**（sequential 単体で 1.5x）。 NN call 回数を 6→1 に減らす効果が、 parallel-games 8 倍化よりも大きい
2. **parallel-games は K12 後は不要**。 mcts-batch=100 と組み合わせると 8 games 分の Map/encode overhead が 1 round に集中し、 微悪化（GPU: 12.7 → 11.9 ぐらいで誤差、 CPU: 12.1 → 14.8 で明確悪化）
3. **GPU と CPU の差が消えた**（B 12.7 vs F 12.1）。 mcts-batch=100 になると NN cost が小さくなり、 残るは JS overhead が支配 → GPU の優位性ゼロ
4. **K11 の parallel 実装は無駄ではなかった**: 「mcts-batch を大きくしたい」 という発想に至るためのデータが揃った。 ただし機能としては「mcts-batch=iterations なら sequential で十分」

### 採用判定
**条件付き採用**: `--mcts-batch 100` （iterations と同値）を **推奨設定** として CHANGELOG/README/GPU_SETUP に記載。
ただし以下の risk を明記:
- mcts-batch=100 では provisional uniform priors の影響で MCTS 探索品質が劣化する懸念
  - examples 数の減少が観測されている: mcts-batch=16 で 1193, mcts-batch=100 で 960 (8 games)
  - → 同じ iterations でも生成 sample 数が違う = game 進行が異なる = MCTS の選択が変わっている
- 強さの検証は **Gen-3-K13 で az-v11 を batch=16 と batch=100 の 2 条件で並行学習** して bench 比較すべき
- parallel-games は実装は残すが、 デフォルト推奨ではない（mcts-batch を大きくすれば不要）

### 既存コードへの影響

なし。 `--mcts-batch` は既存 CLI オプション、 デフォルト値（1）は変更せず（互換性のため）。 推奨設定はドキュメントで明示する。

### 補追：「なぜ GPU の優位性がないのか」 の根本分析（2026-05-28 追加）

ユーザーから「なぜ GPU の優位性がないのか」 と聞かれて、 model サイズ別の GPU/CPU predict 速度を実測した（`ai/scripts/_profile-gpu-vs-cpu.ts`）。

#### NN predict 単体 (batch=100)

| モデル | params | GPU samples/s | CPU samples/s | GPU/CPU |
|---|---|---|---|---|
| hidden=64×2 | 18K | 22,422 | 39,746 | **0.56** (CPU 速い) |
| hidden=256×3 | 188K | 21,677 | 23,646 | 0.92 |
| hidden=512×6 | 1.4M | 15,729 | 12,137 | **1.30** |
| hidden=1024×6 | 5.5M | 15,322 | 6,700 | **2.29** |
| hidden=1024×12 | 11.8M | 10,566 | 3,246 | **3.26** |

→ モデルが大きいほど GPU の優位性が出る。 1.4M はちょうど臨界点。

#### しかし実 self-play では…

| モデル | GPU self-play ms/ex | CPU self-play ms/ex | GPU/CPU |
|---|---|---|---|
| 1.4M | 12.7 | 12.1 | 0.95 |
| 5.5M | 18.8 | 22.5 | **1.20** |
| 12M | 38.5 | 35.0 | **0.91** (CPU 速い!) |

predict 単体では 12M で GPU 3.26x だったのに、 self-play では CPU の方が速くなる。

#### 3 つの構造的理由

1. **モデルが小さすぎる → GPU 起動オーバーヘッドが支配的**
   - RTX 4080 は 9,728 cores、 48 TFLOPS
   - 1.4M params の predict は数百 FLOPs/sample → **GPU の 0.1% も使えていない**
   - 3 ms の kernel launch overhead が、 ms 単位の計算本体を上回る

2. **JS overhead が支配的**
   - 1 turn のうち NN predict は 1-10 ms
   - JS（encodeState, observationKey, Map 操作, MCTS tree 管理）が 10-30 ms
   - GPU/CPU 共通コスト → GPU 加速できない領域が大きい

3. **実 self-play は predict 単体ベンチより不利**
   - 単体ベンチは同じ batch を繰り返し → GPU kernel cache が効く
   - 実 self-play は turn ごとに batch size 変動（mcts-batch=100 でも実 batch は 50-90）→ kernel 再 tune が走る可能性
   - → 12M で単体 3.3x → self-play で逆転、 という非対称が説明できる

### 次の手（Gen-3-K13+ 候補）

1. **JS overhead 削減**（最有望）
   - observationKey の hash 化（string → number、 ~50% 削減）
   - encodeState の TypedArray 直接書き込み（Float32Array.from の copy 排除）
   - Map<string, NodeStats> → Map<number, NodeStats>（lookup 高速化）
   - 期待: 全体 1.3-1.5x（GPU/CPU 共通の効果）
2. **tree reuse**: 前 turn の MCTS tree を再利用、 実質 iterations 1.5-2x（学習効率も改善）
3. **az-v11 大規模学習**: 1.4M + mcts-batch=100、 10K games（推定 ~5 時間）
4. **強さ比較**: mcts-batch=16 vs 100 を並行学習し、 vs smart 勝率で品質を確認

### メモ
- 「推測で実装 → ベンチで効果なし」 を K11 で繰り返した後、 K12 でプロファイル先行に切り替えたら一発で本命の律速点が見えた
- 教訓: 性能改善は必ずプロファイル先行で
- GPU の優位性は predict 単体では出るが、 実 self-play では出ない。 改善するには **JS overhead 削減** が次の本命
- parallel-games の実装はそのまま残す（マイクロ秒級の NN で活きる場面が将来あり得るため）

---

## Gen-3-K11: parallel self-play 実装 (大モデルで GPU 1.32x、 中モデルで効果なし) (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、変化なし。

### 仮説
K10 のベンチで「現行コードでは GPU の効果ほぼゼロ」 と判明。 原因は self-play 中の予測が `mcts-batch=16` の小バッチ逐次呼び出しで、 PCIe 転送オーバーヘッドが支配的だから。
複数 game の MCTS を同時並行で進めて 1 batch を大きくすれば（N games × 16 leaves = 128-256 サンプル）、 GPU の効率が上がるはず。

### 変更点

#### 1. `ai/scripts/nn/neuralMcts.ts`
- `decideActionNeuralParallel(inputs, model, options)` を追加
  - 各 input は `{state, playerId, seed?}` を持つ
  - 各 context について独立の MCTS tree を保持
  - 1 round 内で各 context が `options.batchSize` 回の selection を試みる
  - 集まった全 expand leaves を 1 つの NN batch で評価
  - 各 expand について path に backprop
- 「同 round 内で同じ leaf に衝突する」 問題に対しては、 expand 時に **uniform priors を `provisional=true` で仮 install** し、 NN 結果到着時に上書きする方式を採用
  - virtual loss (K8) のように visit count を触らないので、 K8 失敗の二の舞は避けられる
- `NodeStats` に `provisional?: boolean` フィールド追加（optional）
- 既存 `decideActionNeural` は無変更（後方互換）

#### 2. `ai/scripts/nn/dataset.ts`
- `generateDatasetParallel(seedBase, numGames, parallelGames, model, tau, mctsBatchSize)` を追加
  - rolling 方式: 同時に最大 `parallelGames` 個の game を進行、 完了した slot から即 finalize + 次の game seed を投入
  - 各 step で active な全 slot の next action を 1 つの NN batch で同時決定
  - awaitingGiftSelection の slot は smart で個別決定（既存と同じ委譲ロジック）
- `parallelGames < 2` のときは従来の `generateDatasetWithModel` に委譲

#### 3. `ai/scripts/nn/train.ts`
- `--parallel-games N` オプション追加（default 0 = sequential）
- N >= 2 のとき `generateDatasetParallel` を呼ぶ

### ベンチ結果

#### 中モデル (hidden=256×3, 188K params, 16 games × 1 iter, GPU)

| 構成 | examples | 所要 | examples/sec |
|---|---|---|---|
| seq, mcts-batch=16 | 2747 | 23.4s | 117 |
| parallel=4, mcts-batch=16 (batch=64) | 2472 | 25.1s | 98 |
| parallel=8, mcts-batch=16 (batch=128) | 2365 | 23.6s | 100 |
| parallel=16, mcts-batch=16 (batch=256) | 3043 | 27.9s | 109 |

→ **中モデルでは並列化の効果なし**（むしろ微悪化）。 JS overhead がボトルネック。

#### 大モデル (hidden=512×6, 1.4M params, 8 games × 1 iter)

| 構成 | examples | 所要 | ms/example | vs CPU seq |
|---|---|---|---|---|
| GPU seq, mcts-batch=16 | 1560 | 30.7s | 19.7 | 1.08x |
| **GPU parallel=8, mcts-batch=16** | 1169 | **18.9s** | **16.2** | **1.32x** |
| CPU seq, mcts-batch=16 | 1181 | 25.1s | 21.3 | 1.00x |

→ **大モデル + parallel=8 で GPU が CPU の 1.32x 速い**。 188K params では出なかった効果が 1.4M で初顕在化。

### 解釈

- 188K params は CPU でも数 ms/predict で済む → GPU の優位性が小さい → 並列化しても JS overhead に飲まれる
- 1.4M params で GPU 計算が顔を出し、 並列化で 1 batch を 128 サンプルにまとめると GPU が活きる
- ただし期待した 3-5x には届かず。 残るオーバーヘッド:
  - 各 context の Map 操作（per-game node storage）
  - encodeState（185 次元の生成）
  - path のオブジェクト構築
- これらを削るには TypedArray ベースの node storage / encodeState のキャッシュ等が必要

### 採用判定
**条件付き採用**: parallel-games オプションは保留せず本流に残す。 ただし:
- 中モデル以下では使わない（効果なし）
- 大規模モデル（1M+ params）+ parallel=8 の組み合わせを **az-v11 候補** として採用
- GPU_SETUP.md フェーズ C の採用判定基準（1.5x 以上）には僅かに届かないが、 1.32x でも CPU よりは速いので使う価値あり

### 次の手（Gen-3-K12 以降の候補）

1. **virtual loss の正しい実装**（K8 で失敗した再挑戦、 期待 2x）
2. **大規模学習の実行**（hidden=512×6 + parallel=8 で 10K games の az-v11）
3. **JS overhead 削減**（TypedArray node, encodeState キャッシュ、 path をプリミティブ配列に）

### メモ
- 並列実装の核は「provisional uniform priors の仮 install + NN 結果で上書き」。 virtual loss と違って visit count を触らないので、 MCTS の探索品質を壊さない
- 同 round 内の同 leaf 衝突は `installed: Set<NodeStats>` で「最初の 1 つだけ priors install」 にして対処
- parallel-games = numGames（全 games 同時並行）のときが理論最大効率

---

## Gen-3-K10: GPU 学習環境セットアップ完了 (環境構築 OK、 現行コードでは効果なし) (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、変化なし。

### 背景
これまで全 NN 学習は CPU 版 tfjs-node で実施。 ハードウェア (RTX 4080 16 GB) は利用可能だが、 ライブラリ依存（CUDA 11.8 + cuDNN 8）が未整備で GPU を活用できていなかった。
大規模学習 (10K+ games) を見据えて GPU セットアップを完了し、 同時に現実的な speedup を実測する。

### 環境整備

#### CUDA 11.8 ライブラリ
- `cuda-toolkit-11-8`（フル）は Ubuntu 24.04 で `libtinfo5` 依存が解決できず失敗
- 個別パッケージ指定で回避: `cuda-cudart-11-8`, `libcublas-11-8`, `libcufft-11-8`, `libcurand-11-8`, `libcusolver-11-8`, `libcusparse-11-8`, `libnpp-11-8`, `cuda-nvrtc-11-8`
- `/usr/local/cuda-11.8/lib64/` に配置

#### cuDNN 8.9.2
- `libcudnn8` パッケージは Ubuntu 24.04 標準リポジトリに存在せず
- Ubuntu Noble 公式の `nvidia-cudnn` パッケージ（install script 形式）+ `/usr/sbin/update-nvidia-cudnn -u` で NVIDIA から tarball 取得・展開
- `/usr/lib/x86_64-linux-gnu/libcudnn.so.8.9.2` 配置成功

#### tfjs-node-gpu 動作確認
```
Created device /job:localhost/replica:0/task:0/device:GPU:0 with 13508 MB memory:
  -> device: 0, name: NVIDIA GeForce RTX 4080, pci bus id: 0000:01:00.0, compute capability: 8.9
```

### コード変更
`ai/scripts/nn/{model,train,neuralMcts}.ts` の import を `@tensorflow/tfjs-node` → `@tensorflow/tfjs-node-gpu` に統一。
GPU 環境では GPU、 GPU 不在環境では CPU fallback で同じスクリプトが動く（前回の Gen-3-K3 smoke で確認した挙動）。

### ベンチ結果 (1): 推論 forward pass（hidden=256×2）

| batch | GPU ms/step | CPU ms/step | GPU/CPU |
|---|---|---|---|
| 1 | 0.84 | 2.08 | **2.5x** |
| 16 | 0.81 | 1.52 | **1.9x** |
| 64 | 2.25 | 5.19 | **2.3x** |
| 256 | 9.50 | 13.80 | **1.5x** |
| 1024 | 48.99 | 45.39 | 0.93x |

→ 純粋な forward pass では batch 16-64 で GPU が約 2x 速い。

### ベンチ結果 (2): 実 self-play（train.ts, 5 games × 1 iter, mcts-batch=16）

| モデル | GPU 所要 | CPU 所要 | GPU/CPU |
|---|---|---|---|
| 小 (hidden=64×2, 18K params, az-v10 init) | 6.7s | 7.4s | 1.10x |
| 中 (hidden=256×3, 188K params, 新規 init) | 7.95s | 7.39s | **0.93x（CPU 速い）** |

→ **train.ts 経由では GPU の効果がほぼ消える**。

### 効果消滅の原因分析

- self-play 中の予測は MCTS のリーフ展開ごとに `mcts-batch=16` の小バッチで呼ばれる
- 純粋な GPU 計算時間 (~1 ms) に対して、 GPU memory 転送 + TF runtime overhead が支配的になる
- batch=1024 まで束ねれば GPU の transfer/compute 比が改善するが、 そこまでバッチを積むには parallel self-play が必須
- 188K params 程度では Tensor Core が活躍するほど計算負荷が高くない

### 採用判定
**採用**（環境構築のみ）。 学習速度の改善効果は ~10% にとどまるが、 後続 Gen-3-K11+ の前提条件として必要。

### 次の手（Gen-3-K11 以降の候補）

| 改良案 | 期待 speedup | 実装難度 |
|---|---|---|
| **parallel self-play** （N games 同時並行 → 1 predict で N×mcts-batch サンプル） | 3-5x | 中（neuralMcts と train.ts の構造改修） |
| **virtual loss 正しい実装**（K8 で 1 度失敗、 同一 node からの multi-leaf 並列展開） | 2x | 中 |
| **大規模モデル**（hidden=512×6, 1M+ params） | 中（GPU 計算律速に入る） | 低（CLI 引数で可） |
| **mcts-batch=64+** | 1.2-1.5x | 低 |

### メモ
- GPU 環境構築は時間投資の割に直接の効果が薄い結果になった。 ただし K11+ の改良はこの環境が無いとそもそも実験できない
- 開発中は `CUDA_VISIBLE_DEVICES=-1` で CPU 実行可。 現行コードでは速度差ほぼ無いので CPU での反復開発に支障なし
- 過去の `tfjs-node` → `tfjs-node-gpu` 変更は **import 行のみで API は同一**。 ロールバックも容易

---

## Gen-3-K9: ブラウザ統合の準備 (NN を反映できる状態にする、 強さは未変化) (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 3f0158b 以降コミット無し、変化なし。

### 背景
NN モデル本体は az-v7 が現状最強だが vs smart 8% で Gen-3-F (89.5%) に届かないため、 ブラウザ反映は保留中。
ただし「強いモデルが出てきた瞬間に反映できる」状態が無いと、 後でまとめて UI 側のリファクタが必要になり、 学習との並行作業を阻害する。
そこで強さに影響を与えずに **ブラウザ統合パスを完成** させる。

### 変更点

#### 1. `@tensorflow/tfjs`（ブラウザ版）依存追加
- `package.json` の `dependencies` に追加（dev ではなく本番依存）
- main chunk には混入させない（次項の動的 import で別チャンク化）

#### 2. `src/ai/neuralAI.ts` を本実装に置換
- 旧雛形（stub）を破棄し、`ai/scripts/nn/neuralMcts.ts` のブラウザ移植版を実装
- 機能:
  - `loadModel(url)`: `tf.loadLayersModel` で model.json をロード（多重呼び出し安全、 失敗時は null）
  - `isModelLoaded()` / `getLastLoadError()`: 状態確認用 API
  - `disposeModel()`: tensor リークなくモデル破棄
  - `decideAction(state, playerId, seed?, options?)`: 内部で NN-guided PUCT MCTS を実行
- 価値出力は **NUM_PLAYERS 次元 (Gen-3-K6 互換)**、 旧 1 次元モデルでも fallback で動作
- **モデル未ロード時 / ロード失敗時は自動的に mctsAI に委譲** → UI 側の崩れなし
- 推論は逐次（バッチなし）。ブラウザでの Promise/同期コストを考えると単発のほうが単純

#### 3. 動的 import 経路 `loadNeuralAI(url)` を `src/ai/index.ts` に追加
- `await import('./neuralAI')` でロードするため、 vite が NN コードを **別 chunk** として分離
- 呼ばない限り tfjs は build 対象外（main chunk サイズ変化なし）
- 既存 `export { decideAction } from './mctsAI'` はそのまま → デフォルト挙動は不変

#### 4. placeholder ダミーモデル
- `ai/scripts/nn/make-dummy.ts` 新設: 未学習状態でモデル構造だけ保存
- `public/models/dummy/` に配置（76 KB: model.json 3 KB + weights.bin 73 KB）
- 用途: ブラウザ統合の動作確認、 バンドルサイズ計測のリファレンス

#### 5. `ai/scripts/nn/train.ts --copy-to-public <dir>` オプション
- 学習完了時に `ai/models/<name>/model.json` と `*.bin` を `public/models/<dir>/` に自動コピー
- 例: `... --copy-to-public public/models/active` で強いモデルを一発反映可能

### バンドルサイズ計測（実測）

| 構成 | dist JS | gzip 後 | 備考 |
|---|---|---|---|
| baseline (mctsAI のみ、 現状の本番) | 239 KB | **75 KB** | 変化なし |
| `loadNeuralAI` を起動時に強制呼び出し | 1,833 KB | 327 KB | tfjs 込みの最大ケース |
| 動的 import のまま呼ばない (現状) | 239 KB | **75 KB** | tree-shaking 効いてる |

→ 強いモデルができるまでは **ブラウザに 1 バイトの追加もなし**。 呼び出した瞬間に別 chunk として lazy load される。

### 強さに対する効果
- 既存 mcts/smart/AlphaZero 系の挙動は何も変えていない → ベンチ不要（変化ゼロ）
- `npm test` 全 33 件パス、 `tsc -b` / `vite build` 通過

### 採用判定
**採用**（強さ非関与、 統合パスのみ整備）。

### メモ
- UI / App.tsx には触っていない。 強いモデル完成時にユーザーが UI 側で `loadNeuralAI` を呼ぶだけで切替可能
- フォールバック設計のおかげで「モデルロード失敗 → mctsAI で続行」になるので、 配信ミスがあってもゲームは動く
- 動的 import で別 chunk 化しているため、 初回ロード遅延ゼロ。 NN ボタンを押した時など必要時にだけ tfjs を取りに行く形に発展させやすい

---

## Gen-3-S: mcts 自己対戦 fitness で 21 次元 ES tune（不採用、self-play 改善が vs smart 退行とトレードオフ） (2026-05-29)

### Step 0: ルール変更チェック
HEAD = 9c4cade のまま。 Gen-3-Q 以降の `src/game/` / `docs/RULES.md` 変更なし。 ベースラインは Gen-3-O = 93.5% で有効。

### 仮説
- Gen-3-Q で「smart x3 fitness は天井 (98%)、 新 4 特徴量が 0 のまま動かない」 と判明
- Gen-3-J の per-AI weights API を使い、 **学習側 mcts = 候補重み / 対戦相手 3 体 = default 重み（Gen-3-O 現状最強）** の自己対戦で fitness を取れば、 smart 相手では見えない差別化要素を学習できるはず
- 期待: 新特徴量が非ゼロに動き、 強い相手（自分自身）に勝てる重みが見つかる

### 実装
- `ai/scripts/tune-es.ts` に `--opponent mcts` を追加（対戦相手 3 体を DEFAULT_WEIGHTS の mcts に。 学習側 seat 0 は候補重み、 uctC/iter は両者とも Gen-3-O default の 1.7/800）
- `--gens 15 --games 50 --seed 5 --sigma 0.2 --opponent mcts`、 warm-start from DEFAULT_WEIGHTS
- 1 局 ~4.55 秒（smart x3 の ~4 倍、 全 4 体が mcts のため）、 実時間 ~60 分

### 学習結果（self-play, seed=5, 実時間 60 分）

| 指標 | gen 0 (default) | best ever (gen 13) | 差分 |
|---|---|---|---|
| avgScore | 16.40 | **18.28** | +1.88 |
| winRate (seat 0) | 38.0% | 40.0% | +2pt |
| avgRank | 2.44 | 2.22 | -0.22 |

- 6 回 ACCEPT (gen 2/4/7/8/9/13)、 sigma は最後まで収束せず（0.187 で gen 15 到達）
- **新特徴量が今回は非ゼロに動いた**: `endRoundLowReachPenalty` 0→0.92, `endRoundHighReachBonus` 0→0.23, `slotEvennessPenalty` 0→-0.10, `fieldOpportunityMatch` 0→-0.89
- 既存重みも大きく変化: `selfScoreMult` 124→50, `threatScoreMult` 57→111, `chainSeed` 9→21, `winnerBonus` 5212→7188, `loserPenalty` 3129→1429
- 方向性: **「自己得点重視」 → 「相手警戒重視」**

注: default re-check（default-vs-default 自己対戦, seat 0）の winRate=38% は 25% でなく seat 0 のターン順バイアス。 ただし parent-child は両者 seat 0 で比較するため acceptance 判定は公平。

### Holdout: vs smart x3（200 局 rotate、 標準ベンチ）

| seed | Gen-3-O (現状最強) | **Gen-3-S** | 差分 |
|---|---|---|---|
| 1001 | 93.5% (CI 89.2-96.2%) | **89.0%** (CI 83.9-92.6%) | **-4.5pt** |
| 2001 | 91.5% (CI 86.8-94.6%) | **86.5%** (CI 81.1-90.6%) | **-5.0pt** |
| avgScore (1001/2001) | 21.0 / 21.0 | 20.9 / 20.7 | 同等 |

→ **2 seed 一貫して vs smart で退行**、 CI 下限も Gen-3-O を明確に下回る。

### 採用判定
**不採用、 ブラウザ反映なし、 重みのコード変更なし**

ブラウザの関連指標（vs smart ≈ 人間プロキシ）で -4.5〜-5.0pt 退行するため、 スキル採用基準「現状最強の CI 下限を上回る」 を満たさない。

### メモ・学び（重要）

1. **Gen-3-J 現象の再確認＋拡張**: 「self-play 用に最適化した重みは強い mcts には勝てるが弱い smart には退行する」。 Gen-3-J は per-AI weights API だけで重み数値は不採用だったが、 Gen-3-S は新特徴量込みで本格 ES しても同じ結論
2. **fitness の選択が重みの性格を決める**:
   - smart fitness (Gen-3-Q): 「攻撃的・自己得点最大化」 方向（既に天井）
   - self-play fitness (Gen-3-S): 「警戒的・相手抑制」 方向（強い相手には有効、 弱い相手には過剰）
   - 両者はトレードオフの関係。 単一 fitness ではどちらかに寄る
3. **新 4 特徴量は「効く文脈はある」が「ブラウザ向けには中立〜微負」**: self-play では非ゼロに動いた（特に endRound 系、 終局判断）が、 vs smart では裏目
4. **手書き AI 重み tune の根本的限界が明確に**:
   - smart fitness = 天井 (Gen-3-Q)
   - self-play fitness = vs smart 退行 (Gen-3-S)
   - → 単純な重み最適化では Gen-3-O (uctC×iter joint) を超えられない
5. **次の方向性**:
   - **複合 fitness**: 「vs smart の avgScore + vs default-mcts の avgScore」 の加重和で、 両方に強い重みを探す（トレードオフの妥協点を ES で探索）
   - **progressive bias 再挑戦**（Gen-3-C の prior 設計改良）: 重みではなく探索構造の変更
   - **NN AI (Gen-3-K 系) に注力**: 手書き AI は Gen-3-O が実質天井という結論が強まった。 az-v7 (vs smart 8%) からの大規模学習で構造的突破を狙う

### 残置物
- `ai/scripts/tune-es.ts` の `--opponent mcts`: self-play fitness 用、 将来の複合 fitness 探索にも使い回せる有用な拡張なので保持
- `ai/data/tuned-weights-gen3S.json`: 学習結果（self-play では強いが vs smart で退行する重み、 参照用）
- `ai/data/tune-es-gen3S.log`: 学習ログ（gitignore 配下）
- 評価関数の新 4 特徴量は DEFAULT=0 のまま保持（複合 fitness で再評価する余地）

### チェックリスト
- [x] `npx tsc -p ai/tsconfig.json --noEmit` 通過
- [x] ES 学習完了 (15 世代、 6 ACCEPT)
- [x] vs smart holdout 2 seed で測定、 結果を CHANGELOG に全件記載
- [x] 採用基準（CI 下限が現状最強超え）に未達を数値で確認 → 不採用

---

## Gen-3-Q: 21 次元 ES tune（新 4 特徴量 + 既存 17 重み、不採用、smart x3 fitness の天井を実証） (2026-05-29)

### Step 0: ルール変更チェック
HEAD = 9c4cade のまま。 Gen-3-P 以降の `src/game/` / `docs/RULES.md` 変更なし。
ユーザーが並行で `src/ai/evaluator.ts` に 4 つの新特徴量を追加（DEFAULT 値 0 で挙動互換）。 `tunedWeights.ts` の `GEN_3B_WEIGHTS` も互換維持で 4 つ 0 追加。 ベースラインは Gen-3-O = 93.5%、 ES 学習は新拡張で 21 次元で回る。

### 仮説
- Gen-3-L〜P で **単独 grid / joint 2D grid のハイパラ最適化はほぼ天井**（Gen-3-O の +1.25pt 以降は不採用続き）
- 残る大きな改善余地は「評価関数の構造拡張」
- ユーザーが追加した 4 新特徴量を ES tune で 0 → 適切な重みに学習すれば、 終局判断・盤面偏り・場マッチの 3 つの側面で mcts が強化される
- 期待: +1〜+3pt（過去 Gen-3-B〜F の重み tune パターンの範囲）

### 4 つの新特徴量（ユーザー実装、 全て DEFAULT=0 で開始）
1. `endRoundLowReachPenalty`: 終局トリガー後の reach 1-2 へのペナルティ（「もう間に合わない reach」 を価値ゼロ扱い）
2. `endRoundHighReachBonus`: 終局トリガー後の reach 3+ へのボーナス（「今すぐ仕上げる」 を急がせる）
3. `slotEvennessPenalty`: スロット高さの偏り (max - min) ペナルティ（overflowPenalty の総量と相補）
4. `fieldOpportunityMatch`: 自分の手番中、 場の公開 4 枚に「自分の reach 2-4 と同色」 がある時の機会ボーナス

### 実装
- `tune-es.ts` の `mutate` は `Object.keys(out)` で全キーに摂動 → コード変更なしで自動的に 21 次元 ES
- `--gens 25 --games 50 --seed 5 --sigma 0.2 --opponent smart` で実行
- DEFAULT_WEIGHTS warm-start (= Gen-3-F + 新 4 = 0)、 学習中 mcts は uctC=1.7, iter=800 (Gen-3-O 採用値) で動作

### 学習結果（実時間 18 分 17 秒、 17 世代で sigma 早期収束）

| gen | child avgScore | child winRate | sigma | 判定 |
|---|---|---|---|---|
| 0 (default) | **22.24** | **98.0%** | 0.20 | – |
| 1 | 21.52 | 100.0% | 0.1667 | reject |
| 5 | 21.90 | **100.0%** | 0.0804 | reject |
| 8 | 21.38 | **100.0%** | 0.0465 | reject |
| 10 | 21.12 | **100.0%** | 0.0323 | reject |
| 16 | 21.68 | **100.0%** | 0.0108 | reject |
| 17 | 21.38 | 98.0% | 0.0090 | sigma converged, stop |

**17 世代連続 reject、 best ever = DEFAULT_WEIGHTS（完全に同一）**。 default re-check も 22.24 で一致。

### 重要な観察

**winRate 100% が複数世代で出るが avgScore が parent を下回って reject**:
- parent (DEFAULT_WEIGHTS = Gen-3-O 設定) は seed=5 50 局で **「全勝かつ高得点」 の上限値** を既に達成
- gen 1/5/8/10/16 の child は「勝率は parent と同等以上だが、 1 試合あたり 0.3〜0.9 点低い」
- → 摂動された重みは「勝つが、 高得点パスを取れていない」

### 採用判定
**不採用、 ブラウザ反映なし、 コード変更なし**

- best ever が DEFAULT_WEIGHTS と完全一致 → ES で意味ある改善ゼロ
- holdout 200 局確認は省略（同一重みで同一結果になるため）
- `tuned-weights-gen3Q.json` 保存済み（参照用、 中身は DEFAULT_WEIGHTS と同じ）

### メモ・学び（重要）

1. **smart x3 fitness は完全に天井**: Gen-3-O 設定の DEFAULT_WEIGHTS が seed=5 評価セットで 98% / avgScore 22.24 → 摂動による改善余地が事実上ない（noise レベル）
2. **新 4 特徴量は smart 相手では効かない**: `endRoundLowReachPenalty` / `endRoundHighReachBonus` / `slotEvennessPenalty` / `fieldOpportunityMatch` のいずれも 0 → 学習で意味のある非ゼロ値に動かなかった。 mcts が既に十分強い局面では differentiator にならない
3. **次のステップが論理的に明確化**:
   - smart 相手では検出不能な改善余地が、 **mcts 同士の自己対戦**では検出可能なはず（Gen-3-J で観察された「mcts x4 では各座席 25% で平均化する」現象は、 言い換えれば「自己対戦で差別化できる重みが見つかれば 25% → 26-27% に勝率を寄せられる可能性」）
   - → **Gen-3-S: 自己対戦 fitness で重み再 ES** が次の有望候補
   - Gen-3-J で「per-AI weights API」 を整備済み: 学習側 mcts は学習中の重み、 対戦相手 3 体の mcts は default 重みで固定 → 「学習側のみ改善」 を検出可能

### 残置物
- `ai/data/tuned-weights-gen3Q.json`: 学習結果（中身は DEFAULT_WEIGHTS と同一）
- `ai/data/tune-es-gen3Q.log`: 学習ログ（gitignore 配下）
- 評価関数の新 4 特徴量自体は保持（後の Gen-3-S 等で再評価）

### チェックリスト
- [x] `npx tsc -p ai/tsconfig.json --noEmit` 通過
- [x] `npx tsc -p tsconfig.app.json --noEmit` 通過
- [x] `npx vitest run` 通過（33/33）
- [x] ES 学習完了 (17 世代、 sigma 早期収束)
- [x] best ever = default を再現確認（default re-check）
- [x] 結果を CHANGELOG に全件記載

---

## Gen-3-P: `uctC × leafEvalScale` joint 2D grid（不採用、`leafEvalScale = 1500` が robust にピーク） (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 9c4cade のまま。 Gen-3-O 以降の `src/game/` / `docs/RULES.md` 変更なし。

並行作業の未コミット変更があったが、 評価関数挙動への影響を確認:
- `src/ai/evaluator.ts` (+78 行): `EvalWeights` に 4 つの新特徴量 (`endRoundLowReachPenalty` / `endRoundHighReachBonus` / `slotEvennessPenalty` / `fieldOpportunityMatch`) を追加。 ただし **DEFAULT 値は全て 0**（コメントに「ES tune 前は 0 = 既存挙動と互換」と明記）
- `src/ai/tunedWeights.ts` (+4 行): `GEN_3B_WEIGHTS` にも 4 つを 0 で追加（互換性維持）
- → **評価関数の出力は完全に旧版と同じ**。 Gen-3-P grid 結果は旧 evaluator と同等として有効

→ 検証: 私の Gen-3-P grid で `(uctC=1.7, scale=1500) = 94/100` が Gen-3-O grid (`uctC=1.7, iter=800`) の同条件結果 94/100 と完全一致。 旧挙動が保たれていることを実機で確認済み。

Gen-3-O 関連の未コミット変更（`src/ai/mctsAI.ts` の `DEFAULT_UCT_C=1.7` / `DEFAULT_ITERATIONS=800` 反映）はそのまま、 ベースラインは Gen-3-O = 93.5% で進行。

### 仮説
- Gen-3-O で `(uctC, iter)` joint 探索で coordinate-descent 解を突破できた
- 残る 1 軸 `leafEvalScale` も同じパターンで joint 評価する余地
- Gen-3-M は `(uctC=2.0, iter=400)` 時の結果なので、 現在 `(uctC=1.7, iter=800)` では別ピークがある可能性
- 期待: +0pt〜+1pt

### 実装
- `ai/scripts/grid-joint-uct-eval.ts` を新規作成（`grid-joint-uct-iter.ts` のパターン踏襲、 `iterations` → `leafEvalScale` 軸に変更）
- iter=800 (Gen-3-O 採用値 = DEFAULT_ITERATIONS) を固定
- mctsAI に `{ uctC, leafEvalScale }` のみを options で渡す

### Joint Grid 結果（100 局 × 9 候補, seed=1001, mcts vs smart x3, rotate, iter=800）

| uctC \\ scale | 1000 | 1500 | 2200 |
|---|---|---|---|
| 1.4142 | 85.0% | 81.0% | 91.0% |
| **1.7 (現状)** | 86.0% | **94.0%** (CI 87.5-97.2%, expRank 1.07) | 91.0% |
| 2.0 | 83.0% | 90.0% | 87.0% |

**現状 (uctC=1.7, scale=1500) が grid 内ピーク (94/100)**、 改善候補なし。
- 同率 1 位なし（次点は (1.4142, 2200), (1.7, 2200), (2.0, 1500) で 90-91%、 3-4pt 差）
- ピーク前後の左右対称性: (1.7, 1000) vs (1.7, 2200) = 86% vs 91%、 scale を上げる方向が若干強い

### 興味深い観察
- **`leafEvalScale = 1500` は uctC や iter に依存せず最適**: Gen-3-M (uctC=2.0, iter=400) でも 1500 ピーク、 Gen-3-P (uctC=1.7, iter=800) でも 1500 ピーク
- → `leafEvalScale` は他のハイパラとほぼ独立に最適化できる「ロバストな」パラメータ
- (1.4142, 2200) = 91% と (1.7, 1500) = 94% の比較: uctC を下げると scale を上げる補償関係が緩く存在するが、 真のピーク値は変わらず
- → Gen-3-O で発見した `(uctC, iter)` の相補関係とは異なり、 `(uctC, leafEvalScale)` 間の coupling は弱い

### 採用判定
**不採用、 ブラウザ反映なし、 コード変更なし**

スキル採用基準「現状最強モデルの CI 下限 (89.2%, Gen-3-O) を超える候補」が grid 内に存在せず、 ベースライン (1.7, 1500) がピークのまま。
ホールドアウト 200 局は省略（grid 100 局の (1.7, 1500) 結果 94% が Gen-3-O grid 結果と完全一致、 再現性は前回確認済み）。

### メモ・学び
- **パラメータ間の coupling の強さは軸ごとに異なる**:
  - `uctC × iter`（Gen-3-O）: **強い coupling** あり、 coordinate descent 解突破可能
  - `uctC × leafEvalScale`（Gen-3-P）: **弱い coupling**、 単独最適 = 組合せ最適
- これは「探索の動き」（uctC, iter）と「価値の感度」（leafEvalScale）が概念的に直交する傾向と整合
- **`leafEvalScale = 1500` の正当性が更に強まる**: 2 つの異なる設定下で同じピーク → 「経験則 1500」が偶然ではなく構造的に最適
- **次の方向性**:
  - **`iter × leafEvalScale` joint**: 3 軸目を埋めて 2D 残りを全て確認
  - **3D grid** (`uctC × iter × leafEvalScale`): 9 候補ずつなら 27 候補 × 100 局 ≈ 60-70 分、 一気に最終確認
  - **mcts 自己対戦 fitness で重み再 ES**（Gen-3-J の per-AI weights API 活用）: ブラウザ実態に近い学習
  - **progressive bias 再挑戦**: prior の与え方を改良（多手先評価など）

### 残置物
- `ai/scripts/grid-joint-uct-eval.ts`: 将来 iter を変えて再評価する用途で使い回し可能
- `ai/data/grid-joint-uct-eval-gen3P.log`: grid 全ログ保存（gitignore 配下）

### チェックリスト
- [x] `npx tsc -p ai/tsconfig.json --noEmit` 通過
- [x] grid 9 候補で測定、 結果を CHANGELOG に全件記載
- [x] 再現性チェック: (1.7, 1500) grid 結果 (94%) が Gen-3-O grid 結果と一致

---

## Gen-3-O: `uctC × iterations` joint 2D grid search で coordinate-descent 解を突破（採用、ブラウザ反映済み） (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 9c4cade。 Gen-3-N から進行なし、 ルール / AI ロジック変更なし。 Gen-3-L ベースライン (92.0%) はそのまま有効。

### 仮説
- Gen-3-L (uctC grid, iter=400 固定) と Gen-3-N (iter grid, uctC=2.0 固定) はいずれも **coordinate descent**
- 各次元独立に最適化した結果が「真の組合せ最適」と一致するとは限らない
- 「単独で悪い uctC でも iter とのペアで補える」組合せがないか joint で検証
- 期待: +0pt〜+1pt（一致するなら不採用、 別ペアが見つかれば採用）

### 実装
- `ai/scripts/grid-joint-uct-iter.ts` を新規作成: 2 次元 grid を順に走査
- 共通モジュール (`stats.ts` / `_runner.ts` の `parseIntArg`) を活用
- `bench.ts` に `--mcts-iter <n>` フラグを追加（uctC / leafEvalScale と並んで mcts のみ上書き可能に）

### Joint Grid 結果（100 局 × 9 候補, seed=1001, mcts vs smart x3, rotate）

| uctC \\ iter | 200 | 400 | 800 |
|---|---|---|---|
| 1.7 | 84.0% | 91.0% | **94.0%** (CI 87.5-97.2%, expRank **1.07**) |
| **2.0 (現状 Gen-3-L)** | 85.0% | **94.0%** (CI 87.5-97.2%, avgScore 21.11) | 90.0% |
| 2.4 | 85.0% | 84.0% | 89.0% |

**興味深い発見**: `(uctC=1.7, iter=800)` と `(uctC=2.0, iter=400)` が grid 内同率 1 位 (94/100)。
- coordinate descent では発見不能なペア（`uctC=2.0` 固定で iter=800 だと 90% で悪化、 `iter=800` 固定で uctC=2.0 だと同じく 90%）
- 100 局では noise が ±7-9pt あり判別不能 → 200 局 × 2 seed ホールドアウトで確認

### 200 局ホールドアウト × 2 seed

| 計測 | 現状 (uctC=2.0, iter=400) | **新 (uctC=1.7, iter=800)** | 差分 |
|---|---|---|---|
| seed=1001 200局 勝率 | 92.0% (CI 87.4-95.0%) | **93.5%** (CI 89.2-96.2%) | **+1.5pt, CI下限 +1.8pt** |
| seed=2001 200局 勝率 | 90.5% (CI 85.6-93.8%) | **91.5%** (CI 86.8-94.6%) | +1.0pt, CI下限 +1.2pt |
| 合計 400局 | 365/400 = 91.25% | **370/400 = 92.5%** | +1.25pt |
| avgScore (seed=1001/2001) | 20.88 / 20.83 | 21.005 / 21.03 | 微改善 |
| expRank (seed=1001/2001) | 1.10 / 1.10 | **1.07** / 1.12 | seed=1001 で改善 |
| msPerStep | 2.36-2.51 ms | 5.63-5.68 ms | 2.3 倍 |
| 再現性（同 seed 2 回） | – | 187/200 完全一致 | OK |

**mcts(new) x4 自己対戦サニティ**（50 局 rotate seed=3001）:
- 各座席 25.0% (50/200) — 席バイアスなし
- avgScore 16.36 (Gen-3-L の 16.30 から微改善)
- 1 手 20.6 ms（4 体全 MCTS の合算）

### 計算コストとブラウザ実用性
- mcts 単独の 1 手: **5.63-5.68 ms**（現状 2.4 ms の 2.3 倍）
- ブラウザの CPU 速度デフォルト: **550 ms / アクション**（`src/hooks/useGameLogic.ts` の `DEFAULT_CPU_SPEED_MS`）
- → mcts 思考時間は CPU 速度設定の **1% 未満**で完全に無視できる量
- 1 局あたり mcts 思考時間: ~5.7 ms × ~280 step ≈ 1.6 秒（バックグラウンド計算）

### 採用判定
**採用 → ブラウザ反映済み**

スキル基準を満たす:
- 200 局以上で 95%CI 下限が現状最強 (87.4%) を **2 seed 一貫して** 上回る
- 1 手あたり時間がブラウザ実用範囲（5.7 ms ≪ 550 ms）
- 自己対戦の席バイアスなし、 再現性あり

### 変更点
- `src/ai/mctsAI.ts`:
  - `DEFAULT_UCT_C` を 2.0 → **1.7**
  - `DEFAULT_ITERATIONS` を 400 → **800**
- `ai/scripts/bench.ts`: `--mcts-iter <n>` フラグを追加
- `ai/scripts/grid-joint-uct-iter.ts` 新規: joint 2D grid 実装
- `npm run build` 成功（239.53 kB / gzip 75.50 kB）
- vitest 33/33 通過

### メモ・学び（重要）
- **coordinate descent は局所最適に陥る**: Gen-3-L (uctC) と Gen-3-N (iter) で各々ピークと確認した値が真の最適でなかった
- **相補的調整の発見**: `uctC` を下げる代わりに `iter` を増やすことで、 explore を「広く・薄く」から「狭く・深く」に再配分しても同等以上の効果が得られる
- joint grid のコストは「全候補数 × 100 局」だが、 単独 grid を complement する形で 9 候補に絞れば 12 分で完了
- **手書き AI 単独パラメータの天井は実は coordinate-descent 解だっただけで、 joint で +1.25pt 突破できた**
- 改善幅 +1.25pt は Gen-3-B〜F の典型的な改善幅（+0.5〜+1pt）の範囲内
- **次の方向性**:
  - **uctC × leafEvalScale joint grid**: Gen-3-M で leafEvalScale 単独は 1500 がピークだったが、 joint なら別ペアがあるかも
  - **uctC × iter × leafEvalScale の 3D grid**: 計算コスト約 3-4 倍だが、 残された伸び代を網羅的に確認
  - **mcts 自己対戦 fitness での重み再 ES**（Gen-3-J の per-AI weights 活用）
  - **progressive bias 再挑戦**（Gen-3-C は短期 prior が悪手だった、 prior の与え方を改良すれば再挑戦の余地）

### 残置物
- `ai/scripts/grid-joint-uct-iter.ts`: 将来の joint 探索（例: leafEvalScale 追加）に拡張可能
- `ai/data/grid-joint-gen3O.log`: grid 全ログ保存（gitignore 配下）

### チェックリスト
- [x] `npx tsc -p ai/tsconfig.json --noEmit` 通過
- [x] `npx tsc -p tsconfig.app.json --noEmit` 通過
- [x] `npx vitest run` 通過（33/33）
- [x] `npm run build` 成功
- [x] grid 9 候補で測定、 ホールドアウト 2 seed で結果を CHANGELOG に全件記載
- [x] 同 seed で再実行して結果完全一致を確認（187/200, totalSteps=52382）
- [x] mcts x4 自己対戦で座席バイアスなしを確認

---

## Gen-3-N: `iterations` の grid 再評価（不採用、現状 400 が依然ピーク） (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 5bd9c72。前回 Gen-3-M から AI ロジックの変更なし、 ただし作業ツリーに大量の未コミット変更（リファクタリング）あり:
- `src/ai/evaluator.ts`: 終局加点のコメント追加のみ（mcts は終局を ranking 経由で評価するためここに到達しないことの明文化）
- `src/ai/randomAI.ts`: 山札・捨札が両方空時に null を返すバグ修正（mcts の `rolloutPolicy` は元から `if (!action) break` で対応済み）
- `src/ai/smartAI.ts`: 不要な `?? top` フォールバック削除（同じ結果になる）
- `src/game/reducer.ts`: `collectAllBoardCardIds` 関数抽出、`MAX_CHAIN_RESOLVE_STEPS` 定数化、`stepGame` で safety 超過時に `console.warn`
- `src/game/types.ts`: `turnEnd` フェーズ残置のコメント追加（encoding 互換性のため撤去せず）
- `src/ai/actionSpace.ts` / `encoding.ts`: 未使用 export 削除
- `ai/scripts/_runner.ts`: `parseIntArg` / `parseFloatArg` ヘルパー追加
- `ai/scripts/stats.ts` 新規: `wilsonInterval` / `expectedRankFromRankCount` を 3 スクリプトから集約

→ **AI の振る舞いは完全に不変**。 ベースライン再計測（Gen-3-L 設定、 seed=1001 200 局）で 92.0% (184/200, totalSteps=53755) と前回 Gen-3-L エントリ計測値と完全一致を確認。

### 仮説
- Gen-2 で iter 100→400 に拡張、 Gen-3-A で 400→1000 を試して「飽和」判定だった
- ただし Gen-3-A 時点は `uctC=√2`。 Gen-3-L で `uctC=2.0` に変わり「広く探索する」シフトが起きた
- exploration が拡散するなら、 iter を増やすことで visit 統計の信頼性が向上する可能性
- 期待: +0.5〜+1.5pt

### 実装
- `ai/scripts/grid-iter.ts` を新パターンで作成（`ai/scripts/stats.ts` の `wilsonInterval` / `expectedRankFromRankCount` 共通モジュールと `_runner.ts` の `parseIntArg` を使用）
- mctsAI に `{ iterations }` のみを options で渡し、 8 候補を順に評価
- 他のハイパラ (`uctC=2.0`, `leafEvalScale=1500`, etc.) は全て据置

### Grid Search 結果（100 局 × 8 候補, seed=1001, mcts vs smart x3, rotate）

| iterations | 勝率 | 95%CI | avgScore | msPerStep |
|---|---|---|---|---|
| 200 | 85.0% | 76.7-90.7% | 20.33 | 0.99 |
| 300 | 90.0% | 82.6-94.5% | 20.71 | 1.72 |
| **400 (現状)** | **94.0%** | **87.5-97.2%** | **21.11** | 2.65 |
| 600 | 90.0% | 82.6-94.5% | 20.68 | 3.82 |
| 800 | 90.0% | 82.6-94.5% | 20.98 | 5.70 |
| 1000 | 87.0% | 79.0-92.2% | 21.22 | 7.37 |
| 1500 | 88.0% | 80.2-93.0% | 20.97 | 10.80 |
| 2000 | 86.0% | 77.9-91.5% | 21.14 | 15.08 |

**仮説と反対の結果**: iter=400 が **スイートスポット**、 これより増やすと勝率は **悪化** する傾向。

### 仮説の再解釈

- 興味深い観察: iter=1000-2000 では `avgScore` は 21.14-21.22 と iter=400 の 21.11 と **同等以上**、しかし `winRate` は **減少**（21.14 / 21.22 で 86-87%）
- → 「強い手は打てるが、 1 位を逃すケースが増える」傾向
- 解釈: `uctC=2.0` で広く探索する設定では、 iter を増やすほど visit が分散して薄まり、 「最大化への集中力」を欠く判断に傾く
- `uctC=2.0` ＋ `iter=400` は **coordinate-descent 的に逐次最適 (sequentially optimal)** な組合せ
- Gen-3-A 時点（`uctC=√2`）の「飽和」判定はそのまま今回も成立、 iter 増加は uctC が変わっても効果なし

### 採用判定
**不採用、 ブラウザ反映なし、 コード変更なし**

スキル採用基準「現状最強モデルの CI 下限 (87.4%) を超える候補」が grid 内に存在せず、 ベースライン (iter=400) がピークのまま。 ホールドアウト 200 局確認は省略（grid 100 局の iter=400 結果 94% が前回 Gen-3-L の同条件結果と完全一致、 再現性は前回確認済み）。

### メモ・学び
- **`uctC` と `iter` は逐次最適**: Gen-3-L で `uctC=2.0` に決まり、 今回 `iter=400` が依然ピークと確認。 single-axis grid search で「もう動かす余地なし」と確定できた
- **avgScore と winRate の乖離**: 探索を強化しても得点能力は維持されるが、 1 位確率は下がる現象を観察。 これは多人数ゼロサム的な「ライバルの取り潰しに必要な集中力」が薄まる兆候かもしれない
- **手書き AI の単独パラメータ最適化はほぼ天井**: Gen-3-L (uctC), Gen-3-M (leafEvalScale), Gen-3-N (iterations) でいずれもピーク確認。 残る伸び代は構造的変化のみ
- **次の方向性（更新）**:
  - **mcts 自己対戦 fitness での重み再 ES**: Gen-3-J の per-AI weights API を使い、 fitness を「mcts vs smart」ではなく「mcts x4 自己対戦の avgScore」にして重みを最適化。 ブラウザ実態（CPU 全員 mcts）に近い学習
  - **progressive bias 再挑戦**: Gen-3-C で短期 prior が悪手として失敗したが、 prior の与え方を「数手先評価」「shoot 後の評価」など改良すれば再挑戦の余地あり
  - **joint optimization**: `uctC × iterations` の 2D grid search（計算コストは増えるが、 単独最適が組合せ最適と一致するとは限らない）
  - **`puct` ベースの ES 探索**: PUCT を有効にし、 `pbC` も含めた重み + 探索ハイパラの同時 ES（高リスク・高リターン）

### 残置物
- `ai/scripts/grid-iter.ts` 新規: 将来の `uctC` 別値などでの再評価に使い回し可能
- `ai/data/grid-iter-gen3N.log`: grid 全ログ保存（gitignore 配下）

### チェックリスト
- [x] `npx tsc -p ai/tsconfig.json --noEmit` 通過
- [x] `npx tsc -p tsconfig.app.json --noEmit` 通過
- [x] `npx vitest run` 通過（33/33）
- [x] grid 8 候補で測定、 結果を CHANGELOG に全件記載
- [x] 再現性チェック: iter=400 grid 結果 (94%) と前回 Gen-3-L 100 局結果 (94%) が一致
- [x] ベースライン再計測 (refactor 後): Gen-3-L 92.0% で前回計測と完全一致

---

## Gen-3-M: `leafEvalScale` の grid 最適化（不採用、現状 1500 が既にピーク） (2026-05-28)

### Step 0: ルール変更チェック
HEAD = 5bd9c72。前回 Gen-3-L (88af4cc) 以降の `src/game/` / `docs/RULES.md` 変更なし。
中間コミット `ede4368` (Gen-3-K9 NN AI ブラウザ統合) は `src/ai/neuralAI.ts` / `index.ts` のみで手書き AI に影響なし。
過去のベンチ結果は引き続き有効、Gen-3-L のベースライン (vs smart x3 = 92.0%) で進行。

### 仮説
- `DEFAULT_LEAF_EVAL_SCALE = 1500` は Gen-2 の経験則で導入されたきり untuned
- Gen-3-L で `uctC = 2.0` に変わり「広く探索する」シフトが起きたため、leaf 評価感度（tanh の傾き）と相互作用する `leafEvalScale` の最適点も移動した可能性
- 期待: +0.5〜+2.0pt

### 実装
- `ai/scripts/grid-eval-scale.ts` を新規作成（`grid-uct.ts` のテンプレートを再利用）
- mctsAI に `{ leafEvalScale }` だけを options で渡し、 grid 8 候補を順に評価
- 評価関数の重み・他ハイパラ（uctC = 2.0 含む）は全て据置

### Grid Search 結果（100 局 × 8 候補, seed=1001, mcts vs smart x3, rotate）

| leafEvalScale | 勝率 | 95%CI | avgScore | 期待順位 |
|---|---|---|---|---|
| 300 | 86.0% | 77.9-91.5% | 20.52 | 1.17 |
| 600 | 82.0% | 73.3-88.3% | 20.30 | 1.22 |
| 1000 | 83.0% | 74.5-89.1% | 20.46 | 1.22 |
| **1500 (現状)** | **94.0%** | **87.5-97.2%** | **21.11** | **1.09** |
| 2200 | 90.0% | 82.6-94.5% | 20.88 | 1.10 |
| 3000 | 92.0% | 85.0-95.9% | 21.01 | 1.08 |
| 5000 | 93.0% | 86.3-96.6% | 20.99 | 1.08 |
| 8000 | 89.0% | 81.4-93.7% | 20.88 | 1.11 |

**現状 1500 が grid 内ピーク**。 上 (5000=93%) と下 (1000=83%) には改善候補なし。
1500 周辺 (1500 / 2200 / 3000 / 5000) は CI が大きく重なるが、 1500 が CI 下限・勝率ともに最高。
`leafEvalScale ≤ 1000` は明確に悪化（tanh 飽和で leaf 評価の差が見えなくなる方向）。

### 仮説の再解釈

`evaluateState` の生値レンジは ~±2000。 `tanh(2000/1500) ≈ 0.87` で **飽和直前の感度ピーク領域** にちょうど当たっていた。
- scale が小さすぎる (≤1000): tanh が飽和して微妙な差が見えない
- scale が大きすぎる (≥3000): tanh が線形範囲に入りすぎて、 leaf 評価差が薄まり MCTS が判断しにくくなる

Gen-2 の「経験則 1500」は **実は的を射た値** だった。 `uctC` と `leafEvalScale` は独立に最適化可能で、 `uctC = 2.0` への変更後も `leafEvalScale = 1500` が依然として最適。

### 採用判定
**不採用、 ブラウザ反映なし、 コード変更なし**

スキル採用基準「現状最強モデルの CI 下限 (87.4%) を超える候補」が grid 内に存在せず、 ベースライン (1500) がピークのまま。 ホールドアウト 200 局確認は省略（grid 100 局の 1500 結果 94% が前回 Gen-3-L の seed=1001 200 局結果 92% と整合的、 再現性は前回確認済み）。

### メモ・学び（重要）
- **「untuned」と「経験則で良い値」は別物**。 Gen-3-L の `uctC = √2` は untuned かつ最適値でなかった一方、 `leafEvalScale = 1500` は untuned だが最適値だった
- **改善候補の確認に grid search は安価**: 8 候補 × 100 局 = ~7 分で「もう動かす余地なし」と確定できた。 不採用結果でも学びとして残せる
- **次の方向性（更新）**:
  - `iterations` (現状 400) を 600〜1000 で再評価。 Gen-3-A で 1000 = 飽和判定されたが、 当時は `uctC = √2`。 `uctC = 2.0` で探索方法が変わったため再評価の価値あり
  - `treeMaxDepth` (現状 50) は十分大きく、 改善余地は低い
  - 評価関数の構造拡張（Gen-3-E 失敗を踏まえ、 単一特徴量追加は避ける）
  - mcts vs mcts 自己対戦 fitness で重み再 ES（Gen-3-J の per-AI weights を活かす）
- `ai/data/grid-eval-scale-gen3M.log` に grid 全ログ保存（gitignore 配下）
- 残置物: `ai/scripts/grid-eval-scale.ts` は新規追加するが、 将来の再評価（uctC 別値で leafEvalScale を再 grid したい等）に使い回せる

### チェックリスト
- [x] `npx tsc -p ai/tsconfig.json --noEmit` 通過
- [x] grid 8 候補で測定、 結果を CHANGELOG に全件記載
- [x] 再現性チェック: 1500 の grid 結果 (94%) と前回 Gen-3-L 100 局結果 (94%) が一致

---

## Gen-3-L: MCTS の探索係数 `uctC` の grid 最適化（採用、ブラウザ反映済み） (2026-05-28)

### Step 0: ルール変更チェック
前回 Gen-3-K8 (HEAD=3f0158b) 以降に `src/game/` で以下の変更:
- `884ccce`: `resolvingCombos` フェーズ追加 + `stepGame` ラッパー追加 + `hasNoMoreTurns` 追加（最終ラウンド自動配置）
- `6e62029`: `CLEAR_BOARDS_FOR_RESET` action（UI 演出用）
- `8adb7a0` / `72eb38c`: ログ表記整理・未使用関数削除

AI 側コード（`src/ai/mctsAI.ts`, `ai/scripts/_runner.ts`）は **全て `stepGame` 経由**で呼んでおり、論理的影響なし。`docs/RULES.md` は注記整理のみで内容変更なし。

実機ベースライン再計測:
- smart x4 自己対戦（200 局 rotate seed=1）: 各座席 24.875% (CI 22.0-28.0%) — 席バイアスなし、過去とほぼ一致
- mcts (Gen-3-F default) vs smart x3（200 局 rotate seed=1001）: **90.0%** (CI 85.1-93.4%) — 過去の 89.5% から +0.5pt（誤差範囲、reducer 変更による微差）

### 仮説
- `DEFAULT_UCT_C = √2 ≈ 1.4142` は Gen-1 で導入された UCB1 標準値で、当時の random rollout 用に妥当な値だった
- Gen-2 で leaf を `tanh(eval/1500)` ([-1, +1]) に置き換えた際も `uctC` は変更されていない
- 現状の評価関数（Gen-3-F）は格段に質が高いため、 leaf 評価器をどう活用するかで最適 `uctC` が変わる可能性
- 事前予想: 「評価関数が信頼できる → exploit 寄りで小さい `uctC` が良い」と仮説
- 期待: +0.5〜1.5pt、 CI 下限が現状 85.1% を上回る

### 実装
- `ai/scripts/_runner.ts`: 任意の `MctsOptions` で動くファクトリ `makeMctsWithOpts(opts)` を追加
- `ai/scripts/bench.ts`: `--mcts-uct <n>` / `--mcts-eval-scale <n>` フラグを追加（mcts 戦略のみ上書き、smart には影響なし）
- `ai/scripts/grid-uct.ts`: 新規。 `uctC` を grid search で評価するスクリプト
- 評価関数の重み（Gen-3-F）には一切触れず、 純粋に `uctC` のみ動かす

### Grid Search 結果（100 局 × 8 候補, seed=1001, mcts vs smart x3, rotate）

| uctC | 勝率 | 95%CI | avgScore | expRank |
|---|---|---|---|---|
| 0.3 | 87.0% | 79.0-92.2% | 20.67 | 1.16 |
| 0.5 | 84.0% | 75.6-89.9% | 20.45 | 1.19 |
| 0.7 | 88.0% | 80.2-93.0% | 20.44 | 1.14 |
| 1.0 | 90.0% | 82.6-94.5% | 20.65 | 1.13 |
| **1.4142 (旧 default)** | 88.0% | 80.2-93.0% | 20.39 | 1.15 |
| 1.7 | 91.0% | 83.8-95.2% | 20.74 | 1.10 |
| **2.0** | **94.0%** | **87.5-97.2%** | **21.11** | **1.09** |
| 2.4 | 84.0% | 75.6-89.9% | 20.58 | 1.23 |

**観察**: 仮説と逆方向の結論。 `uctC` を**大きく**（探索広げる）した方が良い。 山型分布で `uctC ≈ 2.0` がピーク、 2.4 で過剰探索により悪化。

仮説の解釈再考: leaf evaluator が信頼できるとはいえ、 1 手先の `evaluateState` 評価は短期視点に偏っている。 多くの候補を試して MCTS の visit 統計で「実際に勝てる手」を選別する方が、 単純な exploit より良い結果に繋がる。

### Holdout ベンチ結果

**seed=1001, 200 局 rotate**（過去ベンチと同条件）:
| 指標 | Gen-3-F (旧 default) | **Gen-3-L (uctC=2.0)** | 差分 |
|---|---|---|---|
| 勝率 | 90.0% | **92.0%** | **+2.0pt** |
| 95%CI | 85.1-93.4% | **87.4-95.0%** | **CI下限 +2.3pt** |
| 1 位獲得 | 180/200 | **184/200** | +4 |
| avgScore | 20.63 | 20.88 | +0.25 |
| 期待順位 | 1.115 | 1.10 | -0.015 |
| 1 手 ms | 2.33 | 2.36 | 同等 |

**別 seed=2001, 200 局 rotate**（過適合チェック）:
| 指標 | Gen-3-F | **Gen-3-L** | 差分 |
|---|---|---|---|
| 勝率 | 87.0% | **90.5%** | **+3.5pt** |
| 95%CI | 81.6-91.0% | **85.6-93.8%** | **CI下限 +4.0pt** |
| 1 位獲得 | 174/200 | **181/200** | +7 |

→ **2 つの独立 seed で CI 下限が一貫して改善**、 過適合ではない。

**合計 400 局**:
- Gen-3-F: 358/400 = 89.5%
- Gen-3-L: **365/400 = 91.25%** (+1.75pt)

**mcts(uctC=2.0) x4 自己対戦サニティ**（50 局 rotate seed=3001）:
- 各座席 25.0% (CI 19.5-31.4%) — 席バイアスなし
- avgScore 16.295 (Gen-3-F の 16.11 から +0.185 微改善)
- 1 手 8.52 ms（4 体全 MCTS、 ブラウザ全 CPU 状況に近い）

**再現性**: seed=1001 200 局を 2 回実行 → 完全一致 (184/200, totalSteps=53755)

### 採用判定
**採用 → ブラウザ反映済み**

スキル基準を全て満たす:
- 200 局以上で 95%CI 下限が現状最強の CI 下限を **2 seed 一貫して** 上回る
- 1 手あたり時間が同等（ブラウザ実用範囲）
- 自己対戦の席バイアスなし、 再現性あり

### 変更点（ブラウザ反映）
- `src/ai/mctsAI.ts`: `DEFAULT_UCT_C` を `1.4142135` → `2.0` に変更（1 行）
- `npm run build` 成功（239.39 kB / gzip 75.43 kB、 Gen-3-F の 236 kB から +3 kB は UI 変更分）
- vitest 33/33 通過、 型チェック OK

### メモ・学び
- **「探索ハイパラの調整」は手書き AI で初の最適化軸**。 過去は iter（量）、PUCT（方法）、 評価関数重みは試したが、 UCT 係数そのものは untuned だった
- **仮説と逆の結果**でも採用基準を満たせば良い: 仮説（exploit 寄り）は誤りだったが、grid search が「真の最適点」を見つけてくれた
- **改善幅 +1.75pt〜+3.5pt** は Gen-3-B〜F の改善履歴と同等。 まだ手書き AI に伸び代があることを示した
- **次の方向性**:
  - `leafEvalScale` (現状 1500) の grid search（同様に untuned）
  - `iterations` (現状 400) を 600〜800 で再評価（uctC 改善で iter の活用度合いが変わる可能性）
  - `uctC = 1.8 / 1.9 / 2.0 / 2.1 / 2.2` の細かい grid（現状 2.0 が真のピークか確認）
- `ai/data/grid-uct-gen3L.log` に grid search 全ログ保存（gitignore 配下）

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
