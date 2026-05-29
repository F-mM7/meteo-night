import type { EvalWeights } from './evaluator';

/**
 * Gen-3-B (1+1)-ES) で最適化した evaluator 重み。
 *
 * 学習条件:
 *   - opponent: smart x3
 *   - games per generation: 50
 *   - generations: 15
 *   - seed: 1 (training set: seed 1..50)
 *   - initial sigma: 0.3
 *   - init: 元の手書きデフォルト重み
 *
 * Holdout 評価（200 局, rotate, seed=1001）:
 *   - mcts(Gen-3-B) vs smart x3: 勝率 88.0% (95%CI 82.8% - 91.8%)
 *
 * `_runner.ts` の `mctsTuned` 戦略で参照される。
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
  endRoundLowReachPenalty: 0,
  endRoundHighReachBonus: 0,
  slotEvennessPenalty: 0,
  fieldOpportunityMatch: 0,
  selfScoreConvex: 0,
  chainReadyMult: 0,
};
