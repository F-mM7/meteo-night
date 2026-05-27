/**
 * ゲームロジックの hot path を簡易プロファイルする。
 * mctsAI / neuralMcts のボトルネック特定用。
 */
import { setupGame } from '../../src/game/setup';
import { reducer, stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideSmart } from '../../src/ai/smartAI';
import { encodeState } from '../../src/ai/encoding';
import { legalActionIds, actionIdToAction } from '../../src/ai/actionSpace';
import { determinizeDeck, observationKey } from '../../src/ai/infoSet';

function bench(label: string, fn: () => void, iters: number): void {
  // warm-up
  for (let i = 0; i < Math.min(100, iters); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const perOp = (ms / iters).toFixed(4);
  const opsPerSec = Math.round((iters / ms) * 1000).toLocaleString();
  console.log(`  ${label.padEnd(40)} ${perOp.padStart(8)} ms/op   (${opsPerSec.padStart(12)} ops/sec)  total ${ms.toFixed(1)} ms / ${iters} iter`);
}

function currentActorId(s: GameState): number {
  if (s.phase === 'awaitingGiftPlacement' && s.turn.pendingGiftBatches.length > 0) {
    return s.turn.pendingGiftBatches[0].recipientId;
  }
  return s.currentPlayerIndex;
}

console.log('=== Game logic hot path profile ===\n');

// ============ 各関数の単体マイクロベンチ ============
const sampleState = setupGame({ seed: 42 });

bench('setupGame(seed=42)', () => setupGame({ seed: 42 }), 1_000);

bench('encodeState(state, 0)', () => encodeState(sampleState, 0), 100_000);
bench('legalActionIds(state, 0)', () => legalActionIds(sampleState, 0), 100_000);
bench('observationKey(state, 0)', () => observationKey(sampleState, 0), 50_000);
bench('determinizeDeck(state, 1)', () => determinizeDeck(sampleState, 1), 100_000);

// 1 step の reducer
const drawAction: Action = { type: 'DRAW_FROM_FIELD', pairIndex: 0 };
bench('reducer(state, DRAW_FROM_FIELD)', () => reducer(sampleState, drawAction), 100_000);

// stepGame (1 reducer + auto resolve)
bench('stepGame(state, DRAW_FROM_FIELD)', () => stepGame(sampleState, drawAction), 100_000);

// smartAI 1 手
bench('decideSmart(state, 1)', () => decideSmart(sampleState, 1), 10_000);

// ============ フルゲーム 1 局のコスト ============
console.log('\n=== Full game with smart x4 (single run, no warm-up) ===');
{
  const t0 = process.hrtime.bigint();
  let s = setupGame({ seed: 1001 });
  let steps = 0;
  while (s.phase !== 'gameOver' && steps < 5000) {
    const actor = currentActorId(s);
    const action = decideSmart(s, actor);
    if (!action) break;
    const before = s;
    s = stepGame(s, action);
    if (s === before) break;
    steps++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  smart x4 1 局: ${ms.toFixed(1)} ms / ${steps} steps  =  ${(ms / steps).toFixed(3)} ms/step`);
}

// ============ mctsAI シミュレーション内コスト相当 ============
console.log('\n=== Inner-loop hot operations ===');

// 一連の simulate (state copy + reducer + back) を模した処理
let s2 = sampleState;
bench('5-step random walk (typical sim depth)', () => {
  let local = s2;
  for (let i = 0; i < 5; i++) {
    const actor = currentActorId(local);
    const legal = legalActionIds(local, actor);
    if (legal.length === 0) break;
    const aid = legal[0];
    const a = actionIdToAction(local, actor, aid);
    if (!a) break;
    local = stepGame(local, a);
  }
}, 10_000);

bench('encodeState x 16 (NN batch input prep)', () => {
  for (let i = 0; i < 16; i++) encodeState(sampleState, i % 4);
}, 5_000);
