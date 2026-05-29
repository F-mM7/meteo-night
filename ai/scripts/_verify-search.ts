import { setupGame } from '../../src/game/setup';
import { createPolicyOnlyModel } from './nn/model';
import { decideActionNeural } from './nn/neuralMcts';

const state = setupGame({ seed: 42 });
const model = createPolicyOnlyModel({ hiddenUnits: 256, hiddenLayers: 3 });

for (const bs of [1, 8, 16, 50, 100]) {
  const r = decideActionNeural(state, state.currentPlayerIndex, model, 123, {
    iterations: 100,
    batchSize: bs,
    useHeuristicValue: true,
  });
  const nz = Array.from(r.visits).filter((v) => v > 0).length;
  const sum = Array.from(r.visits).reduce((a, b) => a + b, 0);
  console.log(
    `batchSize=${String(bs).padStart(3)}  totalVisits=${String(r.totalVisits).padStart(4)}  visitSum=${String(sum).padStart(4)}  nonzeroActions=${nz}  action=${r.action?.type}`
  );
}
