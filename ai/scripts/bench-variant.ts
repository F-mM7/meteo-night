/**
 * 候補AI変種（E1選択的深化 / E2人間プライア / E3 CRN）を tempoFast と self-play 対戦させる汎用ベンチ。
 *
 * 候補 1 席（rotate）vs baseline=tempoFast 3 席。勝率 + Wilson 95% CI（公平基準25%）に加え、
 * コンボサイズ分布・1ターン複数発火率・得点ペース（N点到達ターン）・手番効率を bench-adaptive と
 * 同形式で出す。公平性のため候補・baseline に同一 budget と（baseline は）lookahead を与える。
 *
 *   npx tsx ai/scripts/bench-variant.ts --ai crn      --games 64 --seed 91001 --budget 1000 --base-la 1
 *   npx tsx ai/scripts/bench-variant.ts --ai human    --games 64 --seed 91001 --budget 1000 --base-la 1
 *   npx tsx ai/scripts/bench-variant.ts --ai selective --games 64 --seed 91001 --budget 1000 --base-la 1 --opts '{"topK":3}'
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { decideAction as decideCrn } from '../../src/ai/tempoCrnAI';
import { decideAction as decideHuman } from '../../src/ai/tempoHumanAI';
import { decideAction as decideSelective } from '../../src/ai/tempoSelectiveAI';
import { decideAction as decideBuild } from '../../src/ai/tempoBuildAI';
import { wilsonInterval } from './stats';
import { currentActorId, parseIntArg } from './_runner';

type Decider = (s: GameState, p: number) => Action | null;
const THRESHOLDS = [5, 10, 15, 20] as const;

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

interface SideStat {
  combo: Map<number, number>;
  turns: number;
  multiFireTurns: number;
  playerTurns: number;
  scoreSum: number;
  reach: Record<number, number[]>;
}

function newSide(): SideStat {
  return { combo: new Map(), turns: 0, multiFireTurns: 0, playerTurns: 0, scoreSum: 0, reach: { 5: [], 10: [], 15: [], 20: [] } };
}

interface GameStat {
  ranking: number[];
  cand: SideStat;
  base: SideStat;
  endTurn: number;
  finished: boolean;
}

function playGame(seed: number, deciders: Decider[], candSeat: number, maxSteps: number): GameStat {
  let state: GameState = setupGame({ seed, cpuFlags: [true, true, true, true] });
  const cand = newSide();
  const base = newSide();
  const n = state.players.length;
  let prevCombo = 0;
  let prevTurnNumber = state.turnNumber;
  let prevActive = state.currentPlayerIndex;
  let firesThisTurn = 0;
  let steps = 0;
  const reached: Record<number, number>[] = state.players.map(() => ({}));

  function flushTurn(active: number): void {
    const side = active === candSeat ? cand : base;
    side.playerTurns++;
    if (firesThisTurn >= 2) side.multiFireTurns++;
    firesThisTurn = 0;
  }

  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actor = currentActorId(state);
    const isCand = actor === candSeat;
    const action = deciders[actor](state, actor);
    if (!action) break;
    if (action.type === 'DRAW_FROM_FIELD' || action.type === 'DRAW_FROM_DECK') {
      if (isCand) cand.turns++;
      else base.turns++;
    }
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    if (state.turnNumber !== prevTurnNumber) {
      flushTurn(prevActive);
      prevTurnNumber = state.turnNumber;
      prevActive = state.currentPlayerIndex;
    }
    const cur = state.turn.combosThisTurn;
    if (cur.length > prevCombo) {
      const side = isCand ? cand : base;
      for (let k = prevCombo; k < cur.length; k++) {
        side.combo.set(cur[k].cards.length, (side.combo.get(cur[k].cards.length) ?? 0) + 1);
        firesThisTurn++;
      }
    }
    prevCombo = cur.length;
    for (let pid = 0; pid < n; pid++) {
      const sc = state.players[pid].score;
      for (const th of THRESHOLDS) if (sc >= th && reached[pid][th] === undefined) reached[pid][th] = state.turnNumber;
    }
    steps++;
  }
  flushTurn(prevActive);
  for (let pid = 0; pid < n; pid++) {
    const side = pid === candSeat ? cand : base;
    side.scoreSum += state.players[pid].score;
    for (const th of THRESHOLDS) if (reached[pid][th] !== undefined) side.reach[th].push(reached[pid][th]);
  }
  return { ranking: computeRanking(state), cand, base, endTurn: state.turnNumber, finished: state.phase === 'gameOver' };
}

function mergeSide(dst: SideStat, src: SideStat): void {
  dst.turns += src.turns;
  dst.multiFireTurns += src.multiFireTurns;
  dst.playerTurns += src.playerTurns;
  dst.scoreSum += src.scoreSum;
  for (const [sz, n] of src.combo) dst.combo.set(sz, (dst.combo.get(sz) ?? 0) + n);
  for (const th of THRESHOLDS) dst.reach[th].push(...src.reach[th]);
}

function main(): void {
  const argv = process.argv.slice(2);
  let ai = '';
  let games = 64;
  let seed = 91001;
  let budget = 1000;
  let baseLA = 1;
  let optsJson = '{}';
  const maxSteps = 20000;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--ai') ai = argv[++i];
    else if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--base-la') baseLA = parseIntArg('--base-la', argv[++i]);
    else if (k === '--opts') optsJson = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  const opts = { timeBudgetMs: budget, ...JSON.parse(optsJson) };
  let candidate: Decider;
  if (ai === 'crn') candidate = (s, p) => decideCrn(s, p, undefined, { lookaheadTurns: 1, ...opts });
  else if (ai === 'human') candidate = (s, p) => decideHuman(s, p, undefined, { lookaheadTurns: 1, ...opts });
  else if (ai === 'selective') candidate = (s, p) => decideSelective(s, p, undefined, opts);
  else if (ai === 'build') candidate = (s, p) => decideBuild(s, p, undefined, opts);
  else throw new Error(`--ai は crn|human|selective|build のいずれか（got: ${ai}）`);
  const baseline: Decider = (s, p) => decideTempoFast(s, p, undefined, { timeBudgetMs: budget, lookaheadTurns: baseLA });

  console.error(`[bench-variant] cand=${ai}(${JSON.stringify(opts)}) vs base=tempoFast(LA=${baseLA},budget=${budget}) | games=${games} seed=${seed}`);

  let candWins = 0;
  let endTurnSum = 0;
  let unfinished = 0;
  const candRank = [0, 0, 0, 0];
  const cand = newSide();
  const base = newSide();
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const candSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    const r = playGame(seed + g, deciders, candSeat, maxSteps);
    if (r.ranking[candSeat] === 0) candWins++;
    candRank[r.ranking[candSeat]]++;
    mergeSide(cand, r.cand);
    mergeSide(base, r.base);
    endTurnSum += r.endTurn;
    if (!r.finished) unfinished++;
    if ((g + 1) % 2 === 0 || g === games - 1) {
      console.error(`  進捗 ${g + 1}/${games}  cand勝ち=${candWins}  経過${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const ci = wilsonInterval(candWins, games);
  const per100 = (side: SideStat, sz: number) => (side.turns === 0 ? ' 0.0' : (((side.combo.get(sz) ?? 0) / side.turns) * 100).toFixed(1).padStart(5));
  const sixPlus = (side: SideStat) => {
    let s = 0;
    for (const [kk, nn] of side.combo) if (kk >= 6) s += nn;
    return side.turns === 0 ? ' 0.0' : ((s / side.turns) * 100).toFixed(1).padStart(5);
  };
  const avgReach = (side: SideStat, th: number) => (side.reach[th].length === 0 ? '  -  ' : (side.reach[th].reduce((a, b) => a + b, 0) / side.reach[th].length).toFixed(1).padStart(5));

  console.log(`\n=== bench-variant 結果: ${ai} ===`);
  console.log(`強さ: ${ai} 席 勝率 ${(100 * candWins / games).toFixed(1)}% (CI ${(100 * ci.low).toFixed(1)}-${(100 * ci.high).toFixed(1)}%) vs 公平25%  [${candWins}/${games}]`);
  console.log(`判定: ${ci.low > 0.25 ? '有意に強い' : ci.high < 0.25 ? '有意に弱い' : 'parity（差なし）'}`);
  console.log(`順位分布(cand席) 1位:${candRank[0]} 2位:${candRank[1]} 3位:${candRank[2]} 4位:${candRank[3]}`);
  console.log(`\nコンボサイズ別（手番100あたり）:`);
  console.log(`  ${ai.padEnd(9)} 3:${per100(cand, 3)}  4:${per100(cand, 4)}  5:${per100(cand, 5)}  6+:${sixPlus(cand)}`);
  console.log(`  tempoFast 3:${per100(base, 3)}  4:${per100(base, 4)}  5:${per100(base, 5)}  6+:${sixPlus(base)}`);
  console.log(`\n得点ペース（N点到達の平均turnNumber, 小さいほど速い／到達席数）:`);
  console.log(`        ${ai}              tempoFast`);
  for (const th of THRESHOLDS) {
    console.log(`  ${String(th).padStart(2)}点  ${avgReach(cand, th)} (${cand.reach[th].length}席)        ${avgReach(base, th)} (${base.reach[th].length}席)`);
  }
  console.log(`\n手番あたり得点（効率）: ${ai} ${(cand.scoreSum / Math.max(1, cand.turns)).toFixed(3)}   tempoFast ${(base.scoreSum / Math.max(1, base.turns)).toFixed(3)}`);
  console.log(`平均スコア: ${ai}席 ${(cand.scoreSum / games).toFixed(2)}  tempoFast席 ${(base.scoreSum / (games * 3)).toFixed(2)}  平均終了ターン ${(endTurnSum / games).toFixed(1)}  未完了 ${unfinished}局`);
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
