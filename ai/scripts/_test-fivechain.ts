/**
 * _test-fivechain.ts ― fiveChainAI が実際に「1ターン5連鎖」を組めるかを観察する。
 * 4席とも fiveChainAI で対局し、1ターンの発火回数（連鎖長）ヒストグラムを集計する。
 *   npx tsx ai/scripts/_test-fivechain.ts [games] [seed]
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideFive } from '../../src/ai/fiveChainAI';
import { currentActorId } from './_runner';

type Decider = (s: GameState, p: number) => Action | null;

function playGame(seed: number, deciders: Decider[], maxSteps: number) {
  let state = setupGame({ seed, cpuFlags: [true, true, true, true] });
  const firesHist = new Array<number>(9).fill(0); // index=1ターンの発火回数(0..8+)
  let prevCombo = 0;
  let prevTurn = state.turnNumber;
  let firesThisTurn = 0;
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const action = deciders[actor](state, actor);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    if (state.turnNumber !== prevTurn) {
      firesHist[Math.min(firesThisTurn, 8)]++;
      firesThisTurn = 0;
      prevTurn = state.turnNumber;
    }
    const cur = state.turn.combosThisTurn.length;
    if (cur > prevCombo) firesThisTurn += cur - prevCombo;
    prevCombo = cur;
    steps++;
  }
  firesHist[Math.min(firesThisTurn, 8)]++;
  return {
    firesHist,
    scores: state.players.map((p) => p.score),
    endTurn: state.turnNumber,
    finished: state.phase === 'gameOver',
  };
}

function main(): void {
  const games = process.argv[2] ? parseInt(process.argv[2], 10) : 8;
  const seed = process.argv[3] ? parseInt(process.argv[3], 10) : 50001;
  const maxSteps = 40000;
  const five: Decider = (s, p) => decideFive(s, p);

  const total = new Array<number>(9).fill(0);
  let maxScoreSum = 0;
  let endTurnSum = 0;
  let unfinished = 0;
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const r = playGame(seed + g, [five, five, five, five], maxSteps);
    for (let i = 0; i < 9; i++) total[i] += r.firesHist[i];
    maxScoreSum += Math.max(...r.scores);
    endTurnSum += r.endTurn;
    if (!r.finished) unfinished++;
    console.error(
      `  game ${g + 1}/${games}: scores=[${r.scores.join(',')}] turns=${r.endTurn} fires5+=${r.firesHist[5] + r.firesHist[6] + r.firesHist[7] + r.firesHist[8]} (${((Date.now() - t0) / 1000).toFixed(0)}s)`
    );
  }
  const turnsTotal = total.reduce((a, b) => a + b, 0);
  console.log(`\n=== fiveChainAI 4席自己対局 (${games}局, seed=${seed}) ===`);
  console.log(`1ターンの発火回数ヒストグラム（連鎖長の分布, 全${turnsTotal}手番）:`);
  for (let i = 0; i <= 8; i++) {
    const pct = turnsTotal ? ((total[i] / turnsTotal) * 100).toFixed(1) : '0.0';
    console.log(`  ${i === 8 ? '8+' : i}連鎖: ${String(total[i]).padStart(5)}  (${pct}%)`);
  }
  const big = total[5] + total[6] + total[7] + total[8];
  console.log(`\n5連鎖以上: ${big} 回  /  平均最高スコア ${(maxScoreSum / games).toFixed(1)}  平均終了ターン ${(endTurnSum / games).toFixed(1)}  未完了 ${unfinished}局`);
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
