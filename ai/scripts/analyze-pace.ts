/**
 * 人間 vs AI の「得点ペース・効率」分析。
 *
 * カスケード仮説が否定された（cascadeAI は対AIで有意に弱い）ことを受け、人間の真の優位が
 * 「得点の立ち上がりの速さ・手番あたりの効率」にあるのではという仮説を検証する。
 *
 * 棋譜を再生し、各プレイヤーが 5/10/15/20 点に到達した turnNumber（経過の速さ）と、
 * 自分の手番あたり得点（効率）を、人間席(humanSeats) と AI席で比較する。
 *
 *   npx tsx ai/scripts/analyze-pace.ts <records.json> [<records2.json> ...]
 */
import { readFileSync } from 'node:fs';
import { stepGame } from '../../src/game/reducer';
import type { GameRecord } from '../../src/game/recording';

const THRESHOLDS = [5, 10, 15, 20];

function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.log('usage: npx tsx ai/scripts/analyze-pace.ts <records.json> [...]');
    process.exit(1);
  }
  const records: GameRecord[] = [];
  for (const p of paths) {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${p} は GameRecord 配列ではありません`);
    records.push(...(parsed as GameRecord[]));
  }

  const humanReach: Record<number, number[]> = { 5: [], 10: [], 15: [], 20: [] };
  const aiReach: Record<number, number[]> = { 5: [], 10: [], 15: [], 20: [] };
  let humanScoreSum = 0;
  let aiScoreSum = 0;
  let humanTurnSum = 0;
  let aiTurnSum = 0;
  let humanWinHandicap = 0; // 人間勝局での「2位との最終点差」
  let humanWins = 0;

  for (const rec of records) {
    const humanSeats = new Set(rec.humanSeats);
    let state = rec.initialState;
    const n = state.players.length;
    const reached: Record<number, number>[] = state.players.map(() => ({}));
    const turnCount = new Array<number>(n).fill(0); // 各プレイヤーの自手番数（ドロー回数）

    for (const action of rec.actions) {
      if (action.type === 'DRAW_FROM_FIELD' || action.type === 'DRAW_FROM_DECK') {
        turnCount[state.currentPlayerIndex]++;
      }
      state = stepGame(state, action);
      for (let pid = 0; pid < n; pid++) {
        const sc = state.players[pid].score;
        for (const th of THRESHOLDS) {
          if (sc >= th && reached[pid][th] === undefined) reached[pid][th] = state.turnNumber;
        }
      }
    }

    for (let pid = 0; pid < n; pid++) {
      const isHuman = humanSeats.has(pid);
      const tgt = isHuman ? humanReach : aiReach;
      for (const th of THRESHOLDS) {
        if (reached[pid][th] !== undefined) tgt[th].push(reached[pid][th]);
      }
      if (isHuman) {
        humanScoreSum += state.players[pid].score;
        humanTurnSum += turnCount[pid];
      } else {
        aiScoreSum += state.players[pid].score;
        aiTurnSum += turnCount[pid];
      }
    }

    const winnerId = rec.result.winnerId;
    if (winnerId !== null && humanSeats.has(winnerId)) {
      humanWins++;
      const sorted = [...rec.result.scores].sort((a, b) => b - a);
      humanWinHandicap += sorted[0] - sorted[1]; // 1位(人間)と2位の点差
    }
  }

  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '  - ');

  console.log(`\n=== 得点ペース・効率の分析 (${records.length}局) ===`);
  const humanSeatN = records.reduce((s, r) => s + r.humanSeats.length, 0);
  const aiSeatN = records.reduce((s, r) => s + (r.initialState.players.length - r.humanSeats.length), 0);
  console.log(`\nN点到達の平均ターン数（turnNumber、小さいほど速い）／到達した延べ人数:`);
  console.log(`        人間(${humanSeatN}席)            AI(${aiSeatN}席)`);
  for (const th of THRESHOLDS) {
    console.log(
      `  ${String(th).padStart(2)}点  ${avg(humanReach[th]).padStart(5)} (${humanReach[th].length}人)        ${avg(aiReach[th]).padStart(5)} (${aiReach[th].length}人)`
    );
  }
  console.log(`\n手番あたり得点（効率）: 人間 ${(humanScoreSum / Math.max(1, humanTurnSum)).toFixed(3)}   AI ${(aiScoreSum / Math.max(1, aiTurnSum)).toFixed(3)}`);
  console.log(`平均最終スコア:         人間 ${(humanScoreSum / records.length).toFixed(1)}   AI ${(aiScoreSum / (records.length * 3)).toFixed(1)}`);
  console.log(`平均自手番数:           人間 ${(humanTurnSum / records.length).toFixed(1)}   AI ${(aiTurnSum / (records.length * 3)).toFixed(1)}`);
  if (humanWins > 0) {
    console.log(`\n人間勝局(${humanWins})の平均勝ち点差(1位-2位): ${(humanWinHandicap / humanWins).toFixed(1)}点`);
  }
}

main();
