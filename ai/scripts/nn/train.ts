/**
 * Gen-3-K: ネットワーク学習スクリプトの骨格。
 *
 * Usage:
 *   npx tsx ai/scripts/nn/train.ts [options]
 *
 * Options:
 *   --games <n>       1 イテレーションあたりの自己対戦数 (default: 50)
 *   --iter <n>        学習イテレーション数 (default: 5)
 *   --batch <n>       ミニバッチサイズ (default: 256)
 *   --epochs <n>      1 イテレーションあたりのエポック数 (default: 3)
 *   --lr <f>          学習率 (default: 1e-3)
 *   --seed <n>        自己対戦の base seed (default: 1)
 *   --out <dir>       モデル保存先ディレクトリ (default: ai/models/az-v0)
 *   --init <dir>      初期重みディレクトリ（warm-start 用、省略時は新規初期化）
 *
 * 注意: 本骨格は「既存 mcts による自己対戦 → 方策ヘッドを one-hot ターゲットで学習」する暫定版。
 *       本格的な AlphaZero ループ（MCTS の visit count を方策ターゲットに、
 *       学習済みネットを次の MCTS に反映してデータ生成）は次イテレーションで実装する。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as tf from '@tensorflow/tfjs-node-gpu';
import {
  compileForTraining,
  createModel,
  loadModel,
  saveModel,
  type MeteoAzModel,
} from './model';
import { generateDataset, generateDatasetWithModel, type LearnerExample } from './dataset';
import { parseFloatArg, parseIntArg } from '../_runner';

type SelfPlayMode = 'mcts' | 'neural';

interface Args {
  games: number;
  iter: number;
  batch: number;
  epochs: number;
  lr: number;
  seed: number;
  out: string;
  init: string | null;
  selfplay: SelfPlayMode;
  policyTemperature: number;
  /** neuralMcts のバッチ推論サイズ。 selfplay=neural のときのみ意味あり。 */
  mctsBatchSize: number;
  /** Gen-3-K5: NN 容量設定。 init が指定された場合は無視される（既存重みの shape に従う）。 */
  hiddenUnits: number;
  hiddenLayers: number;
  /**
   * Gen-3-K9: 学習完了後にモデルを public/ 配下にコピーするオプション。
   * ブラウザ統合用。 例: `--copy-to-public public/models/active`
   * 指定しない場合はコピーしない。
   */
  copyToPublic: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    games: 50,
    iter: 5,
    batch: 256,
    epochs: 3,
    lr: 1e-3,
    seed: 1,
    out: 'ai/models/az-v0',
    init: null,
    selfplay: 'mcts',
    policyTemperature: 1.0,
    mctsBatchSize: 1,
    hiddenUnits: 64,
    hiddenLayers: 2,
    copyToPublic: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--games':
        args.games = parseIntArg('--games', argv[++i]);
        break;
      case '--iter':
        args.iter = parseIntArg('--iter', argv[++i]);
        break;
      case '--batch':
        args.batch = parseIntArg('--batch', argv[++i]);
        break;
      case '--epochs':
        args.epochs = parseIntArg('--epochs', argv[++i]);
        break;
      case '--lr':
        args.lr = parseFloatArg('--lr', argv[++i]);
        break;
      case '--seed':
        args.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--init':
        args.init = argv[++i];
        break;
      case '--selfplay': {
        const v = argv[++i];
        if (v !== 'mcts' && v !== 'neural') throw new Error(`bad --selfplay: ${v}`);
        args.selfplay = v;
        break;
      }
      case '--tau':
        args.policyTemperature = parseFloatArg('--tau', argv[++i]);
        break;
      case '--mcts-batch':
        args.mctsBatchSize = parseIntArg('--mcts-batch', argv[++i]);
        break;
      case '--hidden-units':
        args.hiddenUnits = parseIntArg('--hidden-units', argv[++i]);
        break;
      case '--hidden-layers':
        args.hiddenLayers = parseIntArg('--hidden-layers', argv[++i]);
        break;
      case '--copy-to-public':
        args.copyToPublic = argv[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage: tsx ai/scripts/nn/train.ts [options]

Options:
  --games <n>       games per iteration (default: 50)
  --iter <n>        training iterations (default: 5)
  --batch <n>       mini-batch size (default: 256)
  --epochs <n>      epochs per iteration (default: 3)
  --lr <f>          learning rate (default: 1e-3)
  --seed <n>        self-play base seed (default: 1)
  --out <dir>       model save directory (default: ai/models/az-v0)
  --init <dir>      initial weights dir (warm-start, default: none)
  --selfplay <mode> mcts | neural (default: mcts)
                    mcts:   既存 mctsAI で self-play (warm-up 用、NN 未学習でも可)
                    neural: 学習中のモデルで neuralMcts self-play (AlphaZero ループ)
  --tau <f>         policy temperature for visits→target (default: 1.0)
  --mcts-batch <n>  neuralMcts batch predict size (default: 1, neural mode only)
                    Gen-3-K4: N>=2 で NN 推論を batch 化し 3-5x speedup
  --hidden-units <n>   隠れ層 unit 数 (default: 64, init 指定時は無視)
  --hidden-layers <n>  隠れ層数 (default: 2, init 指定時は無視)
  --copy-to-public <dir>  学習後 model.json/weights.bin を <dir> にコピー
                          ブラウザ統合用 (例: public/models/active)
`);
}

function examplesToTensors(
  examples: LearnerExample[]
): { x: tf.Tensor2D; pTarget: tf.Tensor2D; vTarget: tf.Tensor2D } {
  const n = examples.length;
  const stateSize = examples[0].state.length;
  const policySize = examples[0].policyTarget.length;
  const valueSize = examples[0].valueTarget.length;
  const xBuf = new Float32Array(n * stateSize);
  const pBuf = new Float32Array(n * policySize);
  const vBuf = new Float32Array(n * valueSize);
  for (let i = 0; i < n; i++) {
    xBuf.set(examples[i].state, i * stateSize);
    pBuf.set(examples[i].policyTarget, i * policySize);
    vBuf.set(examples[i].valueTarget, i * valueSize);
  }
  return {
    x: tf.tensor2d(xBuf, [n, stateSize]),
    pTarget: tf.tensor2d(pBuf, [n, policySize]),
    vTarget: tf.tensor2d(vBuf, [n, valueSize]),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('train args:', JSON.stringify(args));
  console.log('tfjs version:', tf.version.tfjs, 'backend:', tf.getBackend());

  let model: MeteoAzModel;
  if (args.init && existsSync(args.init)) {
    console.log(`loading initial weights from ${args.init}`);
    model = await loadModel(args.init);
  } else {
    console.log(
      `creating new model: hiddenUnits=${args.hiddenUnits} hiddenLayers=${args.hiddenLayers}`
    );
    model = createModel({
      hiddenUnits: args.hiddenUnits,
      hiddenLayers: args.hiddenLayers,
    });
  }
  compileForTraining(model, args.lr);
  model.net.summary();

  for (let it = 1; it <= args.iter; it++) {
    const seedBase = args.seed + (it - 1) * args.games;
    console.log(
      `\n=== iter ${it}/${args.iter}: self-play ${args.games} games (seed base ${seedBase}, mode ${args.selfplay}) ===`
    );
    const t0 = Date.now();
    const examples =
      args.selfplay === 'neural'
        ? generateDatasetWithModel(
            seedBase,
            args.games,
            model,
            args.policyTemperature,
            args.mctsBatchSize
          )
        : generateDataset(seedBase, args.games);
    const tGen = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`generated ${examples.length} examples in ${tGen}s`);

    if (examples.length === 0) {
      console.log('no examples, skipping training');
      continue;
    }

    const { x, pTarget, vTarget } = examplesToTensors(examples);
    const t1 = Date.now();
    const history = await model.net.fit(x, [pTarget, vTarget], {
      batchSize: args.batch,
      epochs: args.epochs,
      shuffle: true,
      verbose: 0,
    });
    const tFit = ((Date.now() - t1) / 1000).toFixed(1);
    const lastLoss = (history.history.loss as number[])[
      (history.history.loss as number[]).length - 1
    ];
    console.log(`trained ${args.epochs} epochs in ${tFit}s, final loss=${lastLoss.toFixed(4)}`);

    x.dispose();
    pTarget.dispose();
    vTarget.dispose();
  }

  await fs.mkdir(args.out, { recursive: true });
  await saveModel(model, args.out);
  console.log(`\nsaved model to ${args.out}/`);

  if (args.copyToPublic) {
    await fs.mkdir(args.copyToPublic, { recursive: true });
    await fs.copyFile(`${args.out}/model.json`, `${args.copyToPublic}/model.json`);
    // tfjs は重みファイルを weights.bin（複数ある場合は group1-shard1of1.bin など）として出力する。
    // 同ディレクトリの .bin を全部コピーする。
    const files = await fs.readdir(args.out);
    for (const f of files) {
      if (f.endsWith('.bin')) {
        await fs.copyFile(`${args.out}/${f}`, `${args.copyToPublic}/${f}`);
      }
    }
    console.log(`copied model to ${args.copyToPublic}/ for browser`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
