/**
 * tempoLatticeAI vs tempoFastAI の対戦評価 + コンボ分布 + 得点ペース（20 点到達の速さ・手番効率）。
 *
 * 仮説検証（E3 / Gen-11 候補）: 「人間戦略『5色で5コンボを最速で組む（4スロットで完成・1スロットは
 * 捨て札置き場）』を葉の formation 項として符号化した tempoLatticeAI は、現状最強 tempoFastAI に対し
 * (1) 人間のように大コンボ・連鎖・効率（size5率/複数発火率/手番効率）を増やすか、(2) self-play で勝てるか？」
 *
 *   候補 = tempoLatticeAI を 1 席（rotate）、baseline = tempoFastAI を 3 席。
 *   候補席の勝率 + Wilson 95% CI（公平基準 0.25）と、両者の発火サイズ分布（size3/4/5/6+）・
 *   1 ターン複数発火率・N 点(5/10/15/20)到達ターン・手番あたり得点（効率）を同一対局から比較する。
 *
 * 公平性: 候補・baseline 双方に同じ timeBudget・同じ lookahead（--base-la）を与え、formation 項
 *   だけの効果を切り分ける（--formation-w 0 なら候補は tempoFast と完全一致＝偏り 25% の健全性確認になる）。
 *
 * 使い方:
 *   npx tsx ai/scripts/bench-lattice.ts --games 64 --seed 73001 --budget 400 --base-la 0
 *   npx tsx ai/scripts/bench-lattice.ts --games 64 --seed 73001 --budget 400 --base-la 0 --formation-w 50 --form '{"chainW":6,"layer4W":10}'
 *
 *   --formation-w N   formation 項のマスター係数（既定 30。0 で tempoFast 一致）
 *   --form '<json>'   FormParams を上書きする Partial（triggerW/layerW/chainW/layer4W/colorW/depthTarget/depthPenalty）
 *   --base-la N       候補・baseline 双方の lookaheadTurns（既定 0。探索 regime を揃える）
 *   --opts '<json>'   TempoLatticeOptions をそのまま上書きする escape hatch
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import type { Action, GameState } from '../../src/game/types';
import {
  decideAction as decideLattice,
  DEFAULT_FORM_PARAMS,
  type FormParams,
  type TempoLatticeOptions,
} from '../../src/ai/tempoLatticeAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
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
  /** 1 ターンの発火回数ヒストグラム（index 0..5、5 は 5 回以上）＝連鎖長の分布。 */
  firesHist: number[];
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
  // 各プレイヤーが各閾値に初到達した turnNumber。
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
  let seed = 71001;
  let budget = 400;
  let baseLA = 0;
  let formationW: number | undefined;
  let formJson = '{}';
  let optsJson = '{}';
  const maxSteps = 20000;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--games') games = parseIntArg('--games', argv[++i]);
    else if (k === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (k === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (k === '--base-la') baseLA = parseIntArg('--base-la', argv[++i]);
    else if (k === '--formation-w') formationW = parseIntArg('--formation-w', argv[++i]);
    else if (k === '--form') formJson = argv[++i];
    else if (k === '--opts') optsJson = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }

  const formParams: FormParams = { ...DEFAULT_FORM_PARAMS, ...JSON.parse(formJson) };
  const latticeOpts: TempoLatticeOptions = {
    timeBudgetMs: budget,
    lookaheadTurns: baseLA,
    formParams,
    ...(formationW !== undefined ? { formationW } : {}),
    ...JSON.parse(optsJson),
  };

  const candidate: Decider = (s, p) => decideLattice(s, p, undefined, latticeOpts);
  const baseline: Decider = (s, p) =>
    decideTempoFast(s, p, undefined, { timeBudgetMs: budget, lookaheadTurns: baseLA });

  const formDiff = Object.fromEntries(
    (Object.keys(formParams) as (keyof FormParams)[])
      .filter((kk) => formParams[kk] !== DEFAULT_FORM_PARAMS[kk])
      .map((kk) => [kk, formParams[kk]])
  );
  console.error(
    `[bench-lattice] cand=tempoLattice(formationW=${latticeOpts.formationW ?? 30}, ` +
      `LA=${baseLA}, form=${JSON.stringify(formDiff)}) vs base=tempoFast(LA=${baseLA},budget=${budget}) | games=${games} seed=${seed} (1 席 vs 3 席 rotate)`
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
    `強さ: tempoLattice 席 勝率 ${(winRate * 100).toFixed(1)}% (CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}%) vs 公平25%  [${candWins}/${games}]`
  );
  const verdict = ci.low > 0.25 ? '有意に強い' : ci.high < 0.25 ? '有意に弱い' : 'parity（差なし）';
  console.log(`判定: ${verdict}`);
  console.log(`順位分布(cand席) 1位:${candRank[0]} 2位:${candRank[1]} 3位:${candRank[2]} 4位:${candRank[3]}`);

  console.log(`\nコンボサイズ別（手番100あたり）:`);
  console.log(
    `  tempoLattice 3:${per100(cand, 3)}  4:${per100(cand, 4)}  5:${per100(cand, 5)}  6+:${sixPlus(cand)}`
  );
  console.log(
    `  tempoFast     3:${per100(base, 3)}  4:${per100(base, 4)}  5:${per100(base, 5)}  6+:${sixPlus(base)}`
  );
  console.log(`  参考: 人間 size5=9.8 / 現状AI self-play size5=2.8（/100手番）`);
  console.log(`\n1ターン複数発火率（連鎖カスケードの直接指標, 自席ターンのうち2回以上発火した割合）:`);
  console.log(`  tempoLattice ${multiPct(cand)}%  (${cand.multiFireTurns}/${cand.playerTurns} ターン)`);
  console.log(`  tempoFast     ${multiPct(base)}%  (${base.multiFireTurns}/${base.playerTurns} ターン)`);
  const histStr = (side: SideStat) =>
    side.firesHist.map((c, i) => `${i === 5 ? '5+' : i}:${c}`).join('  ');
  console.log(`\n1ターンの発火回数ヒストグラム（連鎖長の分布。狙い=「1(小発火)を抑え・0で溜め・たまに5+」）:`);
  console.log(`  tempoLattice  ${histStr(cand)}`);
  console.log(`  tempoFast     ${histStr(base)}`);

  console.log(`\n得点ペース（N点到達の平均turnNumber、小さいほど速い／到達席数）:`);
  console.log(`        tempoLattice         tempoFast`);
  for (const th of THRESHOLDS) {
    console.log(
      `  ${String(th).padStart(2)}点  ${avgReach(cand, th)} (${reachN(cand, th)}席)        ${avgReach(base, th)} (${reachN(base, th)}席)`
    );
  }
  console.log(
    `\n手番あたり得点（効率）: tempoLattice ${(cand.scoreSum / Math.max(1, cand.turns)).toFixed(3)}   tempoFast ${(base.scoreSum / Math.max(1, base.turns)).toFixed(3)}`
  );
  console.log(`  参考: 人間 2.81 / AI 1.74（人間棋譜分析）`);
  console.log(
    `平均スコア: tempoLattice席 ${(cand.scoreSum / games).toFixed(2)}点  tempoFast席 ${(base.scoreSum / (games * 3)).toFixed(2)}点  平均終了ターン ${(endTurnSum / games).toFixed(1)}  未完了 ${unfinished}局`
  );
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
