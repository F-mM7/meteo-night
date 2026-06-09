/**
 * _goal-5chain.ts（探査用）: 「1ターンで5色5連鎖」が出る盤面を実エンジンで確定する。
 *
 * 連鎖の合間の強制アクションは2択（取り除き / 山札から1枚引いて配置）。両方を全探索して、
 * 構築した盤面から1ターンで出せる最大連鎖（コンボ数・各サイズ・色）を実測する。
 * → 捨て札が要るのか、特定色が何枚要るのか、を机上推測でなく確定する。
 *
 *   npx tsx ai/scripts/_goal-5chain.ts
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Card, Color, GameState } from '../../src/game/types';
import { maxChainFrom } from '../../src/ai/cascade';

let CID = 0;
function card(color: Color): Card {
  return { id: `${color}-${CID++}`, color };
}
/** colorsTopToBottom[0] が最上段。 */
function buildSlot(colorsTopToBottom: Color[]): { stack: Card[] } {
  return { stack: [...colorsTopToBottom].reverse().map(card) };
}

const [R, G, P, Y, B] = ['red', 'green', 'purple', 'yellow', 'blue'] as Color[];
const DECK_COLORS: Color[] = [];
for (let i = 0; i < 8; i++) DECK_COLORS.push(R, G, P, Y, B); // 40 枚（引く強制アクション用）

function makeTriggeredState(slotsSpec: Color[][]): GameState {
  const base = setupGame({ seed: 1, cpuFlags: [true, true, true, true] });
  const slots = slotsSpec.map(buildSlot);
  while (slots.length < 5) slots.push({ stack: [] });
  const players = base.players.map((p, i) => (i === 0 ? { ...p, board: { slots } } : p));
  return {
    ...base,
    players,
    currentPlayerIndex: 0,
    phase: 'resolvingCombos',
    deck: DECK_COLORS.map(card),
    discardPile: [],
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

interface ChainResult {
  len: number;
  sizes: number[];
  colors: Color[];
}
let NODES = 0;
const NODE_LIMIT = 800000;

function result(state: GameState): ChainResult {
  const c = state.turn.combosThisTurn;
  return { len: c.length, sizes: c.map((x) => x.cards.length), colors: c.map((x) => x.color) };
}

/** 強制アクション（取り除き／引いて配置）を全探索し、最大連鎖を返す。 */
function maxChain(state: GameState): ChainResult {
  NODES++;
  if (NODES > NODE_LIMIT) return result(state);
  const slots = state.players[0].board.slots;

  if (state.phase === 'awaitingAdditionalActionChoice') {
    let best = result(state);
    // A: 取り除き（各非空スロットの最上段を捨札）
    for (let s = 0; s < slots.length; s++) {
      if (slots[s].stack.length === 0) continue;
      const next = stepGame(state, { type: 'DISCARD_TOP', slotIndex: s });
      if (next !== state) {
        const r = maxChain(next);
        if (r.len > best.len) best = r;
      }
    }
    // B: 山札から1枚引く（→ 配置フェーズへ）
    const drew = stepGame(state, { type: 'CHOOSE_ADDITIONAL_DRAW' });
    if (drew !== state) {
      const r = maxChain(drew);
      if (r.len > best.len) best = r;
    }
    return best;
  }

  if (state.phase === 'awaitingPlaceAdditionalDraw') {
    let best = result(state);
    for (let s = 0; s < slots.length; s++) {
      const next = stepGame(state, { type: 'PLACE_ADDITIONAL_DRAW', slotIndex: s });
      if (next !== state) {
        const r = maxChain(next);
        if (r.len > best.len) best = r;
      }
    }
    return best;
  }

  return result(state);
}

function evalConfig(name: string, slotsSpec: Color[][]): void {
  const total = slotsSpec.reduce((a, s) => a + s.length, 0);
  NODES = 0;
  const s1 = stepGame(makeTriggeredState(slotsSpec), { type: 'RESOLVE_COMBOS' });
  const r = maxChain(s1);
  console.log(
    `${name.padEnd(38)} 連鎖=${r.len} 色数=${new Set(r.colors).size} sizes=[${r.sizes.join(',')}] (盤面${total}枚, 探索${NODES})`
  );
}

console.log('=== 5色5連鎖が出る盤面（強制アクション=取り除き/引く 両方を探索） ===\n');
console.log('--- 捨て札なしでも「引いて配置」で5連鎖が続くか ---');
evalConfig('3col[RGPYB] 15枚のみ（空き2・捨て札0）', [[R, G, P, Y, B], [R, G, P, Y, B], [R, G, P, Y, B]]);
evalConfig('3col[RGPYB] + 空き1（捨て札0）', [[R, G, P, Y, B], [R, G, P, Y, B], [R, G, P, Y, B], []]);

console.log('\n--- 列数・段数の依存 ---');
evalConfig('4col[RGPYB]（捨て札0）', [[R, G, P, Y, B], [R, G, P, Y, B], [R, G, P, Y, B], [R, G, P, Y, B]]);
evalConfig('3col[RGP] 3段', [[R, G, P], [R, G, P], [R, G, P]]);
evalConfig('3col[RGPY] 4段', [[R, G, P, Y], [R, G, P, Y], [R, G, P, Y]]);

console.log('\n--- 段の色がズレていると（同色順でないと）どうなるか ---');
evalConfig('3col 色順バラバラ', [[R, G, P, Y, B], [G, R, Y, P, B], [P, Y, R, B, G]]);

console.log('\n--- ユーザー提示の段違い(staggered)構造: 一様3列でなくても連鎖が出る ---');
// 下→上: [青,赤][青,緑,赤][青,緑][緑,赤]（buildSlot には上→下で渡す）
evalConfig('staggered [青赤][青緑赤][青緑][緑赤]', [[R, B], [R, G, B], [G, B], [R, G]]);
// 各色が乗る3スロットがズレてよい（赤=slot0,1,3 / 緑=slot1,2,3 / 青=slot0,1,2）。

// ---- maxChainFrom（核評価器）の検証: 配置前(手番開始)から2枚配置込みで最大連鎖を測る ----
function makeHeldState(slotsSpec: Color[][], pendingColors: Color[]): GameState {
  const base = setupGame({ seed: 1, cpuFlags: [true, true, true, true] });
  const slots = slotsSpec.map(buildSlot);
  while (slots.length < 5) slots.push({ stack: [] });
  const players = base.players.map((p, i) => (i === 0 ? { ...p, board: { slots } } : p));
  return {
    ...base,
    players,
    currentPlayerIndex: 0,
    phase: 'awaitingPlaceDrawn',
    deck: DECK_COLORS.map(card),
    discardPile: [],
    turn: {
      pendingDraw: pendingColors.map(card),
      pendingAdditionalDraw: null,
      combosThisTurn: [],
      giftQueue: [],
      hasDrawn: true,
      pendingGiftBatches: [],
      discardedCardIds: [],
    },
  };
}

function evalHeld(name: string, slotsSpec: Color[][], pending: Color[]): void {
  const r = maxChainFrom(makeHeldState(slotsSpec, pending), 0, { nodeLimit: 300000 });
  console.log(`${name.padEnd(42)} 最大連鎖=${r.chain} sizes=[${r.sizes.join(',')}] (探索${r.nodes})`);
}

console.log('\n=== maxChainFrom 検証（配置前から2枚配置込みで最大連鎖） ===');
evalHeld('2列フル+1列[GPYB](R欠) 引き[R,B] → 5期待', [[R, G, P, Y, B], [R, G, P, Y, B], [G, P, Y, B]], [R, B]);
evalHeld('段違いheld(R×2) 引き[R,P] → 3期待', [[B], [R, G, B], [G, B], [R, G]], [R, P]);
evalHeld('2列[GPYB]+1列[PYB] 引き[G,R] → 4期待', [[G, P, Y, B], [G, P, Y, B], [P, Y, B]], [G, R]);
evalHeld('連鎖不能 引き[R,G] → 0期待', [[R], [G]], [R, G]);
