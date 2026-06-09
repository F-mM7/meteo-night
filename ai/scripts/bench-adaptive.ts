/**
 * adaptiveBurstAI vs tempoFastAI の対戦評価 + コンボ分布 + 得点ペース（20 点到達の速さ・手番効率）。
 *
 * 仮説検証: 「後半爆発タイミング戦略（序盤は tempoFast と同じく速く得点し、盤面が育った後半だけ
 * 大コンボ・連鎖重視へ切り替える adaptiveBurstAI）は、現状最強の横並べ型 tempoFastAI に self-play で
 * 勝てるか？ また人間のように『20 点到達が速い / 手番効率が高い』を実現するか？」
 *
 *   候補 = adaptiveBurstAI を 1 席（rotate）、baseline = tempoFastAI を 3 席。
 *   候補席の勝率 + Wilson 95% CI（公平基準 0.25）を出す。
 *   同時に、両者の発火サイズ分布（size3/4/5/6+）・1 ターン複数発火率、および
 *   N 点(5/10/15/20)到達の平均ターン数・手番あたり得点（効率）を集計し、analyze-pace.ts 相当の
 *   「候補が tempoFast より速く / 効率よく得点するか」を同一対局から直接比較する。
 *
 * 公平性: 候補・baseline 双方に同じ timeBudget を与え（壁時計依存の非決定性を同条件化）、
 *   baseline の lookahead は --base-la で固定する。adaptiveBurst は own-turn 完全読み（LA 概念なし）
 *   なので、評価切替の効果だけを切り分けたい場合は --base-la 0（探索 regime を揃える）を使う。
 *
 * 使い方:
 *   npx tsx ai/scripts/bench-adaptive.ts --games 64 --seed 71001 --budget 400 --base-la 0
 *   npx tsx ai/scripts/bench-adaptive.ts --games 64 --seed 71001 --budget 400 --base-la 0 --burst-score 13 --late '{"reach5plus":600,"cascade3plus":300}'
 *
 *   --burst-score N      burstScoreThreshold（誰かが N 点で後半開始。既定 12）
 *   --burst-fill  N      burstFillThreshold（自盤面 N 枚で後半。既定 無効）
 *   --burst-turn  N      burstTurnThreshold（turnNumber N で後半。既定 無効）
 *   --late '<json>'      DEFAULT_LATE_WEIGHTS に上書きする Partial<EvalWeights>
 *   --opts '<json>'      AdaptiveBurstOptions をそのまま上書きする escape hatch
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import {
  decideAction as decideAdaptive,
  DEFAULT_LATE_WEIGHTS,
  type AdaptiveBurstOptions,
} from '../../src/ai/adaptiveBurstAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { DEFAULT_WEIGHTS, type EvalWeights } from '../../src/ai/evaluator';
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
  /** 発火サイズ別カウント（size -> 回数）。 */
  combo: Map<number, number>;
  /** ドロー手数（≒手番数）。/100 手番の正規化・効率の分母に使う。 */
  turns: number;
  /** そのプレイヤーが「1 ターンに 2 回以上発火」したターン数（連鎖カスケードの直接指標）。 */
  multiFireTurns: number;
  /** そのプレイヤーの総手番数（ターン数）。multiFireTurns の母数。 */
  playerTurns: number;
  /** 最終スコア合計（効率＝得点/手番 の分子）。 */
  scoreSum: number;
  /** N 点到達 turnNumber の延べリスト（席ごとに 1 件）。小さいほど速い。 */
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
  // 各プレイヤーが各閾値に初到達した turnNumber。
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
  dst.playerTurns += src.playerTurns;
  dst.scoreSum += src.scoreSum;
  for (const [sz, n] of src.combo) dst.combo.set(sz, (dst.combo.get(sz) ?? 0) + n);
  for (const th of THRESHOLDS) dst.reach[th].push(...src.reach[th]);
}

function main(): void {
  const argv = process.argv.slice(2);
  let games = 64;
  let seed = 71001;
  let budget = 400;
  let baseLA = 0;
  let burstScore: number | undefined;
  let burstFill: number | undefined;
  let burstTurn: number | undefined;
  let lateJson = '{}';
  let optsJson = '{}';
  const maxSteps = 20000;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--base-la') baseLA = parseIntArg('--base-la', argv[++i]);
    else if (k === '--burst-score') burstScore = parseIntArg('--burst-score', argv[++i]);
    else if (k === '--burst-fill') burstFill = parseIntArg('--burst-fill', argv[++i]);
    else if (k === '--burst-turn') burstTurn = parseIntArg('--burst-turn', argv[++i]);
    else if (k === '--late') lateJson = argv[++i];
    else if (k === '--opts') optsJson = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }

  const lateWeights: EvalWeights = { ...DEFAULT_LATE_WEIGHTS, ...JSON.parse(lateJson) };
  const adaptiveOpts: AdaptiveBurstOptions = {
    timeBudgetMs: budget,
    lateWeights,
    ...(burstScore !== undefined ? { burstScoreThreshold: burstScore } : {}),
    ...(burstFill !== undefined ? { burstFillThreshold: burstFill } : {}),
    ...(burstTurn !== undefined ? { burstTurnThreshold: burstTurn } : {}),
    ...JSON.parse(optsJson),
  };

  const candidate: Decider = (s, p) => decideAdaptive(s, p, undefined, adaptiveOpts);
  const baseline: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, { timeBudgetMs: budget, lookaheadTurns: baseLA });

  const lateDiff = Object.fromEntries(
    (Object.keys(lateWeights) as (keyof EvalWeights)[])
      .filter((kk) => lateWeights[kk] !== DEFAULT_WEIGHTS[kk])
      .map((kk) => [kk, lateWeights[kk]])
  );
  console.error(
    `[bench-adaptive] cand=adaptiveBurst(burstScore=${adaptiveOpts.burstScoreThreshold ?? 12}` +
      `${burstFill !== undefined ? `,fill=${burstFill}` : ''}${burstTurn !== undefined ? `,turn=${burstTurn}` : ''}` +
      `, late=${JSON.stringify(lateDiff)}) vs base=tempoFast(LA=${baseLA},budget=${budget}) | games=${games} seed=${seed} (1 席 vs 3 席 rotate)`
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

  console.log(`\n=== bench-adaptive 結果 ===`);
  console.log(
    `強さ: adaptiveBurst 席 勝率 ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs 公平25%  [${candWins}/${games}]`
  );
  const verdict = ci.low > 0.25 ? '有意に強い' : ci.high < 0.25 ? '有意に弱い' : 'parity（差なし）';
  console.log(`判定: ${verdict}`);
  console.log(`順位分布(cand席) 1位:${candRank[0]} 2位:${candRank[1]} 3位:${candRank[2]} 4位:${candRank[3]}`);

  console.log(`\nコンボサイズ別（手番100あたり）:`);
  console.log(
    `  adaptiveBurst 3:${per100(cand, 3)}  4:${per100(cand, 4)}  5:${per100(cand, 5)}  6+:${sixPlus(cand)}`
  );
  console.log(
    `  tempoFast     3:${per100(base, 3)}  4:${per100(base, 4)}  5:${per100(base, 5)}  6+:${sixPlus(base)}`
  );
  console.log(`  参考: 人間 size5=9.8 / 現状AI self-play size5=2.8（/100手番）`);
  console.log(`\n1ターン複数発火率（連鎖カスケードの直接指標, 自席ターンのうち2回以上発火した割合）:`);
  console.log(`  adaptiveBurst ${multiPct(cand)}%  (${cand.multiFireTurns}/${cand.playerTurns} ターン)`);
  console.log(`  tempoFast     ${multiPct(base)}%  (${base.multiFireTurns}/${base.playerTurns} ターン)`);

  console.log(`\n得点ペース（N点到達の平均turnNumber、小さいほど速い／到達席数）:`);
  console.log(`        adaptiveBurst         tempoFast`);
  for (const th of THRESHOLDS) {
    console.log(
      `  ${String(th).padStart(2)}点  ${avgReach(cand, th)} (${reachN(cand, th)}席)        ${avgReach(base, th)} (${reachN(base, th)}席)`
    );
  }
  console.log(
    `\n手番あたり得点（効率）: adaptiveBurst ${(cand.scoreSum / Math.max(1, cand.turns)).toFixed(3)}   tempoFast ${(base.scoreSum / Math.max(1, base.turns)).toFixed(3)}`
  );
  console.log(`  参考: 人間 2.81 / AI 1.74（人間棋譜分析）`);
  console.log(
    `平均スコア: adaptiveBurst席 ${(cand.scoreSum / games).toFixed(2)}点  tempoFast席 ${(base.scoreSum / (games * 3)).toFixed(2)}点  平均終了ターン ${(endTurnSum / games).toFixed(1)}  未完了 ${unfinished}局`
  );
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
