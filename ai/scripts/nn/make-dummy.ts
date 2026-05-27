/**
 * 学習なしで NN モデル構造のみ初期化して保存するスクリプト。
 *
 * 用途:
 *   - ブラウザ統合の動作確認（`public/models/dummy/` に置いて `neuralAI.loadModel` で読む）
 *   - バンドルサイズ計測（tfjs 込みの build を作るときの placeholder）
 *
 * 注意:
 *   - 重みはランダム初期化のままなので **AI として全く強くない**。動作確認用途のみ。
 *   - 構造（input/output 次元、 隠れ層）は本物の学習済みモデルと同じにしておくこと。
 *
 * 実行:
 *   npx tsx ai/scripts/nn/make-dummy.ts [out_dir] [hidden_units] [hidden_layers]
 *   デフォルト: out_dir=public/models/dummy, hidden_units=64, hidden_layers=2
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createModel, saveModel } from './model';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDir = path.resolve(argv[0] ?? 'public/models/dummy');
  const hiddenUnits = Number(argv[1] ?? 64);
  const hiddenLayers = Number(argv[2] ?? 2);

  mkdirSync(outDir, { recursive: true });

  const model = createModel({ hiddenUnits, hiddenLayers });
  console.log(
    `[make-dummy] creating model: hidden=${hiddenUnits}x${hiddenLayers}, ` +
      `input=${model.inputSize}, action=${model.actionSize}, value=${model.valueSize}`
  );
  model.net.summary();

  await saveModel(model, outDir);
  console.log(`[make-dummy] saved to ${outDir}/model.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
