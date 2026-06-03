/**
 * gen-value-data ― 大規模 value ネット学習用データ生成（最強AI探索 / レイテンシ無制約）。
 *
 * 強い teacher = tempoFast(LA=0) の自己対戦から (encodeState(state, p), rank-value[p]) を収集。
 * 過去 AZ(MCTS ベース) は tempo の手番内完全読みに勝てず頭打ちと判明したため、
 * ここで作る value ネットは **tempo 型探索の葉** として使う前提（policy/priors は分岐5.1で無効＝学習しない）。
 *
 * 出力: Float32 binary（先頭 2 要素 = [count, dim], 続いて count*(dim) 行 = [features..., valueTarget]）。
 * 例: npx tsx ai/scripts/nn/gen-value-data.ts --games 500 --seed 200000 --out /tmp/vdata-0.bin
 */
import { writeFileSync } from 'node:fs';
import { setupGame } from '../../../src/game/setup';
import { stepGame } from '../../../src/game/reducer';
import type { GameState } from '../../../src/game/types';
import { encodeState, ENCODING_SIZE } from '../../../src/ai/encoding';
import { decideAction as decideTempoFast } from '../../../src/ai/tempoFastAI';
import { parseIntArg, currentActorId } from '../_runner';

function rankToValue(rank: number, numPlayers: number): number {
  if (numPlayers <= 1) return 0;
  return 1 - (2 * rank) / (numPlayers - 1);
}

function computeRanking(state: GameState): number[] {
  const players = state.players;
  const ordered = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = (a.id - state.startPlayerIndex + players.length) % players.length;
    const db = (b.id - state.startPlayerIndex + players.length) % players.length;
    return da - db;
  });
  const rank = new Array<number>(players.length).fill(0);
  ordered.forEach((p, i) => { rank[p.id] = i; });
  return rank;
}

interface Sample { vec: Float32Array; player: number; }

function genGame(seed: number, budget: number): { samples: Sample[]; rankValue: Float32Array } | null {
  let state = setupGame({ seed, playerNames: ['p0', 'p1', 'p2', 'p3'], cpuFlags: [true, true, true, true] });
  const decide = (s: GameState, pid: number) => decideTempoFast(s, pid, undefined, { lookaheadTurns: 0, timeBudgetMs: budget });
  const samples: Sample[] = [];
  let lastTurn = -1, steps = 0;
  const MAX = 20000;
  while (state.phase !== 'gameOver' && steps < MAX) {
    if (state.phase === 'awaitingDraw' && state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      for (let p = 0; p < 4; p++) samples.push({ vec: Float32Array.from(encodeState(state, p)), player: p });
    }
    const actor = currentActorId(state);
    const a = decide(state, actor);
    if (!a) break;
    const before = state;
    state = stepGame(state, a);
    if (state === before) break;
    steps++;
  }
  if (state.phase !== 'gameOver' || state.winnerId === null) return null;
  const ranking = computeRanking(state);
  const rankValue = new Float32Array(4);
  for (let p = 0; p < 4; p++) rankValue[p] = rankToValue(ranking[p], 4);
  return { samples, rankValue };
}

function main(): void {
  const argv = process.argv.slice(2);
  let games = 500, seed = 200000, budget = 80, out = '/tmp/vdata.bin';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') games = parseIntArg('--games', argv[++i]);
    else if (argv[i] === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (argv[i] === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (argv[i] === '--out') out = argv[++i] ?? out;
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  const dim = ENCODING_SIZE;
  const rows: number[] = []; // 行 = [features... (dim), value]
  let finished = 0;
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const r = genGame(seed + g, budget);
    if (!r) continue;
    finished++;
    for (const s of r.samples) {
      for (let j = 0; j < dim; j++) rows.push(s.vec[j]);
      rows.push(r.rankValue[s.player]);
    }
    if ((g + 1) % 50 === 0) console.error(`  ${g + 1}/${games} games, ${rows.length / (dim + 1)} samples, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const count = rows.length / (dim + 1);
  // 先頭に [count, dim] を置いた Float32 配列で保存
  const buf = new Float32Array(2 + rows.length);
  buf[0] = count; buf[1] = dim;
  buf.set(rows, 2);
  writeFileSync(out, Buffer.from(buf.buffer));
  console.error(`[gen-value-data] finished=${finished}/${games} samples=${count} dim=${dim} -> ${out} (${(buf.byteLength / 1e6).toFixed(1)}MB)`);
}

main();
