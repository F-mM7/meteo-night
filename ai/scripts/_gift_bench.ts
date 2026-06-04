/**
 * _gift_bench ― Gen-9「ギフト能動妨害」。tempoGift(評価ベースのギフト最適化) vs 現状最強 tempoFast。
 * 両者 LA=1/budget1000、ギフト選択のみが差分。1 席 vs 3 席, rotate, 公平 25%, Wilson CI。
 * 例: npx tsx ai/scripts/_gift_bench.ts --games 100 --seed 330000
 */
import { playOneGameWithDeciders, parseIntArg, type Decider } from './_runner';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { decideAction as decideTempoGift } from '../../src/ai/tempoGiftAI';
import { DEFAULT_WEIGHTS } from '../../src/ai/evaluator';
import { wilsonInterval } from './stats';

function main(): void {
  const argv = process.argv.slice(2);
  let games = 100, seed = 330000, budget = 1000, la = 1;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--la') la = parseIntArg('--la', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const candidate: Decider = (s, pid) =>
    decideTempoGift(s, pid, undefined, { weights: DEFAULT_WEIGHTS, lookaheadTurns: la, timeBudgetMs: budget });
  const baseline: Decider = (s, pid) =>
    decideTempoFast(s, pid, undefined, { weights: DEFAULT_WEIGHTS, lookaheadTurns: la, timeBudgetMs: budget });

  console.error(`[gift] cand=tempoGift(評価ベースのギフト最適化) vs base=tempoFast(smartギフト) | LA=${la} budget=${budget} games=${games} seed=${seed}`);

  let candWins = 0, candScoreSum = 0, baseScoreSum = 0, unfinished = 0;
  const candRankCount = [0, 0, 0, 0];
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    const names = [0, 1, 2, 3].map((s) => (s === candSeat ? 'cand' : 'base'));
    const r = playOneGameWithDeciders({ seed: seed + g, deciders, names, maxSteps: 20000 });
    if (r.ranking[candSeat] === 0) candWins++;
    candRankCount[r.ranking[candSeat]]++;
    candScoreSum += r.scores[candSeat];
    for (let s = 0; s < 4; s++) if (s !== candSeat) baseScoreSum += r.scores[s];
    if (!r.finished) unfinished++;
    if ((g + 1) % 10 === 0) console.error(`  ${g + 1}/${games} done, candWins=${candWins}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const winRate = candWins / games;
  const ci = wilsonInterval(candWins, games);
  const out = {
    la, budget, games, seed, candWins,
    candWinRate: +winRate.toFixed(4), fairBaseline: 0.25,
    winRateCI95: { low: +ci.low.toFixed(4), high: +ci.high.toFixed(4) },
    candAvgScore: +(candScoreSum / games).toFixed(2),
    baseAvgScore: +(baseScoreSum / (games * 3)).toFixed(2),
    candRankDist: candRankCount, unfinishedGames: unfinished,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  console.log(JSON.stringify(out, null, 2));
  const verdict = ci.low > 0.25 ? '✅ ギフト最適化が有意勝ち' : ci.high < 0.25 ? '❌ 有意に弱い' : '― 有意差なし (parity)';
  console.error(`\ncand winrate ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) -> ${verdict}`);
}

main();
