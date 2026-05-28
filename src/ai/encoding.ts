import type { Color, GameState, Phase, Player, PlayerBoard } from '../game/types';
import { COLORS } from '../game/types';

const NUM_COLORS = COLORS.length;
const SLOTS_PER_BOARD = 5;
const NUM_PLAYERS = 4;

const PHASES: Phase[] = [
  'awaitingDraw',
  'awaitingPlaceDrawn',
  'resolvingCombos',
  'awaitingAdditionalActionChoice',
  'awaitingPlaceAdditionalDraw',
  'awaitingAdditionalDiscard',
  'awaitingGiftSelection',
  'awaitingGiftPlacement',
  // reserved: reducer は現状この phase に遷移しないが、ENCODING_SIZE を 185 に保つため残置。
  // 削除すると 184 になり、既存学習済みモデル（Node 学習側・ブラウザ推論 `neuralAI.ts` の
  // `tf.loadLayersModel` 双方）が load 不能になる。撤去はモデル再学習とセットで行う。
  'turnEnd',
  'gameOver',
];

const COLOR_INDEX: Map<Color, number> = new Map(COLORS.map((c, i) => [c, i]));

// 1 ボード当たりの特徴量: スロット数 × (color one-hot + 高さ正規化 + 同色連続数正規化)
const BOARD_FEATURES = SLOTS_PER_BOARD * (NUM_COLORS + 2);
// プレイヤー特徴量: ボード + 自スコア正規化
const PLAYER_FEATURES = BOARD_FEATURES + 1;
// 場: 2 ペア × (存在フラグ + 2枚 × color one-hot)
const FIELD_FEATURES = 2 * (1 + 2 * NUM_COLORS);
// 全体: 山札残数 + 捨札color別カウント + ターン番号 + 終了フラグ + ゲーム終了フラグ
const GLOBAL_FEATURES = 1 + NUM_COLORS + 1 + 1 + 1;
const PHASE_FEATURES = PHASES.length;

export const ENCODING_SIZE =
  PLAYER_FEATURES * NUM_PLAYERS + FIELD_FEATURES + GLOBAL_FEATURES + PHASE_FEATURES;

const SCORE_NORM = 30;
const TURN_NORM = 100;
const DECK_NORM = 100;
const HEIGHT_NORM = 5;
const DISCARD_NORM = 20;

function encodeBoard(board: PlayerBoard): number[] {
  const out: number[] = [];
  for (let s = 0; s < SLOTS_PER_BOARD; s++) {
    const slot = board.slots[s];
    const colorOneHot = new Array<number>(NUM_COLORS).fill(0);
    let height = 0;
    let run = 0;
    if (slot && slot.stack.length > 0) {
      const top = slot.stack[slot.stack.length - 1];
      const idx = COLOR_INDEX.get(top.color);
      if (idx !== undefined) colorOneHot[idx] = 1;
      height = slot.stack.length;
      run = 1;
      for (let i = slot.stack.length - 2; i >= 0; i--) {
        if (slot.stack[i].color === top.color) run++;
        else break;
      }
    }
    out.push(...colorOneHot, height / HEIGHT_NORM, run / HEIGHT_NORM);
  }
  return out;
}

function encodePlayer(player: Player): number[] {
  return [...encodeBoard(player.board), player.score / SCORE_NORM];
}

function encodeField(field: GameState['field']): number[] {
  const out: number[] = [];
  for (const pair of field) {
    if (pair) {
      out.push(1);
      for (const card of pair) {
        const oneHot = new Array<number>(NUM_COLORS).fill(0);
        const idx = COLOR_INDEX.get(card.color);
        if (idx !== undefined) oneHot[idx] = 1;
        out.push(...oneHot);
      }
    } else {
      out.push(0);
      for (let i = 0; i < 2 * NUM_COLORS; i++) out.push(0);
    }
  }
  return out;
}

function encodeGlobal(state: GameState): number[] {
  const discardCounts = new Array<number>(NUM_COLORS).fill(0);
  for (const c of state.discardPile) {
    const idx = COLOR_INDEX.get(c.color);
    if (idx !== undefined) discardCounts[idx]++;
  }
  return [
    state.deck.length / DECK_NORM,
    ...discardCounts.map((n) => n / DISCARD_NORM),
    state.turnNumber / TURN_NORM,
    state.endTriggered ? 1 : 0,
    state.phase === 'gameOver' ? 1 : 0,
  ];
}

function encodePhase(phase: Phase): number[] {
  const out = new Array<number>(PHASES.length).fill(0);
  const idx = PHASES.indexOf(phase);
  if (idx >= 0) out[idx] = 1;
  return out;
}

/**
 * 手番プレイヤー視点で固定長ベクトル化する。
 * 相手プレイヤーは「自分の次の手番から相対的に時計回り」で並べることで対称化する。
 */
export function encodeState(state: GameState, viewerId: number): number[] {
  const viewer = state.players[viewerId];
  if (!viewer) throw new Error(`viewerId ${viewerId} out of range`);

  const out: number[] = [];
  out.push(...encodePlayer(viewer));
  for (let i = 1; i < state.players.length; i++) {
    const oppId = (viewerId + i) % state.players.length;
    out.push(...encodePlayer(state.players[oppId]));
  }
  out.push(...encodeField(state.field));
  out.push(...encodeGlobal(state));
  out.push(...encodePhase(state.phase));
  return out;
}
