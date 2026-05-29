/**
 * 1 局を通した「各意思決定での合法手数」 の分布を測る。
 * 分岐が小さいほど MCTS の prior（NN policy）の価値は薄い（UCT1 で全手展開すれば十分）。
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { legalActionIds } from '../../src/ai/actionSpace';

function currentActorId(s: GameState): number {
  if (s.phase === 'awaitingGiftPlacement' && s.turn.pendingGiftBatches.length > 0) {
    return s.turn.pendingGiftBatches[0].recipientId;
  }
  return s.currentPlayerIndex;
}

const hist = new Map<number, number>();
let total = 0;
let sum = 0;
for (let g = 0; g < 30; g++) {
  let s = setupGame({ seed: 7000 + g });
  let steps = 0;
  while (s.phase !== 'gameOver' && steps < 5000) {
    const actor = currentActorId(s);
    if (s.phase !== 'awaitingGiftSelection') {
      const n = legalActionIds(s, actor).length;
      hist.set(n, (hist.get(n) ?? 0) + 1);
      total++;
      sum += n;
    }
    const a = decideSmart(s, actor);
    if (!a) break;
    const before = s;
    s = stepGame(s, a);
    if (s === before) break;
    steps++;
  }
}

console.log(`平均合法手数: ${(sum / total).toFixed(2)} （${total} decisions, 30 games）`);
console.log('分布（合法手数: 出現回数, 割合）:');
for (const k of [...hist.keys()].sort((a, b) => a - b)) {
  const c = hist.get(k)!;
  console.log(`  ${String(k).padStart(2)}手: ${String(c).padStart(5)}  ${((c / total) * 100).toFixed(1)}%`);
}
