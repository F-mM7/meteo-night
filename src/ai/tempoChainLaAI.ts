/**
 * tempoChainLaAI ― tempoChain（Gen-15 champion）に 1 ターン先読み（race-timing）を付与した実験候補。
 *
 * 【Gen-16 判定: 不採用（parity〜微益）】vs champion fresh 2seed×5000局で 26.06%(CI 24.86-27.29)/
 * 25.64%(CI 24.45-26.87)＝事前登録基準「両 seed CI下限>25%」未達。プール 25.9%(n=10000) で効果は
 * +1pt 弱に縮小（screening 29.5% は winner's curse）。詳細は ai/CHANGELOG.md の Gen-16。
 *
 * 仮説（CHANGELOG Gen-15「今後の伸びしろ」/ evolve スキル候補 0）:
 *   旧 champion tempoFast の優位の核は LA=1（相手手番を挟み自分の次手番まで読む race-timing）。
 *   現 champion tempoChain は 1 ターン内しか読まない。「5連鎖を狙う構成戦略(blend=0.5)」と
 *   「race-timing」の合成は、それぞれ単独で champion に勝てた 2 つのレバーの未検証の組み合わせ。
 *
 * 変更点は awaitingPlaceDrawn の「点火条件未満」の分岐のみ:
 *   - base: 即時 blend スコア（blend*tempo − (1-blend)*W*距離）で配置を貪欲選択。
 *   - 本 AI: 非発火配置候補（即時 blend スコア上位 K）それぞれを
 *       候補を打つ → 自ターンを base 方針で完走 → 相手を smart モデルで前進（tempoFast と同じ規約）
 *       → 自分の次手番開始時点を同じ目的関数で評価（raceValue）
 *     の 1 ターン先読みで仲裁する。
 *   - 点火条件（bestChainMove >= fireTarget で即発火）は Gen-15 の勝ち筋なので変更しない。
 *   - laSubFireMin で「fireTarget 未満の即時発火」も候補に足せるが、screening（n=400, vs champion）で
 *     subFireMin=1 は 15.0%（有意に弱い）vs 無効時 29.5%（有意に強い）＝**小発火候補は規律を侵食するため
 *     既定で無効**。5連鎖の利得は 1 ターン先読みの地平の外にあり、raceValue は即時小得点を過大評価する。
 *
 * 情報モデルは既存実装の規約に従う: 連鎖中の追加ドローは cascade.ts 同様に実山札順を参照、
 * 相手前進は tempoFast の advanceToMyTurn と同じく実状態を smart で進める（seeded）。
 * 候補間は同一 seed（common random numbers）で比較する。
 *
 * 注意: tempoChainAI.ts / tempoFastAI.ts / evaluator.ts / index.ts は一切変更しない（本ファイルは追加のみ）。
 */
import type { Action, Color, GameState, PlayerBoard } from '../game/types';
import { COLORS } from '../game/types';
import { stepGame } from '../game/reducer';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { decideAction as decideSmart } from './smartAI';
import { evaluateState } from './evaluator';
import { bestChainMove } from './cascade';
import {
  DEFAULT_GENOME,
  decideAction as decideTempoChainBase,
  type TempoChainGenome,
  type DistanceMode,
} from './tempoChainAI';

export interface TempoChainLaOptions {
  /** 先読みで比較する非発火配置候補の上限（即時 blend スコア上位 K）。 */
  laCandidates?: number;
  /** 「いま撃てる最大連鎖」を発火候補に含める最小連鎖数（大きくすると発火候補を無効化）。 */
  laSubFireMin?: number;
  /** 先読み全体の壁時計予算（ms）。超過したら best-so-far を返す（候補は blend 降順に評価）。 */
  laTimeBudgetMs?: number;
  /** 相手前進（smart, seeded）のサンプル数。raceValue をサンプル平均し候補順位のノイズを下げる。 */
  laAdvanceSamples?: number;
}

export type TempoChainLaParams = Partial<TempoChainGenome> & TempoChainLaOptions;

const DEFAULT_LA_CANDIDATES = 6;
// screening で subFireMin=1 は有意に弱化（15.0% vs 無効 29.5%, n=400）＝既定で発火候補なし。
const DEFAULT_LA_SUB_FIRE_MIN = Infinity;
const DEFAULT_LA_TIME_BUDGET_MS = 1000;
const DEFAULT_LA_ADVANCE_SAMPLES = 1;
/** 先読みロールアウト（自ターン完走＋相手前進）の安全弁。tempoFast の ADVANCE_MAX_STEPS と同水準。 */
const ROLLOUT_MAX_STEPS = 400;
/** tempoChainAI.buildPlacement と同一の距離重み。 */
const DIST_W = 50;

// --- tempoChainAI の private ヘルパの複製（実験中は本体を編集しないため。値・式は同一） ---

function distinctSlots(board: PlayerBoard, color: Color): number {
  let n = 0;
  for (const slot of board.slots) if (slot.stack.some((c) => c.color === color)) n++;
  return n;
}

function distanceToGoal(board: PlayerBoard, mode: DistanceMode): number {
  let total = 0;
  let worst = 0;
  for (const color of COLORS) {
    const deficit = Math.max(0, 3 - Math.min(3, distinctSlots(board, color)));
    total += deficit;
    if (deficit > worst) worst = deficit;
  }
  return mode === 'worstcase' ? worst * 4 + total * 0.1 : total;
}

function boardCards(board: PlayerBoard): number {
  let n = 0;
  for (const slot of board.slots) n += slot.stack.length;
  return n;
}

function firstLegal(state: GameState, me: number): Action | null {
  for (const id of legalActionIds(state, me)) {
    const a = actionIdToAction(state, me, id);
    if (a) return a;
  }
  return null;
}

function effectiveFireTarget(state: GameState, me: number, g: TempoChainGenome): number {
  let ft = g.fireTarget;
  if (g.lateThreshold !== Infinity) {
    let maxScore = 0;
    for (const p of state.players) if (p.score > maxScore) maxScore = p.score;
    if (maxScore >= g.lateThreshold) ft = Math.min(ft, g.fireTargetLate);
  }
  if (g.fullThreshold !== Infinity && boardCards(state.players[me].board) >= g.fullThreshold) ft = 1;
  return ft;
}

// --- tempoFastAI と同じ seed 規約（state から決定的に導出。再現性のため） ---

function stateBaseSeed(state: GameState, playerId: number): number {
  const a = state.rngSeed >>> 0;
  const b = Math.imul(state.turnNumber + 1, 0x9e3779b1);
  const c = Math.imul(playerId + 1, 0x85ebca6b);
  const d = Math.imul(state.log.length + 1, 0xc2b2ae35);
  return (a ^ b ^ c ^ d) | 0;
}

function currentActorId(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

// --- 先読み本体 ---

interface ScoredPlacement {
  action: Action;
  blendScore: number;
}

/**
 * 非発火配置の列挙＋即時 blend スコア（tempoChainAI.buildPlacement と同一の式）。
 * fireFallback は「全配置が発火してしまう」ときの保険（base と同じ＝発火数最大の配置）。
 */
function enumerateBuildPlacements(
  state: GameState,
  me: number,
  g: TempoChainGenome
): { placements: ScoredPlacement[]; fireFallback: Action | null } {
  const pending = state.turn.pendingDraw;
  const nSlots = state.players[me].board.slots.length;
  const placements: ScoredPlacement[] = [];
  let fireFallback: { action: Action; chain: number } | null = null;

  for (const card of pending) {
    for (let s = 0; s < nSlots; s++) {
      const action: Action = { type: 'PLACE_DRAWN', cardId: card.id, slotIndex: s };
      const next = stepGame(state, action);
      if (next === state) continue;
      if (next.turn.combosThisTurn.length >= 1) {
        const fired = next.turn.combosThisTurn.length;
        if (!fireFallback || fired > fireFallback.chain) fireFallback = { action, chain: fired };
        continue;
      }
      const board = next.players[me].board;
      const tempo = g.buildTempoBlend > 0 ? evaluateState(next, me) : 0;
      const dist = distanceToGoal(board, g.distanceMode);
      placements.push({
        action,
        blendScore: g.buildTempoBlend * tempo - (1 - g.buildTempoBlend) * DIST_W * dist,
      });
    }
  }
  return { placements, fireFallback: fireFallback?.action ?? null };
}

/**
 * race-timing 込みの局面価値: 自分の次手番開始時点（相手 3 人が動いた後）を、
 * base の配置目的関数と同じ形（blend*tempo − (1-blend)*W*距離）で評価する。
 * evaluateState は自他スコア・脅威・勝敗ボーナスを含むため「レースの立ち位置」が反映される。
 */
function raceValue(state: GameState, me: number, g: TempoChainGenome): number {
  const tempo = g.buildTempoBlend > 0 ? evaluateState(state, me) : 0;
  const dist = distanceToGoal(state.players[me].board, g.distanceMode);
  return g.buildTempoBlend * tempo - (1 - g.buildTempoBlend) * DIST_W * dist;
}

/**
 * 候補手を打った後を 1 ターン先読みする:
 *   自分の残りターンは base tempoChain 方針（発火条件・連鎖中の bestChainMove・gift は smart）で完走し、
 *   相手手番（と自分への gift 配置）は smart で前進、自分の次手番（awaitingDraw）か終局で評価する。
 * 候補間は同一 seed で比較する（common random numbers）。
 */
function lookaheadValue(
  root: GameState,
  action: Action,
  me: number,
  g: TempoChainGenome,
  seed: number
): number {
  let s = stepGame(root, action);
  if (s === root) return -Infinity;

  for (let i = 0; i < ROLLOUT_MAX_STEPS && s.phase !== 'gameOver'; i++) {
    if (s.currentPlayerIndex === me && s.phase === 'awaitingDraw') break;
    const actor = currentActorId(s);
    const stepSeed = (seed + Math.imul(i + 1, 0x9e3779b1)) | 0;
    const a =
      actor === me
        ? decideTempoChainBase(s, me, stepSeed, g)
        : decideSmart(s, actor, stepSeed);
    if (!a) break;
    const next = stepGame(s, a);
    if (next === s) break;
    s = next;
  }
  return raceValue(s, me, g);
}

/** 点火条件未満のときの配置/発火の先読み仲裁。 */
function laBuildDecision(
  state: GameState,
  me: number,
  g: TempoChainGenome,
  laCandidates: number,
  laSubFireMin: number,
  laTimeBudgetMs: number,
  laAdvanceSamples: number,
  bm: { chain: number; action: Action | null },
  seed: number
): Action | null {
  const { placements, fireFallback } = enumerateBuildPlacements(state, me, g);
  const subFire = bm.chain >= laSubFireMin && bm.action ? bm.action : null;

  if (placements.length === 0) {
    // base と同じ保険経路（全配置が発火する局面では発火数最大の手）。
    return subFire ?? fireFallback ?? firstLegal(state, me);
  }

  placements.sort((a, b) => b.blendScore - a.blendScore);
  const candidates: Action[] = placements.slice(0, laCandidates).map((p) => p.action);
  if (subFire) candidates.push(subFire);
  if (candidates.length === 1) return candidates[0];

  const deadline = Date.now() + laTimeBudgetMs;
  let bestAction = candidates[0]; // blend 最良＝base の選択。予算切れ時はここへ退行する。
  let bestValue = -Infinity;
  for (const a of candidates) {
    // 相手前進サンプルの seed 列は候補間で共通（common random numbers）。
    let sum = 0;
    for (let k = 0; k < laAdvanceSamples; k++) {
      sum += lookaheadValue(state, a, me, g, (seed + Math.imul(k, 0x85ebca6b)) | 0);
    }
    const v = sum / laAdvanceSamples;
    if (v > bestValue) {
      bestValue = v;
      bestAction = a;
    }
    if (Date.now() >= deadline) break;
  }
  return bestAction;
}

export function decideAction(
  state: GameState,
  playerId: number,
  seed?: number,
  params: TempoChainLaParams = {}
): Action | null {
  const {
    laCandidates = DEFAULT_LA_CANDIDATES,
    laSubFireMin = DEFAULT_LA_SUB_FIRE_MIN,
    laTimeBudgetMs = DEFAULT_LA_TIME_BUDGET_MS,
    laAdvanceSamples = DEFAULT_LA_ADVANCE_SAMPLES,
    ...genomePart
  } = params;
  const g: TempoChainGenome = { ...DEFAULT_GENOME, ...genomePart };

  if (state.phase === 'awaitingPlaceDrawn' && state.currentPlayerIndex === playerId) {
    const ft = effectiveFireTarget(state, playerId, g);
    const bm = bestChainMove(state, playerId, { nodeLimit: g.nodeLimit });
    if (bm.chain >= ft && bm.action) return bm.action; // Gen-15 の勝ち筋＝点火は即時（変更しない）
    const baseSeed = (seed ?? stateBaseSeed(state, playerId)) | 0;
    return laBuildDecision(
      state,
      playerId,
      g,
      laCandidates,
      laSubFireMin,
      laTimeBudgetMs,
      laAdvanceSamples,
      bm,
      baseSeed
    );
  }

  // それ以外のフェーズ（draw/連鎖中/gift/他人手番）は base tempoChain と完全に同一。
  return decideTempoChainBase(state, playerId, seed, g);
}
