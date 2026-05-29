/**
 * Gen-3-K12 検討用プロファイラ。
 * parallel self-play パイプラインの hot path を「各コンポーネント単体」 で計測する。
 *
 * 実行例:
 *   export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}
 *   npx tsx ai/scripts/_profile-nn-selfplay.ts
 *
 * 出力: 各 component の ms/op、 ops/sec、 batch サイズ別 NN predict 速度。
 * 「全体ループに対する寄与」 を概算するためのデータ。
 */
import * as tf from '@tensorflow/tfjs-node-gpu';
import { createModel } from './nn/model';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { encodeState } from '../../src/ai/encoding';
import { legalActionIds, actionIdToAction } from '../../src/ai/actionSpace';
import { determinizeDeck, observationKey } from '../../src/ai/infoSet';
import { decideAction as decideSmart } from '../../src/ai/smartAI';

function bench(label: string, fn: () => void, iters: number): void {
  for (let i = 0; i < Math.min(100, iters); i++) fn(); // warm-up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perOp = (ms / iters).toFixed(4);
  const opsPerSec = Math.round((iters / ms) * 1000).toLocaleString();
  console.log(
    `  ${label.padEnd(40)} ${perOp.padStart(8)} ms/op   (${opsPerSec.padStart(12)} ops/sec)`
  );
}

function currentActorId(s: GameState): number {
  if (s.phase === 'awaitingGiftPlacement' && s.turn.pendingGiftBatches.length > 0) {
    return s.turn.pendingGiftBatches[0].recipientId;
  }
  return s.currentPlayerIndex;
}

async function main(): Promise<void> {
  console.log('=== NN parallel self-play hot path profile ===');
  console.log(`tf backend: ${tf.getBackend()}\n`);

  const state = setupGame({ seed: 42 });
  const action: Action = { type: 'DRAW_FROM_FIELD', pairIndex: 0 };

  console.log('--- Game logic micro bench ---');
  bench('encodeState(state, 0) -> number[]', () => encodeState(state, 0), 20_000);
  bench('Float32Array.from(encodeState(...))', () => Float32Array.from(encodeState(state, 0)), 20_000);
  bench('observationKey(state, 0) -> string', () => observationKey(state, 0), 20_000);
  bench('legalActionIds(state, 0)', () => legalActionIds(state, 0), 50_000);
  bench('determinizeDeck(state, 42)', () => determinizeDeck(state, 42), 20_000);
  bench('stepGame(state, DRAW_FROM_FIELD)', () => stepGame(state, action), 20_000);
  bench('actionIdToAction(state, 0, 0)', () => actionIdToAction(state, 0, 0), 50_000);
  bench('decideSmart(state, 0)', () => decideSmart(state, 0), 5_000);

  console.log('\n--- NN predict (model: hidden=512x6, 1.4M params) ---');
  const model = createModel({ hiddenUnits: 512, hiddenLayers: 6 });
  const dummyInput = (b: number) => tf.zeros([b, 185]);
  for (const bs of [1, 4, 8, 16, 32, 64, 128, 256]) {
    const x = dummyInput(bs);
    // warm-up
    for (let i = 0; i < 5; i++) {
      const o = model.net.predict(x) as tf.Tensor[];
      o[0].dataSync();
      o[1].dataSync();
      o.forEach((t) => t.dispose());
    }
    const N = bs >= 64 ? 30 : 100;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      const o = model.net.predict(x) as tf.Tensor[];
      o[0].dataSync();
      o[1].dataSync();
      o.forEach((t) => t.dispose());
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    console.log(
      `  predict batch=${bs.toString().padStart(4)}: ${ms.toFixed(2).padStart(7)} ms/call   ${(ms / bs).toFixed(3)} ms/sample   ${Math.round((bs / ms) * 1000).toLocaleString().padStart(8)} samples/s`
    );
    x.dispose();
  }

  console.log('\n--- NN predict (model: hidden=64x2, 18K params 小モデル) ---');
  const smallModel = createModel({ hiddenUnits: 64, hiddenLayers: 2 });
  for (const bs of [1, 16, 64, 128]) {
    const x = dummyInput(bs);
    for (let i = 0; i < 5; i++) {
      const o = smallModel.net.predict(x) as tf.Tensor[];
      o[0].dataSync();
      o[1].dataSync();
      o.forEach((t) => t.dispose());
    }
    const N = 100;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      const o = smallModel.net.predict(x) as tf.Tensor[];
      o[0].dataSync();
      o[1].dataSync();
      o.forEach((t) => t.dispose());
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    console.log(
      `  predict batch=${bs.toString().padStart(4)}: ${ms.toFixed(2).padStart(7)} ms/call   ${(ms / bs).toFixed(3)} ms/sample`
    );
    x.dispose();
  }

  console.log('\n--- 5-step random walk (sim depth 5、 ctxRunSelection 1 iter 相当) ---');
  bench(
    '5-step random walk',
    () => {
      let s = state;
      for (let i = 0; i < 5; i++) {
        const actor = currentActorId(s);
        const legal = legalActionIds(s, actor);
        if (legal.length === 0) break;
        const aid = legal[0];
        const a = actionIdToAction(s, actor, aid);
        if (!a) break;
        s = stepGame(s, a);
      }
    },
    5_000
  );

  console.log('\n--- 1 simulation 推定（determinize + observationKey×5 + step×5 + legal×5 + encode×1）---');
  bench(
    '1 simulation (no Map, no Float32Array.from)',
    () => {
      const seed = (Math.random() * 1e9) | 0;
      let s = determinizeDeck(state, seed);
      for (let i = 0; i < 5; i++) {
        const actor = currentActorId(s);
        const legal = legalActionIds(s, actor);
        observationKey(s, 0);
        if (legal.length === 0) break;
        const a = actionIdToAction(s, actor, legal[0]);
        if (!a) break;
        s = stepGame(s, a);
      }
      encodeState(s, 0); // leaf encoding
    },
    5_000
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
