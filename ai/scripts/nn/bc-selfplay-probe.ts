/**
 * BC policy の自己対戦カスケード診断（Step 1 ゲートの補完）。
 *
 * bc-play-eval.ts は「BC 1 席 vs tempoFast 3 席」で BC の size5 率を測り、結果は size5≈0・
 * 平均スコア 1.78・20 点到達 0 席だった（＝貪欲 BC は compounding error で序盤に崩壊し、
 * カスケードが起きる終盤局面に到達しない）。本スクリプトはタスクが要求するもう一方の生成構成
 * 「BC 自己対戦（4 席すべて BC）」で同じ診断を行う。強い tempoFast がいないぶんゲームが速く
 * 終わらず、盤面が積み上がって size5 が出やすいかを確かめる。ここでも size5≈0 なら、生成構成に
 * 依らず貪欲 BC はカスケードを組めない＝expert iteration の種に使えない、が確定する。
 *
 * 探索なし貪欲（argmax）で測る。温度サンプリングは多様性のためのもので「組める最大」は貪欲なので、
 * 貪欲で size5≈0 なら温度を入れても size5 は増えない（ノイズが乗るだけ）。gift は smartAI に委譲。
 *
 *   npx tsx ai/scripts/nn/bc-selfplay-probe.ts --data /tmp/bc-data89.json --games 24 --units 256 --layers 3 --epochs 60
 */
import * as tf from '@tensorflow/tfjs-node';
import { readFileSync } from 'node:fs';
import { setupGame } from '../../../src/game/setup';
import { stepGame } from '../../../src/game/reducer';
import type { Action, GameState } from '../../../src/game/types';
import { decideAction as decideSmart } from '../../../src/ai/smartAI';
import { encodeState } from '../../../src/ai/encoding';
import { legalActionIds, actionIdToAction } from '../../../src/ai/actionSpace';
import { currentActorId, parseIntArg, parseFloatArg, DEFAULT_MAX_STEPS } from '../_runner';

interface Sample {
  x: number[];
  y: number;
}

type Decider = (s: GameState, p: number) => Action | null;

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

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * BC policy を Decider 化。temp<=0 は合法手 argmax（貪欲）。temp>0 は合法手上で温度付き
 * softmax サンプリング（探索的生成用。温度を上げるほど一様に近づく）。
 */
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
    // 温度付きサンプリング: w_i = p_i^(1/temp) を合法手で正規化して抽選。
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

interface Agg {
  combo: Map<number, number>;
  draws: number; // 全席合計の手番数（DRAW 回数）
  scoreSum: number;
  reach20: number; // 20 点到達席数
  finished: number; // gameOver 到達ゲーム数
  cappedSteps: number; // step cap で打ち切った数
  turnSum: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let dataPath = '/tmp/bc-data89.json';
  let games = 24;
  let units = 256;
  let layers = 3;
  let epochs = 60;
  let temp = 0;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--data') dataPath = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--units') units = parseIntArg('--units', argv[++i]);
    else if (k === '--layers') layers = parseIntArg('--layers', argv[++i]);
    else if (k === '--epochs') epochs = parseIntArg('--epochs', argv[++i]);
    else if (k === '--temp') temp = parseFloatArg('--temp', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const meta = JSON.parse(readFileSync(dataPath, 'utf8')) as { dim: number; actionSpace: number };
  console.error(`[bc-self] backend=${tf.getBackend()} 学習中（units=${units} layers=${layers} epochs=${epochs} temp=${temp}）...`);
  const net = await trainNet(dataPath, meta.dim, meta.actionSpace, units, layers, epochs);
  const bc = makeBcDecider(net, meta.dim, temp, mulberry32(20260609));

  console.error(`[bc-self] BC 自己対戦（4 席すべて ${temp > 0 ? `温度${temp}サンプリング` : '探索なし貪欲'} BC）, ${games}局`);
  const agg: Agg = { combo: new Map(), draws: 0, scoreSum: 0, reach20: 0, finished: 0, cappedSteps: 0, turnSum: 0 };
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    let state: GameState = setupGame({ seed: 80000 + g, cpuFlags: [true, true, true, true] });
    let prevCombo = 0;
    let steps = 0;
    const reached20 = new Array<boolean>(state.players.length).fill(false);
    while (state.phase !== 'gameOver' && steps < DEFAULT_MAX_STEPS) {
      const actor = currentActorId(state);
      const action = bc(state, actor);
      if (!action) break;
      if (action.type === 'DRAW_FROM_FIELD' || action.type === 'DRAW_FROM_DECK') agg.draws++;
      const before = state;
      state = stepGame(state, action);
      if (state === before) break;
      const cur = state.turn.combosThisTurn;
      if (cur.length > prevCombo) {
        for (let k = prevCombo; k < cur.length; k++) {
          const sz = cur[k].cards.length;
          agg.combo.set(sz, (agg.combo.get(sz) ?? 0) + 1);
        }
      }
      prevCombo = cur.length;
      for (let pid = 0; pid < state.players.length; pid++) {
        if (!reached20[pid] && state.players[pid].score >= 20) {
          reached20[pid] = true;
          agg.reach20++;
        }
      }
      steps++;
    }
    if (state.phase === 'gameOver') agg.finished++;
    if (steps >= DEFAULT_MAX_STEPS) agg.cappedSteps++;
    agg.turnSum += state.turnNumber;
    for (const p of state.players) agg.scoreSum += p.score;
    if ((g + 1) % 8 === 0) console.error(`  進捗 ${g + 1}/${games} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const per100 = (sz: number) => (agg.draws === 0 ? '0.0' : (((agg.combo.get(sz) ?? 0) / agg.draws) * 100).toFixed(1));
  console.log(`\n=== BC 自己対戦 カスケード診断（89局学習, 4席すべて探索なし貪欲）===`);
  console.log(`コンボサイズ別（全席合算・手番100あたり）★size5が核:`);
  console.log(`  BC self  3:${per100(3)}  4:${per100(4)}  5:${per100(5)}  （size5 合計件数=${agg.combo.get(5) ?? 0}）`);
  console.log(`  参考: 人間 size5=8.1 / 現状AI=2.7 / BC vs tempoFast=0.0（/100手番）`);
  console.log(`平均最終スコア（席あたり）: ${(agg.scoreSum / (games * 4)).toFixed(2)}  （tempoFast 16.06 / BC vs tempo 1.78）`);
  console.log(`20点到達: ${agg.reach20}席 / ${games * 4}席  ・ gameOver到達 ${agg.finished}/${games}局  ・ step上限打切 ${agg.cappedSteps}局`);
  console.log(`平均ターン数: ${(agg.turnSum / games).toFixed(1)}`);
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  net.dispose();
}

main();
