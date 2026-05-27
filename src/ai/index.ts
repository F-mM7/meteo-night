export { decideAction } from './mctsAI';

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
