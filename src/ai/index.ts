// ブラウザ CPU の既定 AI（Gen-15 採用）。grid 最適化で確証した目的志向ポリシー tempoChainAI
// （DEFAULT_GENOME=idx340: 5連鎖を狙い、構築中はテンポ評価を半々混合 blend=0.5）。実体 champion だった
// tempoFast(LA=1) に vs LA=1 300局で 32.7%（CI 27.6-38.2 >25%）・vs LA=0 2seed×1000局で 29.9% と有意勝ち。
// 発火は cascade.ts の実カスケード評価、nodeLimit=15000 でレイテンシ有界・aiWorker 経由で off-main-thread。
// 呼び出しは decideAction(state, actorId) の 2 引数（genome=DEFAULT_GENOME を使用）。
// 旧既定 tempoFastAI(LA=1) は存置。戻す場合は下の export を './tempoFastAI' に変更するだけ。
export { decideAction } from './tempoChainAI';

/**
 * ニューラルネット AI の動的ロード。
 *
 * 静的 import すると tfjs (+1.5 MB) が main chunk に混入して初回ロードが遅くなるため、
 * **動的 import** で別チャンクに分離している。
 *
 * 使い方（将来 App.tsx 等から）:
 *   const neural = await loadNeuralAI(`${import.meta.env.BASE_URL}models/active/model.json`);
 *   // 以降 neural.decideAction(state, playerId) を使う
 *   // モデルロード前 / ロード失敗時は内部で mctsAI にフォールバックする
 *
 * デザイン編集と競合させないため、 現状この関数はどこからも呼ばれていない。
 * 強い学習済みモデルが完成したら App / useGameLogic 側で差し替える想定。
 */
export async function loadNeuralAI(modelUrl: string): Promise<{
  decideAction: typeof import('./neuralAI').decideAction;
  isModelLoaded: typeof import('./neuralAI').isModelLoaded;
  getLastLoadError: typeof import('./neuralAI').getLastLoadError;
}> {
  const mod = await import('./neuralAI');
  await mod.loadModel(modelUrl);
  return {
    decideAction: mod.decideAction,
    isModelLoaded: mod.isModelLoaded,
    getLastLoadError: mod.getLastLoadError,
  };
}
