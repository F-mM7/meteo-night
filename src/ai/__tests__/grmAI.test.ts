import { describe, it, expect } from 'vitest';
import { setupGame } from '../../game/setup';
import { stepGame } from '../../game/reducer';
import { decideAction as decideGrm, pairWeights, type GrmOptions } from '../grmAI';
import { normalizeCounts } from '../grmReachQ';
import type { Card, Color, GameState, PlayerBoard } from '../../game/types';
import { COLORS } from '../../game/types';

function actorOf(state: GameState): number {
  if (state.phase === 'awaitingGiftPlacement' && state.turn.pendingGiftBatches.length > 0) {
    return state.turn.pendingGiftBatches[0].recipientId;
  }
  return state.currentPlayerIndex;
}

/**
 * 全席を GRM にして 1 ゲーム進める（相手由来の停止を排除し、GRM が全フェーズで停滞しないことだけを見る）。
 * K を小さくして q を浅くし高速化（強さでなく堅牢性の確認が目的）。GRM が手番で null や no-op
 * （reducer に拒否される非合法手）を返したら stuck を加算。返り値は {steps, stuck}。
 */
function runAllGrm(seed: number, maxSteps: number): { steps: number; stuck: number } {
  // timeBudgetMs: 本テストの目的は停滞バグの検出であり強さではない。v1（全色レース）＋v2（ゲート拡大）で
  // 無予算の 1 手が重くなったため、実運用と同じ予算機構で有界化して回す（劣化経路も含めて合法手を返すこと
  // 自体が検証対象になる）。
  const opts: GrmOptions = { V: 20, P: 0.5, K: 3, timeBudgetMs: 1000 };
  let state = setupGame({ seed, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
  let steps = 0;
  let stuck = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = actorOf(state);
    const action = decideGrm(state, actor, undefined, opts);
    if (!action) {
      stuck++;
      break;
    }
    const before = state;
    state = stepGame(state, action);
    if (state === before) {
      stuck++; // reducer に拒否された＝非合法手
      break;
    }
    steps++;
  }
  return { steps, stuck };
}

describe('grmAI 堅牢性: 全フェーズで合法手を返し停滞しない', () => {
  // 全席 GRM でフレッシュ局面から数手進め、GRM が手番で null や no-op（非合法手）を一切出さないことを確認。
  // 1 手の思考が重いので手数は少なめに制限（強さでなく停滞バグが無いことの確認が目的）。
  it('GRM が連続して合法手を返し手番が進む', { timeout: 90_000 }, () => {
    for (const seed of [1, 2]) {
      const r = runAllGrm(seed, 8);
      expect(r.stuck, `seed=${seed} で GRM が停滞（非合法手/null）`).toBe(0);
      expect(r.steps, `seed=${seed} で進行していない`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('grmAI 配置の順序完全性: 取得2枚をどちらから置くか（同一スロット積みの上下順）も考慮する', () => {
  it('4スロット赤+空き1で[赤,緑]取得 → 緑を空きへ置いてから赤を重ね5スロット赤top(size5=G)を作る', () => {
    // 赤先だと空きに赤を置いても、緑がどこかの赤topを潰して5枚揃わない。緑→赤の逆順を選べて初めて
    // [緑,赤]（赤が上）で5スロット赤top → size5=10点 → G(V=10,P=1)。実着手で緑カードを先に置けるか。
    const R: Color = 'red';
    const G: Color = 'green';
    const base = setupGame({ seed: 5, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
    let uid = 0;
    const mk = (c: Color): Card => ({ id: `b${uid++}-${c}`, color: c });
    const board: PlayerBoard = { slots: [[R], [R], [R], [R], []].map((st) => ({ stack: st.map(mk) })) };
    const empty = (): PlayerBoard => ({ slots: [0, 1, 2, 3, 4].map(() => ({ stack: [] as Card[] })) });
    const redCard: Card = { id: 'pend-red', color: R };
    const greenCard: Card = { id: 'pend-green', color: G };
    const state: GameState = {
      ...base,
      currentPlayerIndex: 0,
      startPlayerIndex: 0,
      players: base.players.map((p, i) => (i === 0 ? { ...p, board, score: 0 } : { ...p, board: empty(), score: 0 })),
      deck: [],
      discardPile: [],
      field: [null, null],
      phase: 'awaitingPlaceDrawn',
      turn: { ...base.turn, pendingDraw: [redCard, greenCard], hasDrawn: true },
    };
    const action = decideGrm(state, 0, undefined, { V: 10, P: 1, K: 6 });
    expect(action?.type).toBe('PLACE_DRAWN');
    if (action && action.type === 'PLACE_DRAWN') {
      // 緑カードを先に空きスロット(#4)へ置く＝逆順を選べている。赤先なら 5 枚揃わず別の手になる。
      expect(action.cardId, '同一スロット逆順（緑→赤）を考慮できていない').toBe('pend-green');
      expect(action.slotIndex).toBe(4);
    }
  });
});

describe('grmAI 贈与受領の同時最適化: バッチ複数枚の置き順・相互作用を考慮する', () => {
  it('4スロット赤+空き1で[赤,緑]受領 → 緑を空き#4へ先置きし赤を重ねて5スロット赤topの仕込みを作る', () => {
    // 旧・逐次貪欲（cards[0]=赤を単独最適配置）では緑との相互作用を見ない。同時最適化は
    // 緑→空き#4・赤を重ねる順で 5 スロット赤 top（次の自手番に確定 size5 発火＝q(V=10)=1 の G 仕込み）を選べる。
    const R: Color = 'red';
    const G: Color = 'green';
    const base = setupGame({ seed: 9, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
    let uid = 0;
    const mk = (c: Color): Card => ({ id: `gb${uid++}-${c}`, color: c });
    const board: PlayerBoard = { slots: [[R], [R], [R], [R], []].map((st) => ({ stack: st.map(mk) })) };
    const empty = (): PlayerBoard => ({ slots: [0, 1, 2, 3, 4].map(() => ({ stack: [] as Card[] })) });
    const giftRed: Card = { id: 'gift-red', color: R };
    const giftGreen: Card = { id: 'gift-green', color: G };
    const state: GameState = {
      ...base,
      currentPlayerIndex: 1, // 贈り主の手番中（受領者は操作主体だが手番プレイヤーではない）
      players: base.players.map((p, i) => (i === 0 ? { ...p, board, score: 0 } : { ...p, board: empty(), score: 0 })),
      deck: [],
      discardPile: [],
      field: [null, null],
      phase: 'awaitingGiftPlacement',
      turn: { ...base.turn, pendingGiftBatches: [{ recipientId: 0, cards: [giftRed, giftGreen] }] },
    };
    const action = decideGrm(state, 0, undefined, { V: 10, P: 1, K: 6 });
    expect(action?.type).toBe('PLACE_GIFT');
    if (action && action.type === 'PLACE_GIFT') {
      expect(action.cardId, 'バッチ同時最適化（緑を先に置いて赤を重ねる）を考慮できていない').toBe('gift-green');
      expect(action.slotIndex).toBe(4);
    }
  });
});

describe('grmAI 終盤モード: 巨大な必要追加得点でも V を計算可能圏にクランプして完走する', () => {
  // フォールバック撤去で顕在化したバグの回帰テスト: 終盤モード（他者が引き金・自分が大差ビハインド）は
  // V=必要追加得点・P 無効化＝厳密 q を解くため、V が巨大（実測 V=46 でノード上限 200 万超過）だと
  // 連鎖サブゲームの展開が止まらず例外で落ちていた（撤去前は「最初の合法手」フォールバックが黙って吸収）。
  // 修正＝effectiveTarget が V を設定値（ここでは 20）でクランプする。
  it('need=50 の絶望局面の配置決定が例外なく合法手を返す', { timeout: 60_000 }, () => {
    const R: Color = 'red';
    const G: Color = 'green';
    const base = setupGame({ seed: 7, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
    let uid = 0;
    const mk = (c: Color): Card => ({ id: `e${uid++}-${c}`, color: c });
    // 赤 top 2 スロット → 引いた赤 2 枚の配置で発火候補（同色 top 3 以上）が多数できる ＝ 厳密 q が走る。
    const board: PlayerBoard = { slots: [[R], [R], [G], [], []].map((st) => ({ stack: st.map(mk) })) };
    const empty = (): PlayerBoard => ({ slots: [0, 1, 2, 3, 4].map(() => ({ stack: [] as Card[] })) });
    const deck: Card[] = COLORS.flatMap((c) => Array.from({ length: 20 }, () => mk(c))); // 豊富な山札＝サブゲームが深い
    const state: GameState = {
      ...base,
      currentPlayerIndex: 0,
      startPlayerIndex: 0,
      endTriggered: true,
      endTriggerPlayerId: 1,
      players: base.players.map((p, i) =>
        i === 0 ? { ...p, board, score: 0 } : { ...p, board: empty(), score: i === 1 ? 50 : 0 }
      ),
      deck,
      discardPile: [],
      field: [null, null],
      phase: 'awaitingPlaceDrawn',
      turn: { ...base.turn, pendingDraw: [mk(R), mk(R)], hasDrawn: true },
    };
    const action = decideGrm(state, 0, undefined, { V: 20, P: 0.5, K: 6, timeBudgetMs: 3000 });
    expect(action?.type).toBe('PLACE_DRAWN');
  });
});

describe('grmAI 山札チャネルの 15 パターン期待値化（SPEED-PLAN 5b・オプション deck15）', () => {
  it('pairWeights: 重みは 2 枚非復元抽出の確率分布（Σ=1・一様なら 15 組）', () => {
    const uniform = normalizeCounts({ red: 24, green: 24, purple: 24, yellow: 24, blue: 24 });
    const ws = pairWeights(uniform, normalizeCounts({}));
    expect(ws.length).toBe(15); // 同色 5 + 異色 C(5,2)=10
    const sum = ws.reduce((s, x) => s + x.w, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
    // 一様なら異色組の重み（2·24·24/(120·119)）は同色組（24·23/(120·119)）より大きい
    const same = ws.find((x) => x.colors[0] === x.colors[1])!;
    const diff = ws.find((x) => x.colors[0] !== x.colors[1])!;
    expect(diff.w).toBeGreaterThan(same.w);
  });

  it('pairWeights: 境界（単色のみ→同色組のみ w=1、異色 1+1 枚→その異色組のみ w=1、1 枚以下→空）', () => {
    const onlyRed = pairWeights(normalizeCounts({ red: 5 }), normalizeCounts({}));
    expect(onlyRed.length).toBe(1);
    expect(onlyRed[0].colors).toEqual(['red', 'red']);
    expect(Math.abs(onlyRed[0].w - 1)).toBeLessThan(1e-12);
    const rg = pairWeights(normalizeCounts({ red: 1 }), normalizeCounts({ green: 1 }));
    expect(rg.length).toBe(1);
    expect(Math.abs(rg[0].w - 1)).toBeLessThan(1e-12);
    expect(pairWeights(normalizeCounts({ red: 1 }), normalizeCounts({}))).toEqual([]);
  });

  it('deck15 有効でドロー局面が合法手を返す（スモーク。既定 off の経路は他テストが担保）', () => {
    const state = setupGame({ seed: 21, playerNames: ['P0', 'P1', 'P2', 'P3'], cpuFlags: [true, true, true, true] });
    expect(state.phase).toBe('awaitingDraw');
    const action = decideGrm(state, state.currentPlayerIndex, undefined, {
      V: 20,
      P: 0.5,
      K: 3,
      timeBudgetMs: 1000,
      deck15: true,
    });
    expect(action).not.toBeNull();
    expect(['DRAW_FROM_FIELD', 'DRAW_FROM_DECK']).toContain(action!.type);
  });
});
