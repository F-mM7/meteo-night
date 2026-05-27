/**
 * Gen-3-K3: ブラウザ向けニューラルネット推論ラッパー（雛形）。
 *
 * 注意（重要）:
 *   現状このファイルは **import のみ未確定の状態** で雛形のみ。
 *   `@tensorflow/tfjs` をブラウザバンドルに含めると数百 KB〜1 MB の追加になるため、
 *   実用的な学習済みモデルが得られて「反映する価値あり」と確認されてから
 *   tfjs を実 import に切り替える。
 *
 * 想定設計（将来の実装）:
 *   1. `import * as tf from '@tensorflow/tfjs';` で tfjs を読み込み
 *   2. `tf.loadLayersModel('/meteo-night/models/<gen>/model.json')` でモデルをロード
 *   3. `decideAction(state, playerId, seed?, options?)` で neuralMcts と同じインターフェース
 *   4. PUCT 風選択 + NN 推論で行動決定
 *
 * 学習側との整合:
 *   - `ai/scripts/nn/neuralMcts.ts` と同じアルゴリズム（PUCT、leaf 評価）
 *   - 同じ tfjs 標準モデル形式（`model.json` + `weights.bin`）
 *   - 同じ前処理（`encoding.ts` の `encodeState`）と行動空間（`actionSpace.ts`）
 *
 * 反映手順（実用モデル完成後）:
 *   1. このファイルを実装で埋める（tfjs import、 PUCT、 推論ループ）
 *   2. 学習済みモデルを `public/models/<gen>/` に配置
 *   3. `src/ai/index.ts` の `decideAction` を `mctsAI` から `neuralAI` に差し替え
 *   4. `npm run build` でバンドルサイズと動作確認
 */

import type { Action, GameState } from '../game/types';

/** 推論モデルへの参照（実装時に tf.LayersModel に置き換え） */
export interface NeuralModelRef {
  /** model.json への URL (例: '/meteo-night/models/az-v2/model.json') */
  url: string;
  /** ロード後の tf.LayersModel をここに保持予定 */
  loaded?: unknown;
}

export interface NeuralAiOptions {
  iterations?: number;
  puctC?: number;
  treeMaxDepth?: number;
}

/**
 * 雛形: 学習済みモデルが揃ったらここに `decideActionNeural` 相当の実装を入れる。
 * 現状は呼ぶと null を返す（ブラウザ動作は引き続き mctsAI を使う想定）。
 */
export function decideAction(
  state: GameState,
  playerId: number,
  _seed?: number,
  _options: NeuralAiOptions = {}
): Action | null {
  void state;
  void playerId;
  // 未実装。実装時は ai/scripts/nn/neuralMcts.ts の decideActionNeural を移植。
  return null;
}

/** 雛形: 実装時には tf.loadLayersModel を呼ぶ */
export async function loadModel(url: string): Promise<NeuralModelRef> {
  return { url };
}
