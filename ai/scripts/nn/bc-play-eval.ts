/**
 * BC policy を実プレイ用 Decider 化して評価する（確定方針の検証）。
 *
 * 89 局の人間棋譜で behavioral cloning した policy ネット（185→30 softmax）を、探索なしの貪欲
 * Decider（合法手の中で argmax）にして tempoFast と対戦させ、**実際にカスケード（size5）を組むか**を
 * 測る。これが expert iteration（人間種付き生成+選抜）の種に使えるかの分かれ目:
 *   - size5 率が tempoFast(2.7) を明確に超えて人間(8.1)へ寄れば、BC は人間のカスケード skill を捉えており
 *     生成器として有望。
 *   - size5 ≈ AI 水準なら、現データでは skill を捉えきれず（律速＝データ量）。
 *
 * 探索なしの BC は脆い（compounding error）ので勝率は二次的指標。主役は size5・複数発火・ペース。
 * gift 選択(CONFIRM_GIFTS)は行動 ID 空間外なので smartAI に委譲。
 *
 *   npx tsx ai/scripts/nn/bc-play-eval.ts --data /tmp/bc-data89.json --games 64 --budget 150 --units 256 --layers 3 --epochs 60
 */
import * as tf from '@tensorflow/tfjs-node';
import { readFileSync } from 'node:fs';
import { setupGame } from '../../../src/game/setup';
import { stepGame } from '../../../src/game/reducer';
import type { Action, GameState } from '../../../src/game/types';
import { decideAction as decideTempoFast } from '../../../src/ai/tempoFastAI';
import { decideAction as decideSmart } from '../../../src/ai/smartAI';
import { encodeState } from '../../../src/ai/encoding';
import { legalActionIds, actionIdToAction } from '../../../src/ai/actionSpace';
import { wilsonInterval } from '../stats';
import { currentActorId, parseIntArg, parseFloatArg } from '../_runner';

interface Sample {
  x: number[];
  y: number;
  game: number;
}

type Decider = (s: GameState, p: number) => Action | null;
const THRESHOLDS = [5, 10, 15, 20] as const;

async function trainNet(
  dataPath: string,
  dim: number,
  cols: number,
  units: number,
  layers: number,
  epochs: number
): Promise<tf.LayersModel> {
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as { samples: Sample[] };
  const xs = tf.tensor2d(data.samples.map((s) => s.x), [data.samples.length, dim]);
  const ys = tf.oneHot(tf.tensor1d(data.samples.map((s) => s.y), 'int32'), cols);
  const input = tf.input({ shape: [dim] });
  let h: tf.SymbolicTensor = input;
  for (let i = 0; i < layers; i++) {
    h = tf.layers
      .dense({ units, activation: 'relu', kernelRegularizer: tf.regularizers.l2({ l2: 1e-3 }), name: `h${i + 1}` })
      .apply(h) as tf.SymbolicTensor;
    h = tf.layers.dropout({ rate: 0.4 }).apply(h) as tf.SymbolicTensor;
  }
  const out = tf.layers.dense({ units: cols, activation: 'softmax', name: 'policy' }).apply(h) as tf.SymbolicTensor;
  const net = tf.model({ inputs: input, outputs: out });
  net.compile({ optimizer: tf.train.adam(1e-3), loss: 'categoricalCrossentropy' });
  await net.fit(xs, ys, { epochs, batchSize: 128, verbose: 0 });
  xs.dispose();
  ys.dispose();
  return net;
}

function makeBcDecider(net: tf.LayersModel, dim: number): Decider {
  return (state, playerId) => {
    if (state.phase === 'awaitingGiftSelection') {
      if (state.currentPlayerIndex !== playerId) return null;
      return decideSmart(state, playerId, 12345);
    }
    const actor = currentActorId(state);
    if (actor !== playerId) return null;
    const legal = legalActionIds(state, actor);
    if (legal.length === 0) return null;
    if (legal.length === 1) return actionIdToAction(state, actor, legal[0]);
    const x = encodeState(state, actor);
    const probs = tf.tidy(() => {
      const t = net.predict(tf.tensor2d([x], [1, dim])) as tf.Tensor;
      return t.dataSync();
    });
    let best = legal[0];
    let bestP = -Infinity;
    for (const id of legal) {
      if (probs[id] > bestP) {
        bestP = probs[id];
        best = id;
      }
    }
    return actionIdToAction(state, actor, best);
  };
}

interface Side {
  combo: Map<number, number>;
  turns: number;
  multiFire: number;
  playerTurns: number;
  scoreSum: number;
  reach: Record<number, number[]>;
}
const newSide = (): Side => ({ combo: new Map(), turns: 0, multiFire: 0, playerTurns: 0, scoreSum: 0, reach: { 5: [], 10: [], 15: [], 20: [] } });

function playGame(seed: number, deciders: Decider[], candSeat: number): { rank0: boolean; cand: Side; base: Side } {
  let state: GameState = setupGame({ seed, cpuFlags: [true, true, true, true] });
  const cand = newSide();
  const base = newSide();
  const n = state.players.length;
  let prevCombo = 0;
  let prevTurn = state.turnNumber;
  let prevActive = state.currentPlayerIndex;
  let fires = 0;
  let steps = 0;
  const reached: Record<number, number>[] = state.players.map(() => ({}));
  const flush = (active: number) => {
    const s = active === candSeat ? cand : base;
    s.playerTurns++;
    if (fires >= 2) s.multiFire++;
    fires = 0;
  };
  while (state.phase !== 'gameOver' && steps < 20000) {
    const actor = currentActorId(state);
    const isCand = actor === candSeat;
    const action = deciders[actor](state, actor);
    if (!action) break;
    if (action.type === 'DRAW_FROM_FIELD' || action.type === 'DRAW_FROM_DECK') (isCand ? cand : base).turns++;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    if (state.turnNumber !== prevTurn) {
      flush(prevActive);
      prevTurn = state.turnNumber;
      prevActive = state.currentPlayerIndex;
    }
    const cur = state.turn.combosThisTurn;
    if (cur.length > prevCombo) {
      const s = isCand ? cand : base;
      for (let k = prevCombo; k < cur.length; k++) {
        s.combo.set(cur[k].cards.length, (s.combo.get(cur[k].cards.length) ?? 0) + 1);
        fires++;
      }
    }
    prevCombo = cur.length;
    for (let pid = 0; pid < n; pid++) {
      const sc = state.players[pid].score;
      for (const th of THRESHOLDS) if (sc >= th && reached[pid][th] === undefined) reached[pid][th] = state.turnNumber;
    }
    steps++;
  }
  flush(prevActive);
  const ordered = [...state.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = (a.id - state.startPlayerIndex + n) % n;
    const db = (b.id - state.startPlayerIndex + n) % n;
    return da - db;
  });
  for (let pid = 0; pid < n; pid++) {
    const s = pid === candSeat ? cand : base;
    s.scoreSum += state.players[pid].score;
    for (const th of THRESHOLDS) if (reached[pid][th] !== undefined) s.reach[th].push(reached[pid][th]);
  }
  return { rank0: ordered[0].id === candSeat, cand, base };
}

function merge(d: Side, s: Side) {
  d.turns += s.turns;
  d.multiFire += s.multiFire;
  d.playerTurns += s.playerTurns;
  d.scoreSum += s.scoreSum;
  for (const [k, v] of s.combo) d.combo.set(k, (d.combo.get(k) ?? 0) + v);
  for (const th of THRESHOLDS) d.reach[th].push(...s.reach[th]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dataPath = '/tmp/bc-data89.json';
  let games = 64;
  let budget = 150;
  let units = 256;
  let layers = 3;
  let epochs = 60;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--data') dataPath = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--units') units = parseIntArg('--units', argv[++i]);
    else if (k === '--layers') layers = parseIntArg('--layers', argv[++i]);
    else if (k === '--epochs') epochs = parseIntArg('--epochs', argv[++i]);
    else if (k === '--lr') parseFloatArg('--lr', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const meta = JSON.parse(readFileSync(dataPath, 'utf8')) as { dim: number; actionSpace: number };
  console.error(`[bc-play] backend=${tf.getBackend()} 学習中（units=${units} layers=${layers} epochs=${epochs}）...`);
  const net = await trainNet(dataPath, meta.dim, meta.actionSpace, units, layers, epochs);
  const bc = makeBcDecider(net, meta.dim);
  const tempo: Decider = (s, p) => decideTempoFast(s, p, undefined, { timeBudgetMs: budget, lookaheadTurns: 0 });

  console.error(`[bc-play] BC(探索なし) 1席 vs tempoFast(LA=0,budget=${budget}) 3席, ${games}局 rotate`);
  let wins = 0;
  const cand = newSide();
  const base = newSide();
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? bc : tempo));
    const r = playGame(70000 + g, deciders, candSeat);
    if (r.rank0) wins++;
    merge(cand, r.cand);
    merge(base, r.base);
    if ((g + 1) % 8 === 0) console.error(`  進捗 ${g + 1}/${games} cand勝ち=${wins} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const ci = wilsonInterval(wins, games);
  const per100 = (s: Side, sz: number) => (s.turns === 0 ? '0.0' : (((s.combo.get(sz) ?? 0) / s.turns) * 100).toFixed(1));
  const avgReach = (s: Side, th: number) => (s.reach[th].length === 0 ? '-' : (s.reach[th].reduce((a, b) => a + b, 0) / s.reach[th].length).toFixed(1));

  console.log(`\n=== BC policy 実プレイ評価（89局学習, 探索なし貪欲）===`);
  console.log(`勝率: ${(100 * wins / games).toFixed(1)}% (CI ${(100 * ci.low).toFixed(1)}-${(100 * ci.high).toFixed(1)}%) vs 公平25%  [${wins}/${games}]`);
  console.log(`\nコンボサイズ別（手番100あたり）★size5が核:`);
  console.log(`  BC policy  3:${per100(cand, 3)}  4:${per100(cand, 4)}  5:${per100(cand, 5)}`);
  console.log(`  tempoFast  3:${per100(base, 3)}  4:${per100(base, 4)}  5:${per100(base, 5)}`);
  console.log(`  参考: 人間 size5=8.1 / 現状AI=2.7（/100手番）`);
  console.log(`複数発火率: BC ${cand.playerTurns ? (100 * cand.multiFire / cand.playerTurns).toFixed(1) : '0'}%  tempoFast ${base.playerTurns ? (100 * base.multiFire / base.playerTurns).toFixed(1) : '0'}%`);
  console.log(`20点到達: BC ${avgReach(cand, 20)}(${cand.reach[20].length}席)  tempoFast ${avgReach(base, 20)}(${base.reach[20].length}席)`);
  console.log(`手番効率: BC ${(cand.scoreSum / Math.max(1, cand.turns)).toFixed(3)}  tempoFast ${(base.scoreSum / Math.max(1, base.turns)).toFixed(3)}`);
  console.log(`平均スコア: BC席 ${(cand.scoreSum / games).toFixed(2)}  tempoFast席 ${(base.scoreSum / (games * 3)).toFixed(2)}`);
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  net.dispose();
}

main();
