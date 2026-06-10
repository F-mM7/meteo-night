import { describe, it, expect } from 'vitest';
import {
  reachF,
  reachFFromState,
  subgameInputFromState,
  reconstructDeckCounts,
  colorCounts,
  colorCountsFromColors,
  fireSlots,
  CARDS_PER_COLOR,
} from '../grmReachF';
import { reducer, stepGame } from '../../game/reducer';
import { setupGame } from '../../game/setup';
import { mulberry32 } from '../../game/rng';
import type { Card, Color, GameState, PlayerBoard } from '../../game/types';
import { COLORS } from '../../game/types';

// ---------------------------------------------------------------------------
// テスト用ヘルパ: 発火状態の GameState を組み立てる
// ---------------------------------------------------------------------------

let UID = 0;
function card(color: Color): Card {
  return { id: `c${UID++}-${color}`, color };
}

/**
 * 自手番(player 0)の連鎖開始局面（phase='resolvingCombos'）を構築する。
 * slots は下→上の色列。deckColors/discardColors はそれぞれ山札・捨札の色列。
 */
function buildFireState(
  slots: Color[][],
  deckColors: Color[],
  discardColors: Color[]
): GameState {
  UID = 0;
  const nSlots = slots.length;
  const myBoard: PlayerBoard = {
    slots: slots.map((stack) => ({ stack: stack.map((c) => card(c)) })),
  };
  const emptyBoard = (): PlayerBoard => ({
    slots: Array.from({ length: nSlots }, () => ({ stack: [] as Card[] })),
  });
  const base = setupGame({
    seed: 12345,
    playerNames: ['P0', 'P1'],
    cpuFlags: [false, true],
    slotsPerPlayer: nSlots,
    cardsPerColor: CARDS_PER_COLOR,
  });
  return {
    ...base,
    currentPlayerIndex: 0,
    startPlayerIndex: 0,
    players: base.players.map((p, i) =>
      i === 0
        ? { ...p, board: myBoard, score: 0 }
        : { ...p, board: emptyBoard(), score: 0 }
    ),
    deck: deckColors.map((c) => card(c)),
    discardPile: discardColors.map((c) => card(c)),
    field: [null, null],
    phase: 'resolvingCombos',
    turn: {
      pendingDraw: [],
      pendingAdditionalDraw: null,
      combosThisTurn: [],
      giftQueue: [],
      hasDrawn: true,
      pendingGiftBatches: [],
      discardedCardIds: [],
    },
  };
}

// ---------------------------------------------------------------------------
// 独立リファレンス・オラクル
//   実エンジン(reducer/stepGame)だけでサブゲームを後退帰納し、ドローの色のみを
//   超幾何（色別枚数 / 総数）で全列挙して P(ターン得点 ≥ V) の最大値を求める。
//   reachF の DP コードは一切使わない＝f の独立検証になる。
// ---------------------------------------------------------------------------

function countSig(cards: Card[]): string {
  const m = new Map<Color, number>();
  for (const c of cards) m.set(c.color, (m.get(c.color) ?? 0) + 1);
  return COLORS.map((c) => m.get(c) ?? 0).join(',');
}

function referenceF(state: GameState, V: number, me = 0): number {
  const baseScore = state.players[me].score;
  const memo = new Map<string, number>();

  function sig(s: GameState): string {
    const board = s.players[me].board.slots
      .map((sl) => sl.stack.map((c) => c.color[0]).join(''))
      .join('|');
    const pad = s.turn.pendingAdditionalDraw?.color ?? '-';
    return `${s.phase}#${board}#${countSig(s.deck)}#${countSig(s.discardPile)}#${pad}`;
  }

  function rec(s: GameState): number {
    if (s.phase === 'resolvingCombos') {
      return rec(reducer(s, { type: 'RESOLVE_COMBOS' }));
    }
    if (s.phase === 'awaitingGiftSelection' || s.phase === 'gameOver') {
      return s.players[me].score - baseScore >= V ? 1 : 0;
    }

    const key = sig(s);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let best = 0;
    if (s.phase === 'awaitingAdditionalActionChoice') {
      // 削除（取り除き）: 非空スロットそれぞれ
      s.players[me].board.slots.forEach((slot, j) => {
        if (slot.stack.length > 0) {
          best = Math.max(best, rec(stepGame(s, { type: 'DISCARD_TOP', slotIndex: j })));
        }
      });
      // ドロー: 色を全列挙
      best = Math.max(best, drawBranch(s));
    } else if (s.phase === 'awaitingPlaceAdditionalDraw') {
      for (let j = 0; j < s.players[me].board.slots.length; j++) {
        best = Math.max(best, rec(stepGame(s, { type: 'PLACE_ADDITIONAL_DRAW', slotIndex: j })));
      }
    } else {
      throw new Error(`referenceF: 想定外のフェーズ ${s.phase}`);
    }

    memo.set(key, best);
    return best;
  }

  function drawBranch(s: GameState): number {
    // 山札が残っていれば山札から、空なら捨札をリシャッフルしたプールから引く（§1.3）
    const usingDeck = s.deck.length > 0;
    const pool = usingDeck ? s.deck : s.discardPile;
    if (pool.length === 0) return 0; // ドロー不能
    const total = pool.length;
    const byColor = new Map<Color, number>();
    for (const c of pool) byColor.set(c.color, (byColor.get(c.color) ?? 0) + 1);

    let sum = 0;
    for (const [color, cnt] of byColor) {
      const p = cnt / total;
      // 次に引かれるカードを color に固定する（残りの順序は次のドローで再列挙するため不問）
      const idx = pool.findIndex((c) => c.color === color);
      const chosen = pool[idx];
      const rest = pool.filter((_, i) => i !== idx);
      const forced: GameState = usingDeck
        ? { ...s, deck: [chosen, ...rest] }
        : { ...s, deck: [chosen, ...rest], discardPile: [] }; // リシャッフルを再現
      const afterChoose = reducer(forced, { type: 'CHOOSE_ADDITIONAL_DRAW' });
      sum += p * rec(afterChoose);
    }
    return sum;
  }

  return rec(state);
}

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

const R: Color = 'red';
const G: Color = 'green';
const B: Color = 'blue';
const Y: Color = 'yellow';

// ===========================================================================

describe('fireSlots（発火判定）', () => {
  it('最上段に同色3枚で発火', () => {
    expect(fireSlots([[R], [R], [R], [], []])).toBe(true);
  });
  it('最上段同色が2枚以下なら非発火', () => {
    expect(fireSlots([[R], [R], [G], [], []])).toBe(false);
  });
  it('下層に同色があっても最上段でしか判定しない', () => {
    // 最上段は G,B,Y で全て異なる。下層に R が3枚あっても発火しない。
    expect(fireSlots([[R, G], [R, B], [R, Y], [], []])).toBe(false);
  });
});

describe('reachF 決定的ケース', () => {
  it('単発 size3 のみ: f(V=1)=1, f(V=2)=0', () => {
    const input = {
      slots: [[R], [R], [R], [], []],
      deck: colorCountsFromColors([]),
      discard: colorCountsFromColors([]),
    };
    expect(reachF(input, 1)).toBe(1);
    expect(reachF(input, 2)).toBe(0);
  });

  it('削除で2段目を露出させる連鎖: スペアBを捨てて G,G,G を回収し 3点', () => {
    // [[G,R],[G,R],[G,R],[B],[]] tops R,R,R → 発火。R除去後 tops G,G,G だが
    // 自動連鎖しない。スペアの B を削除して 1手入れると次の解決で G,G,G が成立。
    const input = {
      slots: [[G, R], [G, R], [G, R], [B], []],
      deck: colorCountsFromColors([]),
      discard: colorCountsFromColors([]),
    };
    expect(reachF(input, 1)).toBe(1);
    expect(reachF(input, 2)).toBe(1);
    expect(reachF(input, 3)).toBe(1); // 基礎(1+1)+本数ボーナス(2本→1) = 3
    expect(reachF(input, 4)).toBe(0);
  });

  it('Gを先に削ると2本目を逃す → f は最良手（Bを削る）を選ぶ', () => {
    // reachF は max_π なので、誤った削除(G)ではなく B 削除を選び 3 点に届く。
    const input = {
      slots: [[G, R], [G, R], [G, R], [B], []],
      deck: colorCountsFromColors([]),
      discard: colorCountsFromColors([]),
    };
    expect(reachF(input, 3)).toBe(1);
  });

  it('複数色同時発火（6スロット）: 1ステップで R3本+G3本=基礎2+ボーナス1=3点', () => {
    const input = {
      slots: [[R], [R], [R], [G], [G], [G]],
      deck: colorCountsFromColors([]),
      discard: colorCountsFromColors([]),
    };
    expect(reachF(input, 3)).toBe(1);
    expect(reachF(input, 4)).toBe(0);
  });

  it('非発火状態を渡すと例外', () => {
    expect(() =>
      reachF(
        { slots: [[R], [R], [G], [], []], deck: colorCountsFromColors([]), discard: colorCountsFromColors([]) },
        1
      )
    ).toThrow();
  });
});

describe('reachF 確率的ケース（手計算値）', () => {
  it('追加ドローでGを引けば2本目成立 (deck=1G+3B): f(V=2)=f(V=3)=1/4', () => {
    // [[R],[R],[R],[G],[G]] → R除去後 tops _,_,_,G,G。空きスロットへ G を置けば
    // G,G,G が成立して 3点。G を引く確率 = 1/4。それ以外(B)は 2本目に届かず 1点。
    const input = {
      slots: [[R], [R], [R], [G], [G]],
      deck: colorCountsFromColors([G, B, B, B]),
      discard: colorCountsFromColors([]),
    };
    expect(reachF(input, 1)).toBe(1);
    expectClose(reachF(input, 2), 0.25);
    expectClose(reachF(input, 3), 0.25);
    expect(reachF(input, 4)).toBe(0);
  });

  it('山札が空 → 捨札(1G+3B)をリシャッフルして引く: f(V=3)=1/4', () => {
    const input = {
      slots: [[R], [R], [R], [G], [G]],
      deck: colorCountsFromColors([]),
      discard: colorCountsFromColors([G, B, B, B]),
    };
    expect(reachF(input, 1)).toBe(1);
    expectClose(reachF(input, 3), 0.25);
    expect(reachF(input, 4)).toBe(0);
  });
});

describe('reachF はエンジンの厳密展開（独立オラクル）と一致する', () => {
  const scenarios: { name: string; slots: Color[][]; deck: Color[]; discard: Color[] }[] = [
    { name: '削除露出', slots: [[G, R], [G, R], [G, R], [B], []], deck: [], discard: [] },
    { name: 'ドロー確率', slots: [[R], [R], [R], [G], [G]], deck: [G, B, B, B], discard: [] },
    { name: 'リシャッフル', slots: [[R], [R], [R], [G], [G]], deck: [], discard: [G, B, B, B] },
    { name: '6スロット同時', slots: [[R], [R], [R], [G], [G], [G]], deck: [], discard: [] },
    { name: '深い連鎖', slots: [[B, G, R], [B, G, R], [B, G, R], [], []], deck: [B, B], discard: [] },
    { name: '混在', slots: [[Y, R], [R], [R], [G], [G]], deck: [G, Y, B], discard: [Y] },
  ];

  for (const sc of scenarios) {
    it(`シナリオ「${sc.name}」`, () => {
      const state = buildFireState(sc.slots, sc.deck, sc.discard);
      const input = subgameInputFromState(state, 0);
      for (const V of [1, 2, 3, 4, 5, 6, 8, 11]) {
        const got = reachF(input, V, { K: 99 });
        const want = referenceF(state, V, 0);
        expectClose(got, want);
      }
    });
  }

  it('ランダム盤面でエンジンと一致する（fuzz）', () => {
    const rng = mulberry32(0xbeef);
    const randColor = (): Color => COLORS[Math.floor(rng() * COLORS.length)];
    const shuffle5 = (): number[] => {
      const a = [0, 1, 2, 3, 4];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    for (let t = 0; t < 80; t++) {
      const fireColor = randColor();
      const fireSlotsIdx = new Set(shuffle5().slice(0, 3));
      const slots: Color[][] = [[], [], [], [], []];
      for (let i = 0; i < 5; i++) {
        if (fireSlotsIdx.has(i)) {
          if (rng() < 0.5) slots[i].push(randColor()); // 下層に1枚
          slots[i].push(fireColor); // 最上段＝発火色
        } else if (rng() < 0.6) {
          if (rng() < 0.4) slots[i].push(randColor());
          slots[i].push(randColor());
        }
        // 残りは空スロット（中立配置先）
      }
      const nDeck = Math.floor(rng() * 4); // 0..3
      const nDisc = Math.floor(rng() * 3); // 0..2
      const deck = Array.from({ length: nDeck }, randColor);
      const discard = Array.from({ length: nDisc }, randColor);

      // 念のため発火を保証（fireColor が3スロットの最上段にあるので必ず真）
      expect(fireSlots(slots)).toBe(true);

      const state = buildFireState(slots, deck, discard);
      const input = subgameInputFromState(state, 0);
      for (const V of [1, 2, 3, 5]) {
        const got = reachF(input, V, { K: 99 });
        const want = referenceF(state, V, 0);
        expectClose(got, want);
      }
    }
  });
});

describe('エンジンで最適ラインの得点を実証', () => {
  it('B削除→G,G,G 回収で 3 点（reducer/stepGame で実走）', () => {
    let s = buildFireState([[G, R], [G, R], [G, R], [B], []], [], []);
    s = stepGame(s, { type: 'RESOLVE_COMBOS' }); // R 発火を解決 → tops G,G,G(自動連鎖しない)
    expect(s.phase).toBe('awaitingAdditionalActionChoice');
    s = stepGame(s, { type: 'DISCARD_TOP', slotIndex: 3 }); // スペアBを削除→G,G,G成立
    // 削除したBは捨札に入るため canDraw=true（リシャッフル可）。まだ終端ではない。
    expect(s.phase).toBe('awaitingAdditionalActionChoice');
    // 残る唯一の手: そのB(リシャッフル)を引いて中立配置 → 新たな発火なし → 得点確定
    s = stepGame(s, { type: 'CHOOSE_ADDITIONAL_DRAW' });
    expect(s.phase).toBe('awaitingPlaceAdditionalDraw');
    s = stepGame(s, { type: 'PLACE_ADDITIONAL_DRAW', slotIndex: 0 });
    expect(s.phase).toBe('awaitingGiftSelection');
    expect(s.players[0].score).toBe(3); // 基礎(1+1) + 本数ボーナス(2本→1) = 3
  });
});

describe('スタック深さ切り詰め K', () => {
  it('K=1 だと下層Gが捨象され 2本目を作れない（K=既定では作れる）', () => {
    const input = {
      slots: [[G, R], [G, R], [G, R], [B], []],
      deck: colorCountsFromColors([]),
      discard: colorCountsFromColors([]),
    };
    expect(reachF(input, 3)).toBe(1); // 既定 K=7：下層 G が生きる
    expect(reachF(input, 3, { K: 1 })).toBe(0); // K=1：最上段以外を捨象→G露出せず
  });
});

describe('reconstructDeckCounts（§1.3 の山札色分布の逆算）', () => {
  it('初期局面で 逆算 == 実数えの山札色分布', () => {
    const s = setupGame({ seed: 777, cardsPerColor: CARDS_PER_COLOR });
    expect(reconstructDeckCounts(s)).toEqual(colorCounts(s.deck));
  });

  it('連鎖途中（保留・除去済み未処理あり）でも 逆算 == 実数え', () => {
    const s0 = setupGame({ seed: 4242, cardsPerColor: CARDS_PER_COLOR });
    // 山札の先頭5枚を「保留2枚 + 連鎖中に除去済み未処理3枚(combosThisTurn)」へ移送。
    // カードは場所を移すだけなので各色の総数は24のまま保たれる。
    const pend = s0.deck.slice(0, 2);
    const removed = s0.deck.slice(2, 5);
    const s1: GameState = {
      ...s0,
      deck: s0.deck.slice(5),
      phase: 'awaitingAdditionalActionChoice',
      turn: {
        ...s0.turn,
        pendingDraw: pend,
        combosThisTurn: [
          { color: removed[0].color, cards: removed, basePoints: 1 },
        ],
      },
    };
    expect(reconstructDeckCounts(s1)).toEqual(colorCounts(s1.deck));
  });
});

describe('subgameInputFromState / reachFFromState', () => {
  it('GameState から入力を組み立てて f を計算できる', () => {
    const state = buildFireState([[R], [R], [R], [G], [G]], [G, B, B, B], []);
    const input = subgameInputFromState(state, 0);
    expect(input.slots).toEqual([[R], [R], [R], [G], [G]]);
    expect(input.deck).toEqual(colorCountsFromColors([G, B, B, B]));
    // reachFFromState は subgameInputFromState 経由で同じ結果
    expectClose(reachFFromState(state, 3, 0, { K: 99 }), reachF(input, 3, { K: 99 }));
    expectClose(reachFFromState(state, 3, 0, { K: 99 }), 0.25);
  });
});
