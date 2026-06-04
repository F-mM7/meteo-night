---
name: evolve-meteo-ai-handwritten
description: 星を放つ夜 (MeteoNight) の CPU AI を 1 イテレーション進化させる唯一の AI 進化スキル。現状最強は tempoFastAI（手書きの探索 + 評価関数、NN ではない）。探索（自分の手番のターン内完全読み）はほぼ完全で、葉（ターン終了局面）の評価が律速。物差しは必ず smart 非依存（候補 vs 現状最強 + Elo はしご、最終は人間体感）。強化は打ち止めにせず、低 EV でも新角度・大掛かり・不確実な仮説を執拗に試す（既知の同一 dead-end のみ回避。NN/AlphaZero 等は低天井実証済みだが別角度なら可）。
disable-model-invocation: false
---

# MeteoNight AI 進化サイクル (1 イテレーション)

`ai/CHANGELOG.md` の「Gen-N」を 1 つ進めるための標準ワークフロー。**1 イテレーション = 1 改善仮説**（複数同時投入は禁止）。

> **方針: 強化は打ち止めにしない。** 期待値が低くても、 新角度・大掛かり・不確実な仮説を執拗に試し続け、 より強い AI を目指す。 ただし (1) **既知の dead-end（下記）の同一構成は再試行しない**（別角度・より大規模・新アーキテクチャは可）、 (2) **必ず物差し（smart 非依存ベンチ + Elo + 最終は人間体感）で客観評価**し「強くなった気」 は採らない。 過去に天井（葉）を新しい次元（horizon=lookahead）で破った前例があるため、 頭打ちに見えても別次元を探し続ける。

## 現在地（2026-06 時点・必ず最新は CHANGELOG で確認）

> 🔄 **ルール (Gen-5, 2026-06-03)**: 山札 **120 枚（各色 24）**（旧 100 枚）。 重み再調整したが現重み最適（parity, 3 seed×2 horizon）＝AI は Gen-4-C 据置。 各色 20% の分布は不変なので最適点が動かない。

- **現状最強 = tempoFast + lookahead=1（Gen-4-C）**: ターン内完全読み + テンポ評価 + 時間予算/反復深化/αβ/置換表に、**2-ply(相手手番を挟み次の自分の手番まで)先読み**を追加。現 tempoFast(LA=0) に有意勝ち(33%, n=300)。1 手 ~1 秒と重く **Web Worker(`src/ai/aiWorker.ts`)で off-main-thread 実行**。`src/ai/index.ts`→`tempoFastAI`(既定 LA=1) を export。
- **強さ同等の素の版 = tempoAI（Gen-4-A）**: 同じ探索だがレイテンシ無制限（連鎖局面で最大 ~21 秒）。比較ベースラインに使う。
- **構成**: 探索はほぼ完全（ターン内完全読み + 1-ply 先読み）、 葉 = `evaluateState`（`src/ai/evaluator.ts`）+ `multiColorChainReadiness * tempoChainW(50)`。 葉の改善も horizon の深掘りも一巡して頭打ち（下記 dead-end）＝**次の伸びしろは未踏の角度（人間評価・別アーキ等）に**。
- **対象**: `src/ai/{tempoAI,tempoFastAI,evaluator}.ts`、`ai/scripts/{bench-self,_fast_bench,elo-ladder,_runner,stats}.ts`。
- **既知の dead-end（＝同一構成の単純再試行は不要。別角度・大規模化・新手法は歓迎）**: NN priors（branching 5.1 で無効）、価値学習 v1/v2/残差（探索が葉の誤差に頑健で play は parity）、葉の重み再最適化（DEFAULT がほぼ最適・n=96 ではノイズを拾う。 Gen-5 の 120 枚化後も再確認＝chainReadyMult/tempoChainW 上げは 3 seed×2 horizon で parity, 色分布不変）、多ターン連鎖**投影**（葉に貪欲ロールアウトを足す版＝弱い）、ギフト最適化、mcts ハイパラ、lookahead=2 / opp=tempo（予算内で頭打ち）、終盤適応 LA / 思考予算増（Gen-6: 終盤限定 LA=2 も同 budget 内で配置探索を削り parity〜微悪、 budget2000 も n=400 で 27.8% parity・再現せず）、 ML 駆動の特徴発掘（Gen-7: 自己対戦の勝敗予測で特徴の穴を探索＝材料報酬含め parity、 最強の新シグナル「席順」 は全候補手で同値の行動不能定数。 `ai/scripts/_feature_mine.ts`）、 深い探索/大量 MCTS/大規模 ML value（Gen-8: レイテンシ無制約でも mcts@2万・LA=2(opp=tempo)・GPU 学習 value ネットすべて tempo LA=1 に及ばず＝多く有意に下回る。 value ネットは勝者予測では手書き超え(0.325 vs 0.253)だがノイジーで探索の葉にすると壊滅(0%)。 根本機序＝均衡自己対戦の勝敗は本質的に予測困難で評価改善の余地が原理的に小さい。 `ai/scripts/nn/`）。⚠️ **未検証で残る本命の別角度**: 人間プレイの弱点診断/模倣（自己対戦＝自己参照では人間相手の弱点が見えない＝最優先・要ユーザー）、 ギフトの能動妨害（葉で「相手に渡す/渡したカードによる相手脅威の増減」 を評価＝既存「ギフト最適化(readiness 最小化 proxy)」 とは別角度）。⚠️ **これらは「その構成」 が効かなかっただけ**：例えば価値学習を別の教師信号(shaped return)で／重み tune を ≥300-500 局/eval で／lookahead を別アーキ(turn-MCTS)で、 は別仮説として有効。理由は CHANGELOG（探索ラウンド 1〜3 + Gen-4-C + horizon 深掘り）。

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

### 3. 改善仮説の立案（天井でも執拗に新角度を試す）

`ai/README.md` / CHANGELOG の「今後」を読む。葉（評価）の改善と horizon の深掘り（lookahead=2/opp=tempo）は parity で頭打ちと判明済み（lookahead=1 だけが効いた）。**だが打ち止めにはしない**——既知の同一構成（上記 dead-end）は避けつつ、 新角度・大掛かり・不確実な仮説を継続的に試す。 候補（期待値の高い順。 ただし全て不確実）:

1. **人間評価で弱点特定（最優先・最安・要ユーザー）**: 物差しが全て「vs tempo」＝自己参照で、 自己対戦では見えない弱点がありうる（旧「vs smart は錯覚」 と同型）。 ユーザーが現 AI と数局打ち、 下手な箇所（発火タイミング/妨害/複数連鎖ボーナス/終盤レース計時/山札管理 等）を具体化 → それを的にした改良。 **人間に効く改善の唯一の安価な道**。
2. **人間棋譜の模倣学習（最高天井・大コスト）**: 強い人間を上位教師に self-play の天井を破る。 要・対局記録 + 学習。
3. **より賢く安い相手モデルでの lookahead**: 先読みの相手を `smart` でなく `tempoFast@極小budget` 等に（2-ply 精度向上を狙う）。
4. **終盤レース計時の専用評価**: 20 点近傍で「誰が先に到達するか」 を明示モデル化（「点でなく勝ちに行く」 LA=1 の本質を終盤で先鋭化）。
5. **別アーキテクチャ**: ターン単位 MCTS（各ノード＝完全ターン解をサンプリングで多ターン先読み）、 outcome 接地の value を別定式化（残差でなく shaped return 等）、 ほか。
6. **既知 dead-end の「別角度」 再挑戦**: 価値学習を別の教師信号で／重み最適化を ≥300-500 局/eval の高精度で、 等（同一構成の単純再試行は不可）。

仮説と **期待勝率向上幅** を事前に文章化（事後バイアス防止）。 **低 EV でも、 物差しで客観評価しながら回し続ける**。

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
- **強化は打ち止めにしない**。葉も horizon(LA=1) も探索したが、頭打ちに見えても新次元（人間評価/模倣・別アーキ・大規模化）を執拗に試す（既知 dead-end の同一再試行のみ避ける）
- レイテンシはメインスレッド同期前提。時間予算で最悪値を有界化する
- 採用判定は数字で客観的に。「なんとなく強くなった気がする」は不採用
- 計測結果は CHANGELOG に必ず残す
