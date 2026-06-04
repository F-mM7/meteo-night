/**
 * compare-value ― 学習した value ネット vs 手書き評価(evaluateState) の「勝者予測精度」を探索抜きで比較。
 *
 * 探索の葉として使う前の安価な関門: ネットが手書き評価より良い value を学習できていなければ、
 * 葉に挿しても play は改善しない（むしろ探索が葉誤差を補正するので parity 以下）。
 * held-out 自己対戦（train と別 seed）で、各サンプル局面 (state, player) について
 *   netVal = net(encodeState(state,p)),  handVal = evaluateState(state,p),  actual = rankValue[最終順位[p]]
 * を集め、netVal/handVal それぞれと actual の相関、および「最高値プレイヤー＝実際の勝者」一致率を出す。
 *
 * 例: npx tsx ai/scripts/nn/compare-value.ts --games 120 --seed 300000 --model ai/models/value-v1
 */
import * as tf from '@tensorflow/tfjs-node-gpu';
import { setupGame } from '../../../src/game/setup';
import { stepGame } from '../../../src/game/reducer';
import type { GameState } from '../../../src/game/types';
import { encodeState, ENCODING_SIZE } from '../../../src/ai/encoding';
import { evaluateState } from '../../../src/ai/evaluator';
import { decideAction as decideTempoFast } from '../../../src/ai/tempoFastAI';
import { parseIntArg, currentActorId } from '../_runner';

function rankToValue(rank: number): number { return 1 - (2 * rank) / 3; }
function computeRanking(state: GameState): number[] {
  const players = state.players;
  const ordered = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = (a.id - state.startPlayerIndex + 4) % 4, db = (b.id - state.startPlayerIndex + 4) % 4;
    return da - db;
  });
  const rank = new Array<number>(4).fill(0);
  ordered.forEach((p, i) => { rank[p.id] = i; });
  return rank;
}
function pearson(x: number[], y: number[]): number {
  const n = x.length; let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

interface Snap { vecs: Float32Array[]; hand: number[]; winner: number; }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let games = 120, seed = 300000, budget = 80, modelDir = 'ai/models/value-v1';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--model') modelDir = argv[++i] ?? modelDir;
    else throw new Error(`unknown arg: ${k}`);
  }
  const net = await tf.loadLayersModel(`file://${process.cwd()}/${modelDir}/model.json`);
  console.error(`[compare-value] model=${modelDir} backend=${tf.getBackend()} games=${games} seed=${seed}`);

  // held-out 自己対戦で局面スナップショットを集める
  const snaps: Snap[] = [];
  for (let g = 0; g < games; g++) {
    let state = setupGame({ seed: seed + g, playerNames: ['p0', 'p1', 'p2', 'p3'], cpuFlags: [true, true, true, true] });
    const pend: Array<{ vecs: Float32Array[]; hand: number[] }> = [];
    let lastTurn = -1, steps = 0;
    while (state.phase !== 'gameOver' && steps < 20000) {
      if (state.phase === 'awaitingDraw' && state.turnNumber !== lastTurn) {
        lastTurn = state.turnNumber;
        const vecs: Float32Array[] = [], hand: number[] = [];
        for (let p = 0; p < 4; p++) { vecs.push(Float32Array.from(encodeState(state, p))); hand.push(evaluateState(state, p)); }
        pend.push({ vecs, hand });
      }
      const actor = currentActorId(state);
      const a = decideTempoFast(state, actor, undefined, { lookaheadTurns: 0, timeBudgetMs: budget });
      if (!a) break;
      const before = state; state = stepGame(state, a);
      if (state === before) break; steps++;
    }
    if (state.phase !== 'gameOver' || state.winnerId === null) continue;
    const ranking = computeRanking(state);
    const winner = ranking.indexOf(0);
    for (const ps of pend) snaps.push({ vecs: ps.vecs, hand: ps.hand, winner });
  }
  console.error(`snapshots=${snaps.length}`);

  // ネット推論をまとめてバッチ
  const flat = new Float32Array(snaps.length * 4 * ENCODING_SIZE);
  let o = 0;
  for (const s of snaps) for (let p = 0; p < 4; p++) { flat.set(s.vecs[p], o); o += ENCODING_SIZE; }
  const inT = tf.tensor2d(flat, [snaps.length * 4, ENCODING_SIZE]);
  const outT = net.predict(inT) as tf.Tensor;
  const netVals = await outT.data();
  inT.dispose(); outT.dispose();

  // プール: 各 (state,player) の (netVal, handVal, actual=rankValue[最終順位]) ※順位は winner=+1 等で近似
  // 実順位は winner のみ厳密に分かる形にしているので、 ranking を保持しなかった。
  // → ここでは「最高評価のプレイヤーが実際の勝者か」の一致率を主指標にする（順位フルは別途）。
  const netCol: number[] = [], handCol: number[] = [], actualWin: number[] = [];
  let netPick = 0, handPick = 0, tot = 0;
  for (let s = 0; s < snaps.length; s++) {
    const base = s * 4;
    let netBest = -Infinity, netArg = 0, handBest = -Infinity, handArg = 0;
    for (let p = 0; p < 4; p++) {
      const nv = netVals[base + p], hv = snaps[s].hand[p];
      netCol.push(nv); handCol.push(hv); actualWin.push(p === snaps[s].winner ? 1 : 0);
      if (nv > netBest) { netBest = nv; netArg = p; }
      if (hv > handBest) { handBest = hv; handArg = p; }
    }
    if (netArg === snaps[s].winner) netPick++;
    if (handArg === snaps[s].winner) handPick++;
    tot++;
  }
  const netCorr = pearson(netCol, actualWin);
  const handCorr = pearson(handCol, actualWin);
  console.log(`\n=== value 品質比較（held-out ${snaps.length} 局面 × 4 players）===`);
  console.log(`勝者一致率（最高評価=実際の勝者）:  ネット ${(netPick / tot * 100).toFixed(1)}%   手書き ${(handPick / tot * 100).toFixed(1)}%   (ランダム=25%)`);
  console.log(`勝者フラグとの相関:                  ネット ${netCorr.toFixed(4)}            手書き ${handCorr.toFixed(4)}`);
  const verdict = (netPick > handPick && netCorr > handCorr) ? '✅ ネットが手書き評価を上回る → 探索ベンチへ進む価値あり'
    : (netPick < handPick || netCorr < handCorr) ? '❌ ネットは手書き評価を超えない → 葉に挿しても改善見込みなし'
    : '― 同等';
  console.log(`\n=> ${verdict}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
