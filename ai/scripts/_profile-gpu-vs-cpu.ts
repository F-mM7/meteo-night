/**
 * 「GPU の優位性がいつ出るか」 を model size 別、 batch size 別に実測する。
 *
 * 実行例:
 *   # GPU 版
 *   export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:${LD_LIBRARY_PATH}
 *   npx tsx ai/scripts/_profile-gpu-vs-cpu.ts gpu
 *
 *   # CPU 版（GPU を意図的に隠す）
 *   CUDA_VISIBLE_DEVICES=-1 npx tsx ai/scripts/_profile-gpu-vs-cpu.ts cpu
 *
 *   # 両方を実行して JSON で出力
 *   npx tsx ai/scripts/_profile-gpu-vs-cpu.ts gpu > /tmp/gpu.json
 *   CUDA_VISIBLE_DEVICES=-1 npx tsx ai/scripts/_profile-gpu-vs-cpu.ts cpu > /tmp/cpu.json
 */
import * as tf from '@tensorflow/tfjs-node-gpu';
import { createModel } from './nn/model';

interface Result {
  label: string;
  modelParams: number;
  batchSize: number;
  msPerCall: number;
  msPerSample: number;
  samplesPerSec: number;
}

async function benchModel(
  hiddenUnits: number,
  hiddenLayers: number,
  batchSizes: number[]
): Promise<Result[]> {
  const model = createModel({ hiddenUnits, hiddenLayers });
  const params = model.net.countParams();
  const label = `hidden=${hiddenUnits}x${hiddenLayers}`;
  const out: Result[] = [];
  for (const bs of batchSizes) {
    const x = tf.zeros([bs, 185]);
    for (let i = 0; i < 5; i++) {
      const o = model.net.predict(x) as tf.Tensor[];
      o[0].dataSync();
      o[1].dataSync();
      o.forEach((t) => t.dispose());
    }
    const N = bs >= 128 ? 30 : bs >= 32 ? 50 : 100;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      const o = model.net.predict(x) as tf.Tensor[];
      o[0].dataSync();
      o[1].dataSync();
      o.forEach((t) => t.dispose());
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    out.push({
      label,
      modelParams: params,
      batchSize: bs,
      msPerCall: ms,
      msPerSample: ms / bs,
      samplesPerSec: Math.round((bs / ms) * 1000),
    });
    x.dispose();
  }
  model.net.dispose();
  return out;
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? 'unknown';
  const results: Result[] = [];

  const configs: Array<[number, number]> = [
    [64, 2], // 小モデル 18K params
    [256, 3], // 中モデル 188K
    [512, 6], // 大モデル 1.4M
    [1024, 6], // 超大モデル ~6M
    [1024, 12], // 超々大モデル ~12M
  ];
  const batches = [1, 16, 100, 256];

  console.error(`=== profile: backend=${tf.getBackend()}, tag=${tag} ===`);
  for (const [hu, hl] of configs) {
    const r = await benchModel(hu, hl, batches);
    results.push(...r);
    for (const x of r) {
      console.error(
        `  ${x.label.padEnd(16)} params=${String(x.modelParams).padStart(9)} batch=${String(x.batchSize).padStart(4)}  ${x.msPerCall.toFixed(2).padStart(7)} ms/call   ${x.samplesPerSec.toLocaleString().padStart(10)} samples/s`
      );
    }
  }

  // JSON も stdout に出す（CPU/GPU 比較のため）
  console.log(JSON.stringify({ tag, backend: tf.getBackend(), results }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
