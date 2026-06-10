/**
 * tempoChainAI(genome 指定) vs tempoFastAI の詳細ベンチ。
 * bench-fivechain.ts の集計機構（コンボサイズ別・1ターン発火回数ヒストグラム＝連鎖長分布・
 * 得点ペース・効率）をそのまま流用し、候補ドライバだけを tempoChain genome に差し替えたもの。
 *
 * 確証で勝ち残った genome が「小連鎖(size3)を撃たず size5 以上を出す人間戦略」を実際に実行できて
 * いるかを、champion tempoFast と同一対局で比較検証する。
 *
 * 使い方:
 *   npx tsx ai/scripts/bench-tempochain.ts --idx 340 --games 64 --seed 75001 --base-la 0
 *   npx tsx ai/scripts/bench-tempochain.ts --genome '{"fireTarget":5,...}' --games 48 --seed 75001 --base-la 1
 *
 *   --idx N           grid jsonl から idx で genome を引く（--grid-prefix 既定 /tmp/opt-grid）
 *   --genome '<json>' genome を直接指定（--idx より優先）
 *   --base-la N       baseline tempoFast の lookaheadTurns（既定0。1で実体champion）
 *   --budget N        baseline tempoFast の timeBudgetMs（既定300）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import { decideAction as decideTempoChain, type TempoChainGenome } from '../../src/ai/tempoChainAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { wilsonInterval } from './stats';
import { currentActorId, parseIntArg } from './_runner';

type Decider = (s: GameState, p: number) => Action | null;

const THRESHOLDS = [5, 10, 15, 20] as const;

function loadGenomeByIdx(gridPrefix: string, idx: number): TempoChainGenome {
  const dir = dirname(gridPrefix);
  const base = basename(gridPrefix);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.jsonl$`);
  for (const f of readdirSync(dir).filter((x) => re.test(x))) {
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { idx: number; genome: TempoChainGenome };
        if (r.idx === idx) return r.genome;
      } catch {
        /* skip */
      }
    }
  }
  throw new Error(`idx=${idx} の genome が ${gridPrefix}-*.jsonl に無い`);
}

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
  firesHist: number[];
  playerTurns: number;
  scoreSum: number;
  reach: Record<number, number[]>;
}

interface GameStat {
  ranking: number[];
  cand: SideStat;
  base: SideStat;
  scores: number[];
  endTurn: number;
  finished: boolean;
}

function newSide(): SideStat {
  return {
    combo: new Map(),
    turns: 0,
    multiFireTurns: 0,
    firesHist: [0, 0, 0, 0, 0, 0],
    playerTurns: 0,
    scoreSum: 0,
    reach: { 5: [], 10: [], 15: [], 20: [] },
  };
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
    side.firesHist[firesThisTurn < 5 ? firesThisTurn : 5]++;
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
        const sz = cur[k].cards.length;
        side.combo.set(sz, (side.combo.get(sz) ?? 0) + 1);
        firesThisTurn++;
      }
    }
    prevCombo = cur.length;

    for (let pid = 0; pid < n; pid++) {
      const sc = state.players[pid].score;
      for (const th of THRESHOLDS) {
        if (sc >= th && reached[pid][th] === undefined) reached[pid][th] = state.turnNumber;
      }
    }
    steps++;
  }
  flushTurn(prevActive);

  for (let pid = 0; pid < n; pid++) {
    const side = pid === candSeat ? cand : base;
    side.scoreSum += state.players[pid].score;
    for (const th of THRESHOLDS) {
      if (reached[pid][th] !== undefined) side.reach[th].push(reached[pid][th]);
    }
  }

  return {
    ranking: computeRanking(state),
    cand,
    base,
    scores: state.players.map((p) => p.score),
    endTurn: state.turnNumber,
    finished: state.phase === 'gameOver',
  };
}

function mergeSide(dst: SideStat, src: SideStat): void {
  dst.turns += src.turns;
  dst.multiFireTurns += src.multiFireTurns;
  for (let i = 0; i < 6; i++) dst.firesHist[i] += src.firesHist[i];
  dst.playerTurns += src.playerTurns;
  dst.scoreSum += src.scoreSum;
  for (const [sz, n] of src.combo) dst.combo.set(sz, (dst.combo.get(sz) ?? 0) + n);
  for (const th of THRESHOLDS) dst.reach[th].push(...src.reach[th]);
}

function main(): void {
  const argv = process.argv.slice(2);
  let games = 64;
  let seed = 75001;
  let budget = 300;
  let baseLA = 0;
  let idx = -1;
  let genomeJson = '';
  let gridPrefix = '/tmp/opt-grid';
  const maxSteps = 20000;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--base-la') baseLA = parseIntArg('--base-la', argv[++i]);
    else if (k === '--idx') idx = parseIntArg('--idx', argv[++i]);
    else if (k === '--genome') genomeJson = argv[++i];
    else if (k === '--grid-prefix') gridPrefix = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  const genome: TempoChainGenome = genomeJson
    ? (JSON.parse(genomeJson) as TempoChainGenome)
    : idx >= 0
      ? loadGenomeByIdx(gridPrefix, idx)
      : (() => {
          throw new Error('--idx か --genome のどちらかが必要');
        })();

  const candidate: Decider = (s, p) => decideTempoChain(s, p, undefined, genome);
  const baseline: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, { timeBudgetMs: budget, lookaheadTurns: baseLA });

  console.error(
    `[bench-tempochain] cand=tempoChain(${JSON.stringify(genome)}) ` +
      `vs base=tempoFast(LA=${baseLA},budget=${budget}) | games=${games} seed=${seed} (1 席 vs 3 席 rotate)`
  );

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
    const elapsed = (Date.now() - t0) / 1000;
    if ((g + 1) % 4 === 0 || g === games - 1) {
      console.error(`  進捗 ${g + 1}/${games}  cand勝ち=${candWins}  経過${elapsed.toFixed(0)}s`);
    }
  }

  const winRate = candWins / games;
  const ci = wilsonInterval(candWins, games);
  const per100 = (side: SideStat, sz: number) =>
    side.turns === 0 ? ' 0.0' : (((side.combo.get(sz) ?? 0) / side.turns) * 100).toFixed(1).padStart(5);
  const sixPlus = (side: SideStat) => {
    let s = 0;
    for (const [kk, nn] of side.combo) if (kk >= 6) s += nn;
    return side.turns === 0 ? ' 0.0' : ((s / side.turns) * 100).toFixed(1).padStart(5);
  };
  const multiPct = (side: SideStat) =>
    side.playerTurns === 0 ? ' 0.0' : ((side.multiFireTurns / side.playerTurns) * 100).toFixed(1).padStart(5);
  const avgReach = (side: SideStat, th: number) =>
    side.reach[th].length === 0
      ? '  -  '
      : (side.reach[th].reduce((a, b) => a + b, 0) / side.reach[th].length).toFixed(1).padStart(5);
  const reachN = (side: SideStat, th: number) => side.reach[th].length;

  console.log(`\n=== bench-tempochain 結果 ===`);
  console.log(
    `強さ: tempoChain 席 勝率 ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs 公平25%  [${candWins}/${games}]`
  );
  const verdict = ci.low > 0.25 ? '有意に強い' : ci.high < 0.25 ? '有意に弱い' : 'parity（差なし）';
  console.log(`判定: ${verdict}`);
  console.log(`順位分布(cand席) 1位:${candRank[0]} 2位:${candRank[1]} 3位:${candRank[2]} 4位:${candRank[3]}`);

  console.log(`\nコンボサイズ別（手番100あたり）:`);
  console.log(
    `  tempoChain 3:${per100(cand, 3)}  4:${per100(cand, 4)}  5:${per100(cand, 5)}  6+:${sixPlus(cand)}`
  );
  console.log(
    `  tempoFast  3:${per100(base, 3)}  4:${per100(base, 4)}  5:${per100(base, 5)}  6+:${sixPlus(base)}`
  );
  console.log(`  参考: 人間 size5=9.8 / 現状AI self-play size5=2.8（/100手番）`);
  console.log(`\n1ターン複数発火率（連鎖カスケードの直接指標, 自席ターンのうち2回以上発火した割合）:`);
  console.log(`  tempoChain ${multiPct(cand)}%  (${cand.multiFireTurns}/${cand.playerTurns} ターン)`);
  console.log(`  tempoFast  ${multiPct(base)}%  (${base.multiFireTurns}/${base.playerTurns} ターン)`);
  const histStr = (side: SideStat) =>
    side.firesHist.map((c, i) => `${i === 5 ? '5+' : i}:${c}`).join('  ');
  console.log(`\n1ターンの発火回数ヒストグラム（連鎖長の分布。狙い=「1(小発火)を抑え・0で溜め・たまに5+」）:`);
  console.log(`  tempoChain  ${histStr(cand)}`);
  console.log(`  tempoFast   ${histStr(base)}`);

  console.log(`\n得点ペース（N点到達の平均turnNumber、小さいほど速い／到達席数）:`);
  console.log(`        tempoChain        tempoFast`);
  for (const th of THRESHOLDS) {
    console.log(
      `  ${String(th).padStart(2)}点  ${avgReach(cand, th)} (${reachN(cand, th)}席)        ${avgReach(base, th)} (${reachN(base, th)}席)`
    );
  }
  console.log(
    `\n手番あたり得点（効率）: tempoChain ${(cand.scoreSum / Math.max(1, cand.turns)).toFixed(3)}   tempoFast ${(base.scoreSum / Math.max(1, base.turns)).toFixed(3)}`
  );
  console.log(`  参考: 人間 2.81 / AI 1.74（人間棋譜分析）`);
  console.log(
    `平均スコア: tempoChain席 ${(cand.scoreSum / games).toFixed(2)}点  tempoFast席 ${(base.scoreSum / (games * 3)).toFixed(2)}点  平均終了ターン ${(endTurnSum / games).toFixed(1)}  未完了 ${unfinished}局`
  );
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
