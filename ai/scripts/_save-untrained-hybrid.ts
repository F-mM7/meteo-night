/**
 * 未学習の policy-only モデルを保存する（ハイブリッド方式の「学習前の上限」 計測用）。
 * 未学習 NN priors + Gen-3-F leaf value の MCTS が、 既存 mctsAI (Gen-3-F) と
 * 同等に戦えるかを確認するためのベースライン。
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createPolicyOnlyModel, saveModel } from './nn/model';

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] ?? 'ai/models/hybrid-untrained');
  mkdirSync(outDir, { recursive: true });
  const model = createPolicyOnlyModel({ hiddenUnits: 256, hiddenLayers: 3 });
  await saveModel(model, outDir);
  console.log(`saved untrained policy-only model to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
