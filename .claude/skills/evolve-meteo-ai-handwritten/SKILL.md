---
name: evolve-meteo-ai-handwritten
description: 星を放つ夜 (MeteoNight) の手書き AI（smartAI / mctsAI / evaluator）を 1 イテレーション進化させる。NN ではなくヒューリスティック・評価関数・MCTS パラメータの改善を扱う。
disable-model-invocation: false
---

# 手書き AI 進化サイクル (1 イテレーション)

このスキルは `ai/CHANGELOG.md` に追記される「Gen-N」を 1 つ進めるための標準ワークフローです。
**対象**: `src/ai/{smartAI,mctsAI,evaluator,tunedWeights}.ts` および `ai/scripts/{bench,selfplay,tune-es}.ts`。
**対象外**: NN 系（tfjs-node, neuralMcts, AlphaZero ループなど）→ `evolve-meteo-ai-neural` スキル参照。

**1 イテレーション = 1 改善仮説**。複数仮説を同時投入してはいけません。

## 前提

- `npm install` 済み（`tsx` が devDependency にある）
- `src/game/` のゲームロジックを **学習側からも本番からも単一ソース**として使う
- ランダム性は **必ず seed 経由**（再現性のため）

## 手順

### 0. ルール変更チェック（必ず最初に実行）

ゲームルールは改訂される可能性があるため、**他の作業に入る前に必ず**前回 Gen 以降の変更を確認する。

- `docs/RULES.md` を読み、ゲームルールの最新版を把握する
- `ai/CHANGELOG.md` の最新エントリの日付を確認する
- その日付以降に `docs/RULES.md` および `src/game/` に変更がないかを git で確認:

  ```bash
  git log --since=<last-gen-date> --oneline -- docs/RULES.md src/game/
  ```

- 変更があれば diff を確認し、AI 側（評価関数・行動選択・MCTS シミュレータ等）への影響を見積もる:

  ```bash
  git diff HEAD -- docs/RULES.md src/game/
  ```

- ルール変更が見つかった場合の対応:
  - **過去のベンチ結果は無効**として扱う（同じ seed でも結果が変わるため）
  - ベースラインを取り直してから仮説立案に進む
  - 既存戦略のロジックがルール前提に依存していれば、まず追随修正してから進化サイクルを回す
  - 新しい Gen エントリの「メモ」欄に「ルール変更 X に追随」を明記する

### 1. 現状把握

- `ai/CHANGELOG.md` の最新エントリを読み、現行 AI 構成と直近ベンチ結果を確認する
- `ai/README.md` の冒頭「現状最強モデル」を確認する
- `src/ai/{smartAI,mctsAI,evaluator,tunedWeights}.ts` の現行コードを軽く眺めて、何が実装済みかを把握する

### 2. ベースライン計測

```bash
# 自己対戦（席バイアスがないことの確認）
npx tsx ai/scripts/bench.ts \
  --games 200 \
  --strategies smart,smart,smart,smart \
  --rotate --seed 1 --json

# mcts (現状ブラウザ反映済み) vs smart の確認
npx tsx ai/scripts/bench.ts \
  --games 200 \
  --strategies mcts,smart,smart,smart \
  --rotate --seed 1001 --json
```

- 自己対戦で勝率は 25% 付近に揃うはず。崩れていたら席バイアス or 実装バグ

### 3. 改善仮説の立案

`ai/README.md` のロードマップから、**次に追加する最小単位**を 1 つ選ぶ。手書き AI 系の典型例:

- evaluator の重みチューニング（CMA-ES / (1+1)-ES）
- mctsAI の探索ハイパラ調整（iterations, uctC, treeMaxDepth）
- ヒューリスティック改良（gift heuristic, smartAI の評価関数式）
- per-AI weights など API 拡張

仮説を文章化し、**期待する勝率向上幅**を事前に書いておく（事後バイアス防止）。

### 4. 実装

- 既存戦略を壊さないよう、新戦略は別ファイル（例: `src/ai/mctsAI.ts` の新 option）として追加する
- 旧版は `_runner.ts` の `STRATEGIES` に保持（ロールバック用）
- `src/ai/index.ts` から必要なら export
- `ai/scripts/bench.ts` および `ai/scripts/selfplay.ts` の戦略名マップに登録
- 評価関数の重み変更は `src/ai/tunedWeights.ts` に保存し、`evaluator.ts` の `DEFAULT_WEIGHTS` 更新は採用後

### 5. 再計測

新戦略 vs 旧戦略 を **最低 N=200 局**、`--rotate` を付けて回す。

```bash
npx tsx ai/scripts/bench.ts \
  --games 200 \
  --strategies <new>,<old>,<old>,<old> \
  --rotate --seed 1001 --json

# 重み単独の比較なら --weights / --mcts-weights を使う
npx tsx ai/scripts/bench.ts --weights ai/data/tuned-weights-X.json ...
```

- 必要に応じて seed を変えて複数回計測し、ばらつきも見る
- 1 手あたり時間も計測（ブラウザ実用範囲かの確認）

### 6. 採用判定

採用条件（全て満たすことが望ましい）:

- 新戦略の勝率 > 25%（自己対戦相当のベースラインを上回る）
- 200 局以上で **95% 信頼区間が、現状最強モデルの勝率 CI を上回る**
- 1 手あたり時間が **ブラウザ実用範囲（数百 ms 以内）**
- バグや非決定性が混入していない（同 seed で何度回しても同じ結果）

未達ならロールバック or 設計再検討。

### 7. 記録 + ブラウザ反映

`ai/CHANGELOG.md` に Gen-(N+1) として追記。フォーマット:

```
## Gen-N: <短いタイトル>  (YYYY-MM-DD)

### 仮説
- ...

### 変更点
- ...

### ベンチ結果
- 対戦相手: ...
- 試合数: ...
- 勝率: <X>% (95%CI: <low>%〜<high>%)
- 平均得点: ...
- 1 手あたり時間: ...

### 採用判定
採用 / 不採用 / 保留

### メモ
- ルール変更追随情報
- 失敗原因（不採用の場合）
```

採用した場合の **ブラウザ反映** 手順:
1. `src/ai/evaluator.ts` の `DEFAULT_WEIGHTS` を更新（重み変更の場合）
2. もしくは `src/ai/index.ts` の `decideAction` の export 元を変更
3. `npm run build` で動作確認
4. `ai/README.md` 冒頭の「現状最強モデル」セクションを更新

## チェックリスト（コミット前）

- [ ] `npx tsc -p ai/tsconfig.json --noEmit` と `npx tsc -p tsconfig.app.json --noEmit` を通した
- [ ] `npx vitest run` を通した（19/19）
- [ ] `bench` で測定した結果を CHANGELOG に記載した
- [ ] 同じ seed で再実行して結果が一致することを確認した（再現性チェック）
- [ ] 観戦モード (`npm run dev` → ヘッダーから ON) で 1 ゲーム最後まで進むことを目視確認した（ロジック変更時）

## 重要な原則

- **毎回最初にルール変更チェック（ステップ 0）を実行する**。スキップ禁止
- 1 イテレーション = 1 仮説。複数の改善を同時投入しない
- ベンチは必ず `--rotate` 付き（席バイアス除去）
- 採用判定は **数字を見て客観的に**。「なんとなく強くなった気がする」は不採用
- 計測結果は CHANGELOG に必ず残す（将来のロールバック判断材料になる）

## 関連スキル

- **NN 系 (AlphaZero) の進化**: `evolve-meteo-ai-neural` スキルを使う
- GPU 環境セットアップ: `docs/GPU_SETUP.md` 参照
