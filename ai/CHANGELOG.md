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
