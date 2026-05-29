/**
 * chainRushAI 挙動デバッグ用（使い捨て）。
 * 1 ゲーム（seat0=chainRush vs smart x3）を回し、 chainRush の awaitingDraw 手番ごとに
 * 「今発火したらの得点サンプル分布」 と現在スコアを出力。 単発発火が何点届くかを実測する。
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { GameState } from '../../src/game/types';
import { decideAction as decideChainRush, __debugFireSamples } from '../../src/ai/chainRushAI';
import { decideAction as decideSmart } from '../../src/ai/smartAI';

function currentActorId(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

const seed = Number(process.argv[2] ?? 1001);
let state = setupGame({
  seed,
  playerNames: ['chainRush', 'smart1', 'smart2', 'smart3'],
  cpuFlags: [true, true, true, true],
});

let steps = 0;
while (state.phase !== 'gameOver' && steps < 20000) {
  const actor = currentActorId(state);
  if (actor === 0 && state.phase === 'awaitingDraw') {
    const samples = __debugFireSamples(state, 0, 24);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = Math.max(...samples);
    const reach20 = samples.filter((s) => s >= 20).length / samples.length;
    console.log(
      `[turn ${state.turnNumber}] score=${state.players[0].score} ` +
        `fireSamples mean=${mean.toFixed(1)} max=${max} P(>=20)=${reach20.toFixed(2)}`
    );
  }
  const action = actor === 0 ? decideChainRush(state, 0) : decideSmart(state, actor);
  if (!action) break;
  const before = state;
  state = stepGame(state, action);
  if (state === before) break;
  steps++;
}
console.log('--- final ---');
console.log('scores:', state.players.map((p) => `${p.name}=${p.score}`).join(', '));
