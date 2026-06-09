/**
 * BC 実プレイ崩壊の原因切り分け掃引（Gen-14 の追試）。
 *
 * Gen-14 で「BC 1席 vs tempoFast 3席」貪欲評価が size5=0・平均スコア1.78 で崩壊した。その原因が
 *   (i)  学習の過学習（eval は epochs=60 で held-out 配置が epoch26 以降劣化）なのか、
 *   (ii) ネット容量が過大で out-of-distribution に弱いのか、
 *   (iii) 貪欲（argmax）の決定性で1手の誤りが雪崩を打つのか、
 * を、未実施の安価な軸＝**早期停止 / ネット縮小 / 温度サンプリング**で掃引して切り分ける。
 * どの構成でも size5 が 0 のまま・平均スコアが崩壊水準なら「配置精度~26% そのものが崩壊floor＝
 * データ律速」が確定する。逆にどれかで size5 が 0 から立ち上がれば現データでの前進余地となる。
 *
 *   npx tsx ai/scripts/nn/bc-sweep.ts --data /tmp/bc-data89.json --games 12 --budget 40
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
import { currentActorId, parseIntArg } from '../_runner';

interface Sample {
  x: number[];
  y: number;
}
type Decider = (s: GameState, p: number) => Action | null;

interface Config {
  units: number;
  layers: number;
  epochs: number;
  temp: number;
  label: string;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function trainNet(samples: Sample[], dim: number, cols: number, c: Config): Promise<tf.LayersModel> {
  const xs = tf.tensor2d(samples.map((s) => s.x), [samples.length, dim]);
  const ys = tf.oneHot(tf.tensor1d(samples.map((s) => s.y), 'int32'), cols);
  const input = tf.input({ shape: [dim] });
  let h: tf.SymbolicTensor = input;
  for (let i = 0; i < c.layers; i++) {
    h = tf.layers
      .dense({ units: c.units, activation: 'relu', kernelRegularizer: tf.regularizers.l2({ l2: 1e-3 }), name: `h${i + 1}` })
      .apply(h) as tf.SymbolicTensor;
    h = tf.layers.dropout({ rate: 0.4 }).apply(h) as tf.SymbolicTensor;
  }
  const out = tf.layers.dense({ units: cols, activation: 'softmax', name: 'policy' }).apply(h) as tf.SymbolicTensor;
  const net = tf.model({ inputs: input, outputs: out });
  net.compile({ optimizer: tf.train.adam(1e-3), loss: 'categoricalCrossentropy' });
  await net.fit(xs, ys, { epochs: c.epochs, batchSize: 128, verbose: 0 });
  xs.dispose();
  ys.dispose();
  return net;
}

function makeBcDecider(net: tf.LayersModel, dim: number, temp: number, rng: () => number): Decider {
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
    if (temp <= 0) {
      let best = legal[0];
      let bestP = -Infinity;
      for (const id of legal) {
        if (probs[id] > bestP) {
          bestP = probs[id];
          best = id;
        }
      }
      return actionIdToAction(state, actor, best);
    }
    const weights = legal.map((id) => Math.pow(Math.max(probs[id], 1e-9), 1 / temp));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return actionIdToAction(state, actor, legal[0]);
    let r = rng() * sum;
    let pick = legal[legal.length - 1];
    for (let i = 0; i < legal.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        pick = legal[i];
        break;
      }
    }
    return actionIdToAction(state, actor, pick);
  };
}

interface Row {
  size5: number;
  size4: number;
  size3: number;
  draws: number;
  scoreSum: number;
  reach20: number;
  wins: number;
}

function playGame(seed: number, bc: Decider, tempo: Decider, candSeat: number, row: Row): void {
  let state: GameState = setupGame({ seed, cpuFlags: [true, true, true, true] });
  const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? bc : tempo));
  let prevCombo = 0;
  let steps = 0;
  let reached20 = false;
  while (state.phase !== 'gameOver' && steps < 20000) {
    const actor = currentActorId(state);
    const isCand = actor === candSeat;
    const action = deciders[actor](state, actor);
    if (!action) break;
    if (isCand && (action.type === 'DRAW_FROM_FIELD' || action.type === 'DRAW_FROM_DECK')) row.draws++;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    const cur = state.turn.combosThisTurn;
    if (isCand && cur.length > prevCombo) {
      for (let k = prevCombo; k < cur.length; k++) {
        const sz = cur[k].cards.length;
        if (sz === 3) row.size3++;
        else if (sz === 4) row.size4++;
        else if (sz >= 5) row.size5++;
      }
    }
    prevCombo = cur.length;
    if (!reached20 && state.players[candSeat].score >= 20) {
      reached20 = true;
      row.reach20++;
    }
    steps++;
  }
  const n = state.players.length;
  const ordered = [...state.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return ((a.id - state.startPlayerIndex + n) % n) - ((b.id - state.startPlayerIndex + n) % n);
  });
  if (ordered[0].id === candSeat) row.wins++;
  row.scoreSum += state.players[candSeat].score;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dataPath = '/tmp/bc-data89.json';
  let games = 12;
  let budget = 40;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--data') dataPath = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as { dim: number; actionSpace: number; samples: Sample[] };
  const { dim, actionSpace: cols, samples } = data;
  const tempo: Decider = (s, p) => decideTempoFast(s, p, undefined, { timeBudgetMs: budget, lookaheadTurns: 0 });

  const configs: Config[] = [
    { units: 256, layers: 3, epochs: 60, temp: 0, label: 'baseline 256/3 e60 greedy（Gen-14と同条件）' },
    { units: 256, layers: 3, epochs: 26, temp: 0, label: '早期停止 256/3 e26 greedy' },
    { units: 64, layers: 2, epochs: 26, temp: 0, label: '小+早停 64/2 e26 greedy' },
    { units: 256, layers: 3, epochs: 60, temp: 0.8, label: 'baseline+温度 256/3 e60 temp0.8' },
    { units: 64, layers: 2, epochs: 26, temp: 0.8, label: '小+早停+温度 64/2 e26 temp0.8' },
  ];

  console.error(`[bc-sweep] backend=${tf.getBackend()} ${configs.length}構成 × ${games}局 vs tempoFast(LA=0,budget=${budget})`);
  const rows: { c: Config; row: Row }[] = [];
  for (const c of configs) {
    const t0 = Date.now();
    const net = await trainNet(samples, dim, cols, c);
    const bc = makeBcDecider(net, dim, c.temp, mulberry32(20260609));
    const row: Row = { size5: 0, size4: 0, size3: 0, draws: 0, scoreSum: 0, reach20: 0, wins: 0 };
    for (let g = 0; g < games; g++) playGame(70000 + g, bc, tempo, g % 4, row);
    net.dispose();
    rows.push({ c, row });
    console.error(`  [${c.label}] 完了 ${((Date.now() - t0) / 1000).toFixed(0)}s  size5計=${row.size5} 勝=${row.wins}/${games}`);
  }

  const per100 = (n: number, draws: number) => (draws === 0 ? '0.0' : ((n / draws) * 100).toFixed(1));
  console.log(`\n=== BC 崩壊 原因切り分け掃引（${games}局 vs tempoFast, budget=${budget}）===`);
  console.log(`参考: 人間 size5=8.1 / tempoFast 2.7-3.3 / Gen-14 baseline size5=0.0・平均1.78\n`);
  console.log(`構成 | size5/100手 | size4 | size3 | 平均スコア | 20点到達 | 勝率`);
  console.log(`---|---|---|---|---|---|---`);
  for (const { c, row } of rows) {
    const ci = wilsonInterval(row.wins, games);
    console.log(
      `${c.label} | ${per100(row.size5, row.draws)} (計${row.size5}) | ${per100(row.size4, row.draws)} | ` +
        `${per100(row.size3, row.draws)} | ${(row.scoreSum / games).toFixed(2)} | ${row.reach20}/${games}席 | ` +
        `${row.wins}/${games} (CI ${(100 * ci.low).toFixed(0)}-${(100 * ci.high).toFixed(0)}%)`
    );
  }
}

main();
