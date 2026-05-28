/**
 * Gen-3-K: AlphaZero 風ネットワークの定義と save/load。
 *
 * 設計:
 *   - 入力: 状態を `encoding.ts` で固定長ベクトル化したもの（現状 185 次元）
 *   - 隠れ層: Dense 64 unit × 2 層（小規模、ブラウザ配信に最適）
 *   - 方策ヘッド: ACTION_SPACE_SIZE 次元の softmax（30 次元）
 *   - 価値ヘッド: Gen-3-K6 以降は NUM_PLAYERS 次元の tanh（各プレイヤー視点の rank-based value）
 *
 * Gen-3-K6 の変更:
 *   - 価値出力を 1 → 4 次元に拡張
 *   - mean-field 仮定（全 actor に同じ leaf value を backup）を解消
 *   - neuralMcts は path の各 actor について value[actor] を取り出して backup
 *   - 既存 az-v1〜v4 とは互換性なし（load 不能）
 */
import * as tf from '@tensorflow/tfjs-node-gpu';
import { ENCODING_SIZE } from '../../../src/ai/encoding';
import { ACTION_SPACE_SIZE } from '../../../src/ai/actionSpace';

/**
 * 価値ヘッドの出力次元数 = プレイヤー数。
 * 4 人プレイ固定（`docs/RULES.md` / 付録 参照）。
 */
export const VALUE_HEAD_SIZE = 4;

export interface MeteoAzModel {
  net: tf.LayersModel;
  inputSize: number;
  actionSize: number;
  valueSize: number;
}

export interface ModelOptions {
  hiddenUnits?: number;
  hiddenLayers?: number;
  l2?: number;
}

const DEFAULT_HIDDEN_UNITS = 64;
const DEFAULT_HIDDEN_LAYERS = 2;
const DEFAULT_L2 = 1e-4;

export function createModel(opts: ModelOptions = {}): MeteoAzModel {
  const hidden = opts.hiddenUnits ?? DEFAULT_HIDDEN_UNITS;
  const layers = opts.hiddenLayers ?? DEFAULT_HIDDEN_LAYERS;
  const l2 = opts.l2 ?? DEFAULT_L2;

  const input = tf.input({ shape: [ENCODING_SIZE], name: 'state' });
  let x: tf.SymbolicTensor = input;
  for (let i = 0; i < layers; i++) {
    x = tf.layers
      .dense({
        units: hidden,
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({ l2 }),
        name: `h${i + 1}`,
      })
      .apply(x) as tf.SymbolicTensor;
  }
  const policy = tf.layers
    .dense({
      units: ACTION_SPACE_SIZE,
      activation: 'softmax',
      kernelRegularizer: tf.regularizers.l2({ l2 }),
      name: 'policy',
    })
    .apply(x) as tf.SymbolicTensor;
  const value = tf.layers
    .dense({
      units: VALUE_HEAD_SIZE,
      activation: 'tanh',
      kernelRegularizer: tf.regularizers.l2({ l2 }),
      name: 'value',
    })
    .apply(x) as tf.SymbolicTensor;

  const net = tf.model({
    inputs: input,
    outputs: [policy, value],
    name: 'meteo_az_v1',
  });

  return {
    net,
    inputSize: ENCODING_SIZE,
    actionSize: ACTION_SPACE_SIZE,
    valueSize: VALUE_HEAD_SIZE,
  };
}

/**
 * 学習用のコンパイル。
 *   - 方策: categorical crossentropy（マスク後の確率分布に対する KL 風損失）
 *   - 価値: MSE
 *
 * Note: tfjs の型定義に `lossWeights` 配列指定がサポートされていないため、
 *       現状は方策と価値を 1:1 のバランスで合算する。
 *       AlphaZero 流の重み付けが必要なら、データ生成時に value target を係数倍するか、
 *       カスタムロス関数で実装する（次イテレーションで検討）。
 */
export function compileForTraining(
  model: MeteoAzModel,
  learningRate = 1e-3
): void {
  model.net.compile({
    optimizer: tf.train.adam(learningRate),
    loss: {
      policy: 'categoricalCrossentropy',
      value: 'meanSquaredError',
    },
  });
}

/**
 * モデルをディレクトリに保存。tfjs 標準フォーマット (`model.json` + `weights.bin`)。
 * `path` は `file://` プレフィックス付きで渡す必要がある。
 * ブラウザ側も同じフォーマットで `tf.loadLayersModel('/path/model.json')` で読める。
 */
export async function saveModel(model: MeteoAzModel, dir: string): Promise<void> {
  const url = dir.startsWith('file://') ? dir : `file://${dir}`;
  await model.net.save(url);
}

export async function loadModel(dir: string): Promise<MeteoAzModel> {
  const url = dir.startsWith('file://') ? dir : `file://${dir}/model.json`;
  const net = await tf.loadLayersModel(url);
  return {
    net,
    inputSize: ENCODING_SIZE,
    actionSize: ACTION_SPACE_SIZE,
    valueSize: VALUE_HEAD_SIZE,
  };
}
