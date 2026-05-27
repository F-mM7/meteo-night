import type { EvalWeights } from './evaluator';

/**
 * 元の手書き値（Gen-0 〜 Gen-2 のデフォルト）。Gen-3-B で更新される前のリファレンス。
 * 比較・ロールバック用に残す。
 * Gen-3-E で追加された `selfNearEnd` は当時存在しなかったため 0 に設定。
 */
export const PRE_GEN_3B_WEIGHTS: EvalWeights = {
  selfScoreMult: 100,
  selfNearEnd: 0,
  reach5plus: 240,
  reach4: 110,
  reach3: 60,
  reach2: 18,
  reach1: 1,
  chainSeed: 8,
  overflowPenalty: 6,
  threatScoreMult: 70,
  threatNearEnd: 50,
  threatReach3plus: 50,
  threatReach2: 12,
  threatChainSeed: 4,
  pendingMult: 120,
  winnerBonus: 4000,
  loserPenalty: 3000,
};

/**
 * Gen-3-B (1+1)-ES) で最適化した evaluator 重み。
 *
 * 学習条件:
 *   - opponent: smart x3
 *   - games per generation: 50
 *   - generations: 15
 *   - seed: 1 (training set: seed 1..50)
 *   - initial sigma: 0.3
 *   - init: DEFAULT_WEIGHTS (= PRE_GEN_3B_WEIGHTS)
 *
 * Holdout 評価（200 局, rotate, seed=1001）:
 *   - mcts(Gen-3-B) vs smart x3: 勝率 88.0% (95%CI 82.8% - 91.8%)
 *   - Gen-2 (PRE_GEN_3B) の 83.5% (CI 77.7% - 88.0%) を有意に上回る
 *
 * Gen-3-B-deploy で一度 DEFAULT_WEIGHTS に統合済み。Gen-3-B-2 で上書きされた。
 */
export const GEN_3B_WEIGHTS: EvalWeights = {
  selfScoreMult: 128.22308114925323,
  selfNearEnd: 0,
  reach5plus: 181.1648533845565,
  reach4: 108.01548292667681,
  reach3: 59.21639081334325,
  reach2: 20.104255507086865,
  reach1: 0.8612912323973585,
  chainSeed: 9.713223059806872,
  overflowPenalty: 4.9205921983557595,
  threatScoreMult: 64.46449304155591,
  threatNearEnd: 49.39238026995716,
  threatReach3plus: 53.51267771865361,
  threatReach2: 13.839157391988955,
  threatChainSeed: 2.9398965954637193,
  pendingMult: 126.18057109761712,
  winnerBonus: 3985.9107961471595,
  loserPenalty: 3060.1117760614543,
};

/**
 * Gen-3-B-2 warm-start ES で最適化した evaluator 重み。**現在の DEFAULT_WEIGHTS と同じ値**。
 *
 * 学習条件:
 *   - opponent: smart x3
 *   - games per generation: 50
 *   - generations: 15
 *   - seed: 2 (training set: seed 2..51)
 *   - initial sigma: 0.2
 *   - init: GEN_3B_WEIGHTS（warm-start）
 *
 * Holdout 評価（200 局, rotate, seed=1001）:
 *   - mcts(Gen-3-B-2) vs smart x3: 勝率 89.0% (95%CI 83.9% - 92.6%)
 *   - Gen-3-B からの差: +1pt（CI が重なる範囲、ばらつき範囲内の改善）
 */
export const GEN_3B2_WEIGHTS: EvalWeights = {
  selfScoreMult: 110.68766386988074,
  selfNearEnd: 0,
  reach5plus: 216.37505166701942,
  reach4: 76.99856616814654,
  reach3: 53.49770081072711,
  reach2: 17.18996642635589,
  reach1: 0.8242584693124786,
  chainSeed: 8.485294210109755,
  overflowPenalty: 5.7525350952661105,
  threatScoreMult: 73.71052289122602,
  threatNearEnd: 50.81278846162495,
  threatReach3plus: 51.07941033708995,
  threatReach2: 16.99991905531301,
  threatChainSeed: 3.5300284620102764,
  pendingMult: 104.68419689497898,
  winnerBonus: 4851.5373549978685,
  loserPenalty: 3364.1271324391355,
};

/**
 * Gen-3-E: 構造拡張（`selfNearEnd` 追加）+ ES（seed=4）。**holdout で過学習が露呈し不採用**。
 * 学習セット（seed=4, 50局）: avgScore 21.22 → 21.70
 * Holdout（seed=1001, 200局）: 勝率 85.5% (CI 80.0-89.7%) — Gen-3-B-2 の 89.0% から -3.5pt
 * 比較・再挑戦の参考用に保持。
 */
export const GEN_3E_WEIGHTS: EvalWeights = {
  selfScoreMult: 118.78310915791714,
  selfNearEnd: 31.066819895517195,
  reach5plus: 191.10370967390335,
  reach4: 66.43529899364823,
  reach3: 52.28390064344189,
  reach2: 16.851807805346066,
  reach1: 0.765069431577172,
  chainSeed: 6.5944559722015885,
  overflowPenalty: 5.538666416392362,
  threatScoreMult: 80.9193898730272,
  threatNearEnd: 51.13537743874848,
  threatReach3plus: 48.864069771695185,
  threatReach2: 21.525309990280864,
  threatChainSeed: 3.4408120109425244,
  pendingMult: 125.46504465530515,
  winnerBonus: 4725.629537969972,
  loserPenalty: 3188.9944069367075,
};

/**
 * Gen-3-F: 本格 warm-start ES（25世代 × 100局, seed=3, sigma=0.15, init=Gen-3-B-2）。**現在の DEFAULT_WEIGHTS と同じ値**。
 *
 * 学習結果:
 *   - 18 世代で sigma 0.01 以下に収束、早期終了
 *   - best ever (Gen 1): avgScore 21.37, winRate 96%, avgRank 1.07
 *   - default re-check (Gen-3-B-2): avgScore 21.21
 *
 * Holdout 評価（200局, rotate, seed=1001、selfNearEnd: 0 を加えて公平比較）:
 *   - mcts(Gen-3-F) vs smart x3: 勝率 89.5% (95%CI 84.5% - 93.0%)
 *   - Gen-3-B-2 (89.0%) から勝率 +0.5pt、CI 下限 +0.6pt、1 手 -11% 高速化
 *
 * Gen-3-F-deploy で `evaluator.DEFAULT_WEIGHTS` に統合済み。
 */
export const GEN_3F_WEIGHTS: EvalWeights = {
  selfScoreMult: 123.74412520337883,
  selfNearEnd: 0,
  reach5plus: 222.70006942917246,
  reach4: 89.8947341180037,
  reach3: 58.05799904016309,
  reach2: 15.306691551949978,
  reach1: 0.8372739229581236,
  chainSeed: 9.289075324072758,
  overflowPenalty: 6.6330490901926815,
  threatScoreMult: 56.6243109358727,
  threatNearEnd: 46.77124514736809,
  threatReach3plus: 63.067681967688806,
  threatReach2: 19.312148930790322,
  threatChainSeed: 3.099849098892464,
  pendingMult: 106.5629775591632,
  winnerBonus: 5211.641039704553,
  loserPenalty: 3128.971983687204,
};

/**
 * Gen-3-J で得られた重み。**per-AI weights 構造（mcts と smart で別重み）で学習した最初の世代**。
 *
 * 学習条件:
 *   - opponent: smart x3（重みは default = Gen-3-F に固定）
 *   - games per generation: 50
 *   - generations: 15（収束で早期終了）
 *   - seed: 5（既存 1〜4 と非重複）
 *   - initial sigma: 0.2
 *   - init: GEN_3F_WEIGHTS（warm-start）
 *
 * Holdout 評価:
 *   - per-AI モード（mcts のみ Gen-3-J / smart は default）: 200 局, seed=1001
 *     → 勝率 **90.0%** (95%CI 85.1-93.4%)
 *     → Gen-3-F (89.5%, CI 84.5-93.0%) から CI 下限 +0.6pt
 *   - 全 AI が Gen-3-J: 同じセットアップ
 *     → mcts 84.0% (CI 78.3-88.4%) — smart も同時に強化されて相打ち
 *   - mcts x4 自己対戦: 各座席 25%（席バイアスなし）、avg score 16.55 (Gen-3-F 16.11 から +0.44)
 *
 * 採用判断: **構造（per-AI weights API）は採用**、**ブラウザの DEFAULT_WEIGHTS は Gen-3-F のまま維持**。
 * ブラウザは全 CPU が mcts なので vs smart シナリオが発生せず、Gen-3-J の利点が出ないため。
 */
export const GEN_3J_WEIGHTS: EvalWeights = {
  selfScoreMult: 117.2885886285848,
  selfNearEnd: 0.14496430120959364,
  reach5plus: 279.96778349722905,
  reach4: 74.27835564758793,
  reach3: 67.54353772533815,
  reach2: 16.15224149641158,
  reach1: 0.8779343208100331,
  chainSeed: 7.266833785390641,
  overflowPenalty: 7.351753477404254,
  threatScoreMult: 66.30802458299044,
  threatNearEnd: 41.980281559842254,
  threatReach3plus: 56.34180173389534,
  threatReach2: 18.62842682747258,
  threatChainSeed: 2.825666281766402,
  pendingMult: 144.67493646502837,
  winnerBonus: 4904.049589827722,
  loserPenalty: 3378.013077258553,
};
