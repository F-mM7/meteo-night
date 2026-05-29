/**
 * AI 自己対戦での「連鎖（流星魔法）」 の挙動を定量診断する。
 *
 * 測定:
 *   - 発動した連鎖のサイズ分布（3,4,5,6+）
 *   - 1 ターンに複数連鎖を決めた頻度（チェイン）
 *   - 得点のうち「大連鎖 / チェインボーナス」 由来の割合
 *
 * 目的: 評価関数が reach の線形和で連鎖を近似しているのに対し、
 * 実スコアは超線形（size5=10pt, チェイン bonus）。 AI が実際に
 * 小連鎖ばかり打っていないかを確認する。
 *
 * 実行: npx tsx ai/scripts/_combo-stats.ts [strategy] [games]
 *   strategy: mcts (default) | smart
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { ComboRecord, GameState } from '../../src/game/types';
import { decideAction as decideMcts } from '../../src/ai/mctsAI';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { decideAction as decideChainRush } from '../../src/ai/chainRushAI';
import { basePointsForSize, comboCountBonus } from '../../src/game/scoring';

function currentActorId(s: GameState): number {
  if (s.phase === 'awaitingGiftPlacement' && s.turn.pendingGiftBatches.length > 0) {
    return s.turn.pendingGiftBatches[0].recipientId;
  }
  return s.currentPlayerIndex;
}

const strategy = process.argv[2] ?? 'mcts';
const games = Number(process.argv[3] ?? 20);
const decide =
  strategy === 'smart' ? decideSmart : strategy === 'chainRush' ? decideChainRush : decideMcts;

const sizeHist = new Map<number, number>(); // 連鎖サイズ -> 回数
const comboPerTurnHist = new Map<number, number>(); // 1ターンの連鎖数 -> 回数
let totalCombos = 0;
let totalTurnsWithCombo = 0;
let basePointsSum = 0;
let bonusPointsSum = 0;
let finalScoreSum = 0;

function recordTurn(combos: ComboRecord[]): void {
  if (combos.length === 0) return;
  totalTurnsWithCombo++;
  comboPerTurnHist.set(combos.length, (comboPerTurnHist.get(combos.length) ?? 0) + 1);
  for (const c of combos) {
    const size = c.cards.length;
    sizeHist.set(size, (sizeHist.get(size) ?? 0) + 1);
    totalCombos++;
    basePointsSum += basePointsForSize(size);
  }
  bonusPointsSum += comboCountBonus(combos.length);
}

for (let g = 0; g < games; g++) {
  let s = setupGame({ seed: 9000 + g });
  let prevCombos: ComboRecord[] = [];
  let prevActor = currentActorId(s);
  let steps = 0;
  while (s.phase !== 'gameOver' && steps < 5000) {
    const actor = currentActorId(s);
    const a = decide(s, actor);
    if (!a) break;
    const before = s;
    s = stepGame(s, a);
    if (s === before) break;
    // turn 境界 or combosThisTurn のリセットを検出
    const nowCombos = s.turn.combosThisTurn;
    if (prevCombos.length > 0 && (nowCombos.length === 0 || s.currentPlayerIndex !== prevActor)) {
      recordTurn(prevCombos);
    }
    prevCombos = nowCombos;
    prevActor = s.currentPlayerIndex;
    steps++;
  }
  if (prevCombos.length > 0) recordTurn(prevCombos);
  finalScoreSum += s.players.reduce((m, p) => Math.max(m, p.score), 0);
}

console.log(`=== combo stats: strategy=${strategy}, ${games} games ===`);
console.log(`連鎖サイズ分布:`);
for (const k of [...sizeHist.keys()].sort((a, b) => a - b)) {
  const c = sizeHist.get(k)!;
  console.log(
    `  size ${k} (${basePointsForSize(k)}pt): ${String(c).padStart(5)} 回  ${((c / totalCombos) * 100).toFixed(1)}%`
  );
}
console.log(`\n1ターンあたり連鎖数の分布:`);
for (const k of [...comboPerTurnHist.keys()].sort((a, b) => a - b)) {
  const c = comboPerTurnHist.get(k)!;
  console.log(
    `  ${k} 連鎖/turn: ${String(c).padStart(5)} 回  ${((c / totalTurnsWithCombo) * 100).toFixed(1)}%`
  );
}
console.log(`\n総連鎖数: ${totalCombos}, 連鎖ありターン: ${totalTurnsWithCombo}`);
console.log(`base 合計: ${basePointsSum}, チェインbonus 合計: ${bonusPointsSum} (bonus 比率 ${((bonusPointsSum / (basePointsSum + bonusPointsSum)) * 100).toFixed(1)}%)`);
console.log(`平均連鎖サイズ: ${([...sizeHist.entries()].reduce((s, [k, c]) => s + k * c, 0) / totalCombos).toFixed(2)}`);
console.log(`勝者の平均最終スコア: ${(finalScoreSum / games).toFixed(1)}`);
