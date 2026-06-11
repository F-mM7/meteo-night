// ブラウザ CPU の既定 AI（2026-06-11 採用）: GRM（目標到達確率最大化法・第3路線、仕様 ai/REACHABILITY.md）。
// 配信構成 = V=20, P=0.5, K=6, 時間予算 3000ms（tstar v1 移植: 解析推定の多色レース閉形式＋上限つきプローブ）。
// 事前登録 fresh 決定的テストで旧既定 tempoChain（3席）に 31.1%（CI 28.0-34.4 > 公平25%、両ブロック単独でも
// 有意。予算チャネル公平化込みの構成）で勝ち越し。レイテンシは 1手 p50 13ms / max ~3.7s（aiWorker 経由
// off-main-thread で UI 非ブロック。Worker 不可時の同期フォールバックでは最悪 ~4 秒ブロックしうる点に留意）。
// 旧既定 tempoChainAI（Gen-15）は存置。戻す場合はこの wrapper を `export { decideAction } from './tempoChainAI';`
// に変更するだけ（さらに旧 tempoFastAI(LA=1) も存置）。
import type { Action, GameState } from '../game/types';
import { decideAction as decideGrm, type GrmOptions } from './grmAI';

/** 配信構成（事前登録テストで測定した構成と同一。H は後方互換の受理のみで未使用）。 */
const GRM_BROWSER_OPTIONS: GrmOptions = { V: 20, P: 0.5, H: 1, K: 6, timeBudgetMs: 3000 };

export function decideAction(state: GameState, playerId: number, seed?: number): Action | null {
  return decideGrm(state, playerId, seed, GRM_BROWSER_OPTIONS);
}

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
