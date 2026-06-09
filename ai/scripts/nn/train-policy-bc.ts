/**
 * 人間 policy の behavioral cloning（PoC）。
 *
 * gen-bc-data.ts が出した (x=encodeState 185次元, y=人間の行動ID 0..29, mask=合法手) を、
 * 深層 policy ネット（185 → 隠れ層 → 30 softmax）で教師あり学習する。ゲーム単位で train/test を
 * 分割し、held-out で **legal-masked top-1 精度**（合法手の中での argmax が人間手と一致する率）を測る。
 *
 * 目的: 深層 policy が E2 の線形プロキシ（配置ホールドアウト 23.3% > evaluateState 15.9%）を超えて
 * 人間着手を予測できるか＝「人間データを増やせば深層 cloning が効く」方針の早期検証。65 局は桁違いに
 * 少ないので、ここで線形と同等なら「律速は本当にデータ量」と裏取り、超えれば「深層化に価値」と分かる。
 *
 *   npx tsx ai/scripts/nn/train-policy-bc.ts --data /tmp/bc-data.json --test-games 12 --units 128 --layers 2 --epochs 60
 */
import * as tf from '@tensorflow/tfjs-node';
import { readFileSync } from 'node:fs';
import { parseIntArg, parseFloatArg } from '../_runner';

interface Sample {
  x: number[];
  y: number;
  mask: number[];
  isPlace: boolean;
  game: number;
}

function maskedTop1(
  probs: Float32Array | number[],
  rows: number,
  cols: number,
  samples: Sample[]
): { overall: number; place: number; placeN: number; randomBase: number } {
  let correct = 0;
  let placeCorrect = 0;
  let placeN = 0;
  let randSum = 0;
  for (let i = 0; i < rows; i++) {
    const s = samples[i];
    let best = -1;
    let bestP = -Infinity;
    let legalN = 0;
    for (let j = 0; j < cols; j++) {
      if (s.mask[j] === 0) continue;
      legalN++;
      const p = probs[i * cols + j];
      if (p > bestP) {
        bestP = p;
        best = j;
      }
    }
    randSum += legalN > 0 ? 1 / legalN : 0;
    if (best === s.y) {
      correct++;
      if (s.isPlace) placeCorrect++;
    }
    if (s.isPlace) placeN++;
  }
  return {
    overall: correct / Math.max(1, rows),
    place: placeCorrect / Math.max(1, placeN),
    placeN,
    randomBase: randSum / Math.max(1, rows),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dataPath = '/tmp/bc-data.json';
  let testGames = 12;
  let units = 128;
  let layers = 2;
  let epochs = 60;
  let batch = 128;
  let lr = 1e-3;
  let dropout = 0.4;
  let l2 = 1e-3;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--data') dataPath = argv[++i];
    else if (k === '--test-games') testGames = parseIntArg('--test-games', argv[++i]);
    else if (k === '--units') units = parseIntArg('--units', argv[++i]);
    else if (k === '--layers') layers = parseIntArg('--layers', argv[++i]);
    else if (k === '--epochs') epochs = parseIntArg('--epochs', argv[++i]);
    else if (k === '--batch') batch = parseIntArg('--batch', argv[++i]);
    else if (k === '--lr') lr = parseFloatArg('--lr', argv[++i]);
    else if (k === '--dropout') dropout = parseFloatArg('--dropout', argv[++i]);
    else if (k === '--l2') l2 = parseFloatArg('--l2', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }

  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
    dim: number;
    actionSpace: number;
    nGames: number;
    samples: Sample[];
  };
  const { dim, actionSpace: cols, nGames, samples } = data;
  const testCut = nGames - testGames;
  const train = samples.filter((s) => s.game < testCut);
  const test = samples.filter((s) => s.game >= testCut);

  console.error(
    `[bc] backend=${tf.getBackend()} dim=${dim} actions=${cols} units=${units} layers=${layers} epochs=${epochs}`
  );
  console.error(`[bc] train ${train.length}件 / test ${test.length}件（test=末尾${testGames}局）`);

  const xtr = tf.tensor2d(train.map((s) => s.x), [train.length, dim]);
  const ytr = tf.oneHot(tf.tensor1d(train.map((s) => s.y), 'int32'), cols);
  const xte = tf.tensor2d(test.map((s) => s.x), [test.length, dim]);
  const yte = tf.oneHot(tf.tensor1d(test.map((s) => s.y), 'int32'), cols);

  const input = tf.input({ shape: [dim] });
  let h: tf.SymbolicTensor = input;
  for (let i = 0; i < layers; i++) {
    h = tf.layers
      .dense({ units, activation: 'relu', kernelRegularizer: tf.regularizers.l2({ l2 }), name: `h${i + 1}` })
      .apply(h) as tf.SymbolicTensor;
    h = tf.layers.dropout({ rate: dropout }).apply(h) as tf.SymbolicTensor;
  }
  const logits = tf.layers
    .dense({ units: cols, activation: 'softmax', name: 'policy' })
    .apply(h) as tf.SymbolicTensor;
  const net = tf.model({ inputs: input, outputs: logits });
  net.compile({ optimizer: tf.train.adam(lr), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

  let bestTeMasked = 0;
  let bestEpoch = -1;
  let bestPlace = 0;
  await net.fit(xtr, ytr, {
    epochs,
    batchSize: batch,
    validationData: [xte, yte],
    verbose: 0,
    callbacks: {
      onEpochEnd: async (epoch, logs) => {
        // legal-masked の held-out top-1 を毎エポック測る（fit の val_acc は unmasked なので別途）。
        const probsT = net.predict(xte) as tf.Tensor;
        const probs = (await probsT.data()) as Float32Array;
        probsT.dispose();
        const m = maskedTop1(probs, test.length, cols, test);
        if (m.overall > bestTeMasked) {
          bestTeMasked = m.overall;
          bestEpoch = epoch;
          bestPlace = m.place;
        }
        if (epoch % 10 === 0 || epoch === epochs - 1) {
          console.error(
            `  epoch ${String(epoch).padStart(3)}  loss ${(logs?.loss ?? 0).toFixed(3)}  ` +
              `train_acc ${((logs?.acc ?? logs?.accuracy ?? 0) as number).toFixed(3)}  ` +
              `held-out masked top-1 ${(100 * m.overall).toFixed(1)}%（配置 ${(100 * m.place).toFixed(1)}%）`
          );
        }
      },
    },
  });

  // 最終評価。
  const probsT = net.predict(xte) as tf.Tensor;
  const probs = (await probsT.data()) as Float32Array;
  probsT.dispose();
  const fin = maskedTop1(probs, test.length, cols, test);

  console.error(`\n=== BC PoC 結果（held-out, legal-masked top-1）===`);
  console.error(`ランダム基準（合法手から一様）: ${(100 * fin.randomBase).toFixed(1)}%`);
  console.error(`深層 policy 最終: 全体 ${(100 * fin.overall).toFixed(1)}%  /  配置のみ ${(100 * fin.place).toFixed(1)}%（n=${fin.placeN}）`);
  console.error(`深層 policy 最良(epoch ${bestEpoch}): 全体 ${(100 * bestTeMasked).toFixed(1)}%  /  配置 ${(100 * bestPlace).toFixed(1)}%`);
  console.error(`参考: E2 線形プロキシ 配置ホールドアウト 23.3%（> evaluateState 15.9%）`);
  console.error(`→ 深層 policy の配置精度が 23.3% を明確に超えれば「深層化＋データ拡充」に価値あり。同等なら律速はデータ量。`);

  xtr.dispose();
  ytr.dispose();
  xte.dispose();
  yte.dispose();
}

main();
