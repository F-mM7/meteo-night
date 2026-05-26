---
name: evolve-meteo-ai
description: 星を放つ夜 (MeteoNight) の CPU AI を 1 イテレーション進化させる。AI を強くしたい・MCTS / 評価関数 / NN を改善したい・self-play でベンチを取りたい、と言われたときに使う。
disable-model-invocation: false
---

# AI 進化サイクル (1 イテレーション)

このスキルは、`ai/CHANGELOG.md` に追記される「Gen-N」を 1 つ進めるための標準ワークフローです。
**1 イテレーション = 1 改善仮説**。複数仮説を同時投入してはいけません（原因が分からなくなるため）。

## 前提

- `npm install` 済み（`tsx` が devDependency にある）
- `src/game/` のゲームロジックを **学習側からも本番からも単一ソース**として使う
- ランダム性は **必ず seed 経由**（再現性のため）

## 手順

### 0. ルール変更チェック（必ず最初に実行）

ゲームルールは改訂される可能性があるため、**他の作業に入る前に必ず**前回 Gen 以降の変更を確認する。
ルールが変わっていれば、過去ベンチ結果・既存戦略・評価関数の前提が崩れている可能性がある。

- `docs/RULES.md` を読み、ゲームルールの最新版を把握する（これがルールの正）
- `ai/CHANGELOG.md` の最新エントリの日付を確認する
- その日付以降に `docs/RULES.md` および `src/game/` に変更がないかを git で確認:

  ```bash
  # <last-gen-date> は最新 Gen エントリの日付（YYYY-MM-DD）
  git log --since=<last-gen-date> --oneline -- docs/RULES.md src/game/
  ```

- 変更があれば diff を確認し、AI 側（評価関数・行動選択・MCTS シミュレータ等）への影響を見積もる:

  ```bash
  git diff <last-gen-commit>..HEAD -- docs/RULES.md src/game/
  ```

- ルール変更が見つかった場合の対応:
  - **過去のベンチ結果は無効**として扱う（同じ seed でも結果が変わるため）
  - ベースライン (`smart vs smart`, `smart vs random`) を取り直してから仮説立案に進む
  - 既存戦略のロジックがルール前提に依存していれば、まず追随修正してから進化サイクルを回す
  - 新しい Gen エントリの「メモ」欄に「ルール変更 X に追随」を明記する
- 変更がなかった場合のみ、次のステップへ進む

### 1. 現状把握

- `ai/CHANGELOG.md` の最新エントリを読み、現行 AI 構成と直近ベンチ結果を確認する
- `ai/README.md` のロードマップを見て、いま居るフェーズを確認する
- `src/ai/` の現行コードを軽く眺めて、何が実装済みかを把握する

### 2. ベースライン計測

```bash
npx tsx ai/scripts/bench.ts \
  --games 200 \
  --strategies smart,smart,smart,smart \
  --rotate --seed 1 --json
```

- 自己対戦の場合、勝率はほぼ 25% 付近に揃うべき。崩れていたら席バイアス or 実装バグ
- `smart vs random` の場合の勝率も別途取り、現行 smartAI の強さの絶対値を確認する

```bash
npx tsx ai/scripts/bench.ts \
  --games 200 \
  --strategies smart,random,random,random \
  --rotate --seed 1 --json
```

### 3. 改善仮説の立案

`ai/README.md` のロードマップ（フェーズ 0〜4）から、**次に追加する最小単位**を 1 つ選ぶ。
例:

- 「フェーズ 1 として IS-MCTS を導入する」
- 「フェーズ 2 として CMA-ES で evaluator の重みを最適化する」
- 「プレゼント先選択のヒューリスティックを改善する」

仮説を文章化し、**期待する勝率向上幅**を事前に書いておく（事後バイアス防止）。

### 4. 実装

- 既存戦略を壊さないよう、新戦略は別ファイル（例: `src/ai/mctsAI.ts`）として追加する
- `src/ai/index.ts` から export
- `ai/scripts/bench.ts` および `ai/scripts/selfplay.ts` の戦略名マップに登録

### 5. 再計測

新戦略 vs 旧戦略 を **最低 N=200 局**、`--rotate` を付けて回す。

```bash
npx tsx ai/scripts/bench.ts \
  --games 400 \
  --strategies <new>,<old>,<old>,<old> \
  --rotate --seed 1001 --json
```

- 必要に応じて seed を変えて複数回計測し、ばらつきも見る
- 1 手あたり時間も `selfplay.ts` の `durationMs / steps` から確認

### 6. 採用判定

採用条件（全て満たすことが望ましい）:

- 4 人中 1 体が新戦略の場合、**新戦略の勝率 > 25%**（自己対戦相当のベースラインを上回る）
- かつ、200 局以上で **両側 95% 信頼区間が 25% を含まない**（おおむね勝率 32% 以上）
- 1 手あたり時間が **ブラウザでの実用範囲（数百 ms 以内）**
- バグや非決定性が混入していない（同じ seed で何度回しても同じ結果）

未達ならロールバック or 設計再検討。

### 7. 記録

`ai/CHANGELOG.md` に Gen-(N+1) として追記。フォーマット:

```
## Gen-N: <短いタイトル>  (YYYY-MM-DD)

### 変更点
- ...

### ベンチ結果
- 対戦相手: <baseline 名>
- 試合数: <N>
- 勝率: <X>% (95%CI: <low>%〜<high>%)
- 平均得点: ...
- 1 手あたり時間: ...

### 採用判定
採用 / 不採用 / 保留

### メモ
- ...
```

### 8. 配信（NN モデル世代のみ）

学習済みモデルを採用した場合のみ、`public/models/<gen>/` 配下にコピーする。
ブラウザ側コードがロードするパスに合わせる。

## チェックリスト（コミット前）

- [ ] `npm run lint` を通した
- [ ] `npx vitest run` を通した（ゲームロジックを変更した場合）
- [ ] `bench` で測定した結果を CHANGELOG に記載した
- [ ] 同じ seed で再実行して結果が一致することを確認した（再現性チェック）
- [ ] 観戦モード (`npm run dev` → ヘッダーから ON) で 1 ゲーム最後まで進むことを目視確認した

## 重要な原則

- **毎回最初にルール変更チェック（ステップ 0）を実行する**。スキップ禁止
- 1 イテレーション = 1 仮説。**複数の改善を同時投入しない**
- ベンチは必ず `--rotate` 付き（席バイアス除去）
- 採用判定は **数字を見て客観的に**。「なんとなく強くなった気がする」は不採用
- 計測結果は CHANGELOG に必ず残す（将来のロールバック判断材料になる）
