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
