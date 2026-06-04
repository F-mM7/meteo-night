/**
 * export-weights ― 学習した value ネットの重みを素の JSON に書き出す。
 * tempo 探索の葉から「tfjs を介さない plain-JS 前向き計算」で値を得るため（per-leaf の tfjs 呼び出しは遅すぎる）。
 *
 * 出力: { layers: [{ w: number[](in*out, row-major), b: number[], in, out, act }] }（h1..h4=relu, value=tanh）。
 * 例: npx tsx ai/scripts/nn/export-weights.ts --model ai/models/value-v1 --out src/ai/valueNetWeights.json
 */
import * as tf from '@tensorflow/tfjs-node-gpu';
import { writeFileSync } from 'node:fs';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let modelDir = 'ai/models/value-v1', out = 'src/ai/valueNetWeights.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') modelDir = argv[++i] ?? modelDir;
    else if (argv[i] === '--out') out = argv[++i] ?? out;
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  const net = await tf.loadLayersModel(`file://${process.cwd()}/${modelDir}/model.json`);
  const layers: Array<{ w: number[]; b: number[]; in: number; out: number; act: string }> = [];
  for (const layer of net.layers) {
    const ws = layer.getWeights();
    if (ws.length !== 2) continue; // dense のみ（dropout/input はスキップ）
    const kernel = ws[0].arraySync() as number[][]; // [in][out]
    const bias = ws[1].arraySync() as number[]; // [out]
    const inDim = kernel.length, outDim = bias.length;
    const w: number[] = new Array(inDim * outDim);
    for (let i = 0; i < inDim; i++) for (let o = 0; o < outDim; o++) w[i * outDim + o] = kernel[i][o];
    const act = layer.name === 'value' ? 'tanh' : 'relu';
    layers.push({ w, b: bias, in: inDim, out: outDim, act });
  }
  writeFileSync(out, JSON.stringify({ layers }));
  console.error(`[export-weights] ${layers.length} dense layers (${layers.map((l) => `${l.in}x${l.out}`).join(' -> ')}) -> ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
