/**
 * ES/GA（`evolve-weights.ts`）の適応度評価器。
 *
 * 候補 = tempoFast(DEFAULT_WEIGHTS に --weights の上書きを載せた重み) を 1 席（rotate）、
 * baseline = tempoFast(DEFAULT_WEIGHTS) を 3 席で対戦させ、候補席の勝ち数を返す。
 * 適応度 = 「固定した現状最強 tempoFast を撃破する勝率」＝**自己参照でない**目標
 * （人間が同構造[1席 vs 3 tempoFast]で 55% 勝つ＝到達可能と実証済み）。
 *
 * 機械可読出力のみ: 標準出力に `WINS <wins> <games>` の 1 行だけを出す（ES が parse する）。
 * 公平性のため候補・baseline に同一 budget / lookahead / rootDrawSamples を与える。
 * 同一 --seed なら同一対局列（CRN）＝世代内で候補を同じ盤面で比較でき選択ノイズを抑えられる。
 *
 *   npx tsx ai/scripts/eval-fitness.ts --weights '{"cascade2":40}' --games 40 --seed 60001 --budget 30 --lookahead 0 --root-samples 3
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { decideAction as decideBuild, type TempoBuildOptions } from '../../src/ai/tempoBuildAI';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { currentActorId, parseIntArg } from './_runner';

type Decider = (s: GameState, p: number) => Action | null;
const MAX_STEPS = 20000;

function isCandWinner(state: GameState, candSeat: number): boolean {
  // computeRanking と同等: 最高スコア（同点は startPlayerIndex からの距離が小さい方）。
  const players = state.players;
  let best = candSeat;
  for (const p of players) {
    if (p.id === candSeat) continue;
    if (p.score > players[best].score) best = p.id;
    else if (p.score === players[best].score) {
      const dThis = (p.id - state.startPlayerIndex + players.length) % players.length;
      const dBest = (players[best].id - state.startPlayerIndex + players.length) % players.length;
      if (dThis < dBest) best = p.id;
    }
  }
  return best === candSeat;
}

function playGame(seed: number, deciders: Decider[], candSeat: number): boolean {
  let state: GameState = setupGame({ seed, cpuFlags: [true, true, true, true] });
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < MAX_STEPS) {
    const actor = currentActorId(state);
    const action = deciders[actor](state, actor);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }
  return isCandWinner(state, candSeat);
}

function main(): void {
  const argv = process.argv.slice(2);
  let weightsJson = '{}';
  let games = 40;
  let seed = 60001;
  let budget = 30;
  let lookahead = 0;
  let rootSamples = 3;
  let ai = 'weights'; // 'weights'=tempoFast(候補重み) / 'build'=tempoBuildAI(候補パラメータ)
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--weights') weightsJson = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--lookahead') lookahead = parseIntArg('--lookahead', argv[++i]);
    else if (k === '--root-samples') rootSamples = parseIntArg('--root-samples', argv[++i]);
    else if (k === '--ai') ai = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  const chainSamples = Math.max(1, Math.floor(rootSamples / 2));

  let candidate: Decider;
  if (ai === 'build') {
    const params: TempoBuildOptions = {
      ...JSON.parse(weightsJson),
      timeBudgetMs: budget,
      rootDrawSamples: rootSamples,
      chainDrawSamples: chainSamples,
    };
    candidate = (s, p) => decideBuild(s, p, undefined, params);
  } else {
    const candWeights: EvalWeights = { ...DEFAULT_WEIGHTS, ...JSON.parse(weightsJson) };
    candidate = (s, p) =>
      decideTempoFast(s, p, undefined, {
        weights: candWeights,
        lookaheadTurns: lookahead,
        timeBudgetMs: budget,
        rootDrawSamples: rootSamples,
        chainDrawSamples: chainSamples,
      });
  }
  const baseline: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, {
      lookaheadTurns: lookahead,
      timeBudgetMs: budget,
      rootDrawSamples: rootSamples,
      chainDrawSamples: chainSamples,
    });

  let wins = 0;
  for (let g = 0; g < games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    if (playGame(seed + g, deciders, candSeat)) wins++;
  }
  process.stdout.write(`WINS ${wins} ${games}\n`);
}

main();
