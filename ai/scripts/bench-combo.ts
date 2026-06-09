/**
 * 候補重みの self-play コンボサイズ分布 + 強さベンチ。
 *
 * candidate = tempoFast(候補重み) を 1 席、baseline = tempoFast(DEFAULT 重み) を 3 席で rotate 対戦。
 * candidate 席が現状重みより (1) 大コンボ(size5)を多く作るか (2) 強いか を同時に測る。
 * 物差しは self-play（現状最強の重み）に対する相対なので smart 非依存。
 *
 *   npx tsx ai/scripts/bench-combo.ts --weights '{"pendingMult":40,"reach4":130}' --budget 150 --games 32 --seed 41001
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
import { wilsonInterval } from './stats';
import { currentActorId, parseIntArg } from './_runner';
import type { Action, GameState } from '../../src/game/types';

type Decider = (s: GameState, p: number) => Action | null;

function computeRanking(state: GameState): number[] {
  const players = state.players;
  const ordered = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = (a.id - state.startPlayerIndex + players.length) % players.length;
    const distB = (b.id - state.startPlayerIndex + players.length) % players.length;
    return distA - distB;
  });
  const rank = new Array<number>(players.length).fill(0);
  ordered.forEach((p, i) => {
    rank[p.id] = i;
  });
  return rank;
}

interface GameStat {
  ranking: number[];
  candTurns: number;
  baseTurns: number;
  candCombo: Map<number, number>;
  baseCombo: Map<number, number>;
}

function playGame(seed: number, deciders: Decider[], candSeat: number, maxSteps: number): GameStat {
  let state: GameState = setupGame({ seed, cpuFlags: [true, true, true, true] });
  const candCombo = new Map<number, number>();
  const baseCombo = new Map<number, number>();
  let candTurns = 0;
  let baseTurns = 0;
  let prevCombo = 0;
  let steps = 0;
  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const isCand = actor === candSeat;
    const action = deciders[actor](state, actor);
    if (!action) break;
    if (action.type === 'DRAW_FROM_FIELD' || action.type === 'DRAW_FROM_DECK') {
      if (isCand) candTurns++;
      else baseTurns++;
    }
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    const cur = state.turn.combosThisTurn;
    if (cur.length > prevCombo) {
      const m = isCand ? candCombo : baseCombo;
      for (let k = prevCombo; k < cur.length; k++) {
        const sz = cur[k].cards.length;
        m.set(sz, (m.get(sz) ?? 0) + 1);
      }
    }
    prevCombo = cur.length;
    steps++;
  }
  return { ranking: computeRanking(state), candTurns, baseTurns, candCombo, baseCombo };
}

function main(): void {
  const argv = process.argv.slice(2);
  let weightsJson = '{}';
  let budget = 150;
  let games = 32;
  let seed = 41001;
  let lookahead = 1;
  const maxSteps = 20000;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--weights') weightsJson = argv[++i];
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--lookahead') lookahead = parseIntArg('--lookahead', argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  const candWeights: EvalWeights = { ...DEFAULT_WEIGHTS, ...JSON.parse(weightsJson) };

  const candidate: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, {
      weights: candWeights,
      lookaheadTurns: lookahead,
      timeBudgetMs: budget,
    });
  const baseline: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, { lookaheadTurns: lookahead, timeBudgetMs: budget });

  console.error(
    `[bench-combo] cand=${weightsJson} budget=${budget} LA=${lookahead} games=${games} seed=${seed}`
  );

  let candWins = 0;
  const candCombo = new Map<number, number>();
  const baseCombo = new Map<number, number>();
  let candTurns = 0;
  let baseTurns = 0;
  const t0 = Date.now();

  for (let g = 0; g < games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    const r = playGame(seed + g, deciders, candSeat, maxSteps);
    if (r.ranking[candSeat] === 0) candWins++;
    candTurns += r.candTurns;
    baseTurns += r.baseTurns;
    for (const [sz, n] of r.candCombo) candCombo.set(sz, (candCombo.get(sz) ?? 0) + n);
    for (const [sz, n] of r.baseCombo) baseCombo.set(sz, (baseCombo.get(sz) ?? 0) + n);
  }

  const winRate = candWins / games;
  const ci = wilsonInterval(candWins, games);
  const per100 = (m: Map<number, number>, sz: number, turns: number) =>
    turns === 0 ? ' 0.0' : (((m.get(sz) ?? 0) / turns) * 100).toFixed(1).padStart(4);
  const sixPlus = (m: Map<number, number>, turns: number) => {
    let s = 0;
    for (const [k, n] of m) if (k >= 6) s += n;
    return turns === 0 ? ' 0.0' : ((s / turns) * 100).toFixed(1).padStart(4);
  };

  console.log(`\n=== bench-combo 候補重み=${weightsJson} ===`);
  console.log(
    `強さ: 候補席 勝率 ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs 公平25%  [${candWins}/${games}]`
  );
  const verdict = ci.low > 0.25 ? '有意に強い' : ci.high < 0.25 ? '有意に弱い' : 'parity（差なし）';
  console.log(`判定: ${verdict}`);
  console.log(`\nコンボサイズ別（手番100あたり）:`);
  console.log(
    `  候補席   3:${per100(candCombo, 3, candTurns)}  4:${per100(candCombo, 4, candTurns)}  5:${per100(candCombo, 5, candTurns)}  6+:${sixPlus(candCombo, candTurns)}`
  );
  console.log(
    `  baseline 3:${per100(baseCombo, 3, baseTurns)}  4:${per100(baseCombo, 4, baseTurns)}  5:${per100(baseCombo, 5, baseTurns)}  6+:${sixPlus(baseCombo, baseTurns)}`
  );
  console.log(`  参考: 人間 size5=9.8 / 現状AI self-play size5=2.8（/100手番）`);
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
