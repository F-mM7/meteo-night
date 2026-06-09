/**
 * cascade.ts ― 「このターンに発火できる最大連鎖（コンボ数）」を実エンジンのカスケードで評価する。
 *
 * 人間戦略「5色5連鎖を最速で組む」AI の核。自分の手番の決定フェーズ（2枚配置／連鎖の合間の
 * 強制アクション=取り除き・引いて配置）をすべて探索し、1ターンで到達できる
 * combosThisTurn.length の最大値を返す。点数でなく「連鎖数」を測る点が tempo 系と異なる。
 *
 * 段違い(staggered)構造——各段で同色が3スロットの最上段に来ればよく、その3スロットも深さも
 * 段ごとにズレてよい——は静的な「揃った列」指標では測れない。本評価器は実カスケードを回すので
 * 段違いを正しく評価する（_goal-5chain.ts で検証済みの構造を発見できる）。
 */
import type { Action, GameState } from '../game/types';
import { stepGame } from '../game/reducer';
import { legalActionIds, actionIdToAction } from './actionSpace';
import { observationKey } from './infoSet';

/** 自分の手番で「連鎖を作る/伸ばす」決定を行うフェーズ。これ以外に出たら連鎖は確定。 */
const DECISION_PHASES: ReadonlySet<string> = new Set([
  'awaitingPlaceDrawn',
  'awaitingAdditionalActionChoice',
  'awaitingAdditionalDiscard',
  'awaitingPlaceAdditionalDraw',
]);

export interface MaxChainResult {
  /** このターンに到達できた最大の連鎖数（combosThisTurn.length）。 */
  chain: number;
  /** その連鎖の各コンボサイズ。 */
  sizes: number[];
  /** 探索したノード数（コスト把握用）。 */
  nodes: number;
}

export interface MaxChainOptions {
  /** 探索ノード上限（安全弁）。超えたら打ち切って現状の最良を返す。 */
  nodeLimit?: number;
}

/**
 * state（me の手番の配置/連鎖フェーズ）から、このターンに発火できる最大連鎖を返す。
 * placement の順序や強制アクション（取り除き先・引いて配置先）を全探索した最良値。
 */
export function maxChainFrom(state: GameState, me: number, opts: MaxChainOptions = {}): MaxChainResult {
  const nodeLimit = opts.nodeLimit ?? 100000;
  let nodes = 0;
  let best: { chain: number; sizes: number[] } = {
    chain: state.turn.combosThisTurn.length,
    sizes: state.turn.combosThisTurn.map((x) => x.cards.length),
  };
  // 同一探索内では observationKey が局面（残り山札を含む。引いた札は盤面に乗るため一意）を定め、
  // そこから届く最大連鎖は確定するので memo 可能（配置順の transposition を相殺して高速化）。
  const memo = new Map<string, number>();

  const snapshot = (s: GameState): void => {
    const c = s.turn.combosThisTurn;
    if (c.length > best.chain) best = { chain: c.length, sizes: c.map((x) => x.cards.length) };
  };

  function rec(s: GameState): number {
    if (s.currentPlayerIndex !== me || !DECISION_PHASES.has(s.phase)) {
      snapshot(s);
      return s.turn.combosThisTurn.length;
    }
    nodes++;
    if (nodes > nodeLimit) {
      snapshot(s);
      return s.turn.combosThisTurn.length;
    }
    snapshot(s);
    const key = observationKey(s, me);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let localBest = s.turn.combosThisTurn.length;
    for (const id of legalActionIds(s, me)) {
      const a = actionIdToAction(s, me, id);
      if (!a) continue;
      const next = stepGame(s, a);
      if (next === s) continue;
      const r = rec(next);
      if (r > localBest) localBest = r;
    }
    memo.set(key, localBest);
    return localBest;
  }

  rec(state);
  return { chain: best.chain, sizes: best.sizes, nodes };
}

/**
 * 現局面で取れる手のうち、このターンの最大連鎖を最も伸ばす「第一手」を返す。
 * 点火（5連鎖の実行）や連鎖中の強制アクション選択に使う。chain は実行後に届く最大連鎖。
 */
export function bestChainMove(
  state: GameState,
  me: number,
  opts: MaxChainOptions = {}
): { chain: number; action: Action | null } {
  let best: { chain: number; action: Action | null } = {
    chain: state.turn.combosThisTurn.length,
    action: null,
  };
  for (const id of legalActionIds(state, me)) {
    const a = actionIdToAction(state, me, id);
    if (!a) continue;
    const next = stepGame(state, a);
    if (next === state) continue;
    const r = maxChainFrom(next, me, opts);
    const chain = Math.max(r.chain, next.turn.combosThisTurn.length);
    if (chain > best.chain) best = { chain, action: a };
  }
  return best;
}
