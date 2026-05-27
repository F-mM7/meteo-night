// tfjs-node-gpu の動作確認用 smoke test
import * as tf from '@tensorflow/tfjs-node-gpu';
import { ENCODING_SIZE } from '../../../src/ai/encoding';
import { ACTION_SPACE_SIZE } from '../../../src/ai/actionSpace';
import { VALUE_HEAD_SIZE } from './model';

console.log('tfjs version:', tf.version.tfjs);
console.log('backend:', tf.getBackend());

const input = tf.input({ shape: [ENCODING_SIZE], name: 'state' });
const h1 = tf.layers.dense({ units: 64, activation: 'relu', name: 'h1' }).apply(input) as tf.SymbolicTensor;
const h2 = tf.layers.dense({ units: 64, activation: 'relu', name: 'h2' }).apply(h1) as tf.SymbolicTensor;
const policy = tf.layers
  .dense({ units: ACTION_SPACE_SIZE, activation: 'softmax', name: 'policy' })
  .apply(h2) as tf.SymbolicTensor;
const value = tf.layers
  .dense({ units: VALUE_HEAD_SIZE, activation: 'tanh', name: 'value' })
  .apply(h2) as tf.SymbolicTensor;
const model = tf.model({ inputs: input, outputs: [policy, value], name: 'gpu_smoke' });

const sample = tf.zeros([16, ENCODING_SIZE]);
const t0 = Date.now();
for (let i = 0; i < 100; i++) {
  const out = model.predict(sample) as tf.Tensor[];
  out.forEach((t) => t.dispose());
}
const ms = Date.now() - t0;
console.log(`100 forward passes (batch=16): ${ms} ms = ${(ms / 100).toFixed(2)} ms/predict`);
sample.dispose();
