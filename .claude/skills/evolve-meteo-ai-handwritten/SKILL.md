---
name: evolve-meteo-ai-handwritten
description: 星を放つ夜 (MeteoNight) の CPU AI を 1 イテレーション進化させる唯一の AI 進化スキル。現状最強は tempoFastAI（手書きの探索 + 評価関数、NN ではない）。探索（自分の手番のターン内完全読み）はほぼ完全で、葉（ターン終了局面）の評価が律速。物差しは必ず smart 非依存（候補 vs 現状最強 + Elo はしご）。NN/AlphaZero は本ゲームの低分岐で頭打ちと実証済みのため対象外。
disable-model-invocation: false
---

# MeteoNight AI 進化サイクル (1 イテレーション)

`ai/CHANGELOG.md` の「Gen-N」を 1 つ進めるための標準ワークフロー。**1 イテレーション = 1 改善仮説**（複数同時投入は禁止）。

## 現在地（2026-06 時点・必ず最新は CHANGELOG で確認）

- **現状最強 = tempoFastAI（Gen-4-B）**: 自分の手番をターン内 DFS で完全読み + テンポ評価。時間予算(1秒)+反復深化+αβ枝刈り+置換表で最悪レイテンシを ~1.0 秒に有界化。`src/ai/index.ts` がこれを export。
- **強さ同等の素の版 = tempoAI（Gen-4-A）**: 同じ探索だがレイテンシ無制限（連鎖局面で最大 ~21 秒）。比較ベースラインに使う。
- **探索はほぼ完全 → 伸びしろは「葉（ターン終了局面）の評価」**。葉 = `evaluateState`（`src/ai/evaluator.ts`）+ `multiColorChainReadiness * tempoChainW(50)`。
- **対象**: `src/ai/{tempoAI,tempoFastAI,evaluator}.ts`、`ai/scripts/{bench-self,_fast_bench,elo-ladder,_runner,stats}.ts`。
- **対象外（実証済みの行き止まり・着手しない）**: NN / AlphaZero（branching 5.1 で priors 無効、hand-eval に value も priors も勝てず az-v1〜v10 全敗）、教師あり価値学習（v1=フラット勝率で勾配消失 / v2=将来得点で未得点と混同、ともに失敗）、ギフト最適化（1 combo 1 枚で効果なし）、mcts 探索ハイパラ（Gen-3-O が天井）。理由は CHANGELOG 参照。

## 前提

- `npm install` 済み（`tsx` が devDependency）。乱数は必ず seed 経由（再現性）。
- `src/game/` のゲームロジックを学習側・本番の単一ソースとする。

## 手順

### 0. ルール変更チェック（必ず最初）

- `ai/CHANGELOG.md` 最新エントリの日付を確認し、それ以降に `src/game/`・`docs/RULES.md` が変わっていないか git で確認:
  ```bash
  git log --since=<last-gen-date> --oneline -- docs/RULES.md src/game/
  ```
- 変更があれば diff を見て AI への影響を見積もり、**過去のベンチは無効**としてベースラインを取り直す。Gen エントリのメモに追随情報を明記。

### 1. 現状把握

- `ai/CHANGELOG.md` 冒頭サマリ + 最新 Gen エントリ、`ai/README.md`「現状」を読む。
- `src/ai/{tempoAI,tempoFastAI,evaluator}.ts` を眺め、何が実装済みかを把握。

### 2. ベースライン計測（物差しは smart 非依存）

**⚠️ vs-smart ベンチは使わない**。smartAI と評価関数は盲点を共有し、連鎖の超線形価値など本質的な改善を検出できない（根本診断参照）。必ず「候補 1 席 vs 現状最強 3 席（rotate, 公平基準 25%, Wilson CI）」で測る。

```bash
# 偏りチェック（候補=現状最強なら ~25% に揃うはず）
npx tsx ai/scripts/_fast_bench.ts --base tempo --budget 1000 --games 48 --seed 31001

# Elo はしご（全 AI の相対強度・intransitivity 検出）
npx tsx ai/scripts/elo-ladder.ts --ais random,smart,mctsGen3X,tempo50 --games 0 --mixed --mixed-games 12 --json
```

- 評価関数の重み比較は `tempoFastAI` の `weights` オプション経由（`evaluator.ts` を編集せず options で渡す）。

### 3. 改善仮説の立案（葉が律速・現フロンティア）

`ai/README.md` / CHANGELOG の「今後」から最小単位を 1 つ選ぶ。tempo 時代の有望リード:

- **葉の評価重みを tempo 用に再最適化**: `evaluateState` の重みは mcts 時代の調整。tempo の探索向けに実勝率を直接最適化（CMA-ES / 座標降下、教師ありでなく）。
- **多ターン連鎖投影の葉**: 相手無視で自分だけ K ターン先まで貪欲に連鎖構築した期待得点を葉に（人間の多ターン仕込みを捕捉。2 手先読みは相手モデルが重く逆効果と実証済みなので相手はモデル化しない）。
- **evaluateState への残差価値学習**: 小さな補正のみを実勝敗で学習（連鎖構築を壊さない。教師ありを使うならこの形）。
- **終盤レース計時の専用評価** / **人間の実戦棋譜からの模倣学習**（強い人間という上位教師でself-playの天井を破る）。

仮説と **期待勝率向上幅** を事前に文章化（事後バイアス防止）。

### 4. 実装

- 現状最強を壊さないよう、**新戦略は別ファイル**（例 `src/ai/tempoXxxAI.ts`、`tempoFastAI` をコピーして葉や探索を差し替え）として追加。`tempoAI.ts` / `tempoFastAI.ts` / `evaluator.ts` / `index.ts` は実験中は編集しない。
- オプションで挙動を切替（`weights` / `tempoChainW` / `timeBudgetMs` 等）。ベンチ用スクリプトは `_xxx_` プレフィックスで追加。

### 5. 再計測（smart 非依存・確証）

- スクリーニングは高速な tempoFast 相手に 48 局、確証は **現状最強 tempo 相手に最低 150 局 × 2 seed**（`--rotate` 相当の席ローテーションは bench スクリプトが内蔵）。
- Wilson 95% CI、平均得点、**1 手あたりレイテンシ分布**（メインスレッド同期前提・最悪値が実用域か）を見る。fresh seed を使い w 調整用 seed を流用しない。

### 6. 採用判定（数字で客観的に）

- **強さ改善**: 候補 vs 現状最強の勝率 CI 下限 > 25%（公平基準を有意超過）。複数 seed で再現。
- **強さ非依存の改善（レイテンシ等）**: 強さは現状最強と有意差なし（CI が 25% を跨ぐ）かつ目的の指標が改善（Gen-4-B = 強さ同等でフリーズ解消、が前例）。
- レイテンシが実用域（メインスレッド同期、最悪値を時間予算で有界化）。同 seed で再現性あり。
- intransitivity 警戒（Elo はしごで A>B>C>A が無いか）。真の検証はユーザー（強い人間）の対戦体感。

### 7. 記録 + ブラウザ反映

`ai/CHANGELOG.md` に Gen-(N+1) を追記（既存エントリの書式に倣う: 仮説 / 変更点 / ベンチ結果 / 採用判定 / メモ）。冒頭「現状最強モデル」サマリ表と `ai/README.md`「現状」も更新。

採用時のブラウザ反映:
1. 評価重み変更なら `evaluator.ts` の `DEFAULT_WEIGHTS` を更新、AI 切替なら `src/ai/index.ts` の `decideAction` の export 元を変更
2. `tsc -b` / `npx vitest run` / `npm run build` を通す
3. `npm run dev` の観戦/対戦で 1 ゲーム目視（ロジック変更時）

## サブエージェントに委譲する場合の注意

ベンチは 10〜分かかるため委譲したくなるが、子エージェントに「bench をバックグラウンド起動 → 完了通知待ち」 をさせると、子が自分のターンを早期終了して最終報告を出さずループする（本リポジトリで複数回発生）。委譲時は **「全コマンド前景実行・短いスクリーニングのみ・最終報告に必ず数値を返す」** を厳命し、**遅い確証ベンチはオーケストレータ側に集約**する。

## チェックリスト（コミット前）

- [ ] `npx tsc -b` を通した
- [ ] `npx vitest run` を通した（全テスト pass）
- [ ] smart 非依存ベンチ（候補 vs 現状最強 + Elo）の結果を CHANGELOG に記載した
- [ ] 同 seed 再実行で結果一致（再現性）
- [ ] 1 手あたり最悪レイテンシが実用域であることを確認した

## 重要な原則

- 毎回ステップ 0（ルール変更チェック）を実行。スキップ禁止
- 1 イテレーション = 1 仮説
- **物差しは必ず smart 非依存（候補 vs 現状最強 + Elo）。vs-smart は盲点指標なので禁止**
- **探索は完全 → 葉評価が律速**。改善はそこに集中
- レイテンシはメインスレッド同期前提。時間予算で最悪値を有界化する
- 採用判定は数字で客観的に。「なんとなく強くなった気がする」は不採用
- 計測結果は CHANGELOG に必ず残す
