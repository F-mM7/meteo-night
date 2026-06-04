/**
 * train-value ― 大型 value ネットを tempo 自己対戦データ（gen-value-data.ts）で学習。
 *
 * 最強AI探索 / レイテンシ無制約。過去 AZ は小型(64×2)・MCTS ベースで頭打ちだったが、
 * ここでは配信制約を外して **大型・非線形** value ネット（多層）を GPU 学習し、
 * 「手書き評価(evaluateState) を超える value を学習できるか」を検証する前段。
 *
 * 入力: /tmp/vdata-*.bin（先頭 [count,dim], 続いて count 行 × (dim features + 1 value)）。
 * 出力: モデルを --out（既定 ai/models/value-v1）に保存 + held-out MSE/相関を表示。
 *
 * 例: npx tsx ai/scripts/nn/train-value.ts --units 256 --layers 4 --epochs 30
 */
import * as tf from '@tensorflow/tfjs-node-gpu';
import { readFileSync, readdirSync } from 'node:fs';
import { ENCODING_SIZE } from '../../../src/ai/encoding';

function loadAll(dir: string, prefix: string): { X: Float32Array; y: Float32Array; n: number; dim: number } {
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.bin')).sort();
  if (files.length === 0) throw new Error(`no ${prefix}*.bin in ${dir}`);
  // 1 パス目: 総サンプル数
  let total = 0; let dim = ENCODING_SIZE;
  const metas: Array<{ path: string; count: number }> = [];
  for (const f of files) {
    const buf = readFileSync(`${dir}/${f}`);
    const head = new Float32Array(buf.buffer, buf.byteOffset, 2);
    const count = head[0]; dim = head[1];
    metas.push({ path: `${dir}/${f}`, count });
    total += count;
  }
  const X = new Float32Array(total * dim);
  const y = new Float32Array(total);
  let off = 0;
  for (const m of metas) {
    const buf = readFileSync(m.path);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    let idx = 2;
    for (let r = 0; r < m.count; r++) {
      for (let j = 0; j < dim; j++) X[(off + r) * dim + j] = f32[idx++];
      y[off + r] = f32[idx++];
    }
    off += m.count;
  }
  return { X, y, n: total, dim };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let units = 256, layers = 4, epochs = 30, batch = 4096, out = 'ai/models/value-v1', lr = 1e-3;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--units') units = Number(argv[++i]);
    else if (k === '--layers') layers = Number(argv[++i]);
    else if (k === '--epochs') epochs = Number(argv[++i]);
    else if (k === '--batch') batch = Number(argv[++i]);
    else if (k === '--lr') lr = Number(argv[++i]);
    else if (k === '--out') out = argv[++i] ?? out;
    else throw new Error(`unknown arg: ${k}`);
  }

  console.error(`[train-value] backend=${tf.getBackend()} units=${units} layers=${layers} epochs=${epochs}`);
  const { X, y, n, dim } = loadAll('/tmp', 'vdata-');
  console.error(`loaded ${n} samples, dim=${dim}`);

  // baseline: 分散（平均予測の MSE）= y の分散。ネットの val MSE がこれを大きく下回れば学習成功。
  let my = 0; for (let i = 0; i < n; i++) my += y[i]; my /= n;
  let vary = 0; for (let i = 0; i < n; i++) vary += (y[i] - my) * (y[i] - my); vary /= n;
  console.error(`value mean=${my.toFixed(4)} var(=平均予測MSE)=${vary.toFixed(4)}`);

  const xs = tf.tensor2d(X, [n, dim]);
  const ys = tf.tensor2d(y, [n, 1]);

  const input = tf.input({ shape: [dim] });
  let h: tf.SymbolicTensor = input;
  for (let i = 0; i < layers; i++) {
    h = tf.layers.dense({ units, activation: 'relu', kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 }), name: `h${i + 1}` }).apply(h) as tf.SymbolicTensor;
    h = tf.layers.dropout({ rate: 0.3 }).apply(h) as tf.SymbolicTensor;
  }
  const value = tf.layers.dense({ units: 1, activation: 'tanh', name: 'value' }).apply(h) as tf.SymbolicTensor;
  const net = tf.model({ inputs: input, outputs: value });
  net.compile({ optimizer: tf.train.adam(lr), loss: 'meanSquaredError' });
  const nParams = net.countParams();
  console.error(`net params=${nParams}`);

  const url = out.startsWith('file://') ? out : `file://${process.cwd()}/${out}`;
  let bestVal = Infinity;
  await net.fit(xs, ys, {
    epochs, batchSize: batch, validationSplit: 0.1, shuffle: true,
    callbacks: {
      onEpochEnd: async (e, logs) => {
        const vl = logs?.val_loss ?? Infinity;
        let tag = '';
        if (vl < bestVal) { bestVal = vl; await net.save(url); tag = ' (saved best)'; }
        console.error(`epoch ${e + 1}/${epochs}  loss=${logs?.loss?.toFixed(5)}  val_loss=${vl.toFixed(5)}${tag}`);
      },
    },
  });
  console.error(`best val_loss=${bestVal.toFixed(5)} (baseline var=${vary.toFixed(4)}) saved -> ${out}`);
  console.error(`>>> 解釈: val_loss が var(${vary.toFixed(4)}) を大きく下回れば「ネットは state から value を学習できた」。次は手書き評価との勝者予測精度を比較。`);

  xs.dispose(); ys.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
