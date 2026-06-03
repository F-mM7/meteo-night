/**
 * _feature_mine ― 「ML を戦略の顕微鏡に使う」実験。
 *
 * 自己対戦データ（局面ごとの特徴ベクトル + 最終勝敗）を集め、各特徴が勝敗を予測する力を
 *   (1) 単変量の点双列相関（勝者平均 vs 敗者平均）
 *   (2) 全特徴の標準化ロジスティック回帰係数（他特徴を制御した独立寄与）
 * で測る。狙いは **既存評価関数に無い長期/戦略特徴（NEW_*）が勝敗を独立に予測するか** を見ること。
 * predictive なら「評価関数に足す価値あり」の候補 → 別途 evaluator に特徴として追加し smart 非依存ベンチで検証する。
 *
 * 既知 dead-end の「価値学習」 とは別物: あちらは黒箱の値で葉を置換（探索が誤差を補正し無効）。
 * ここは **解釈可能な特徴を発掘して手で評価に足す前段の分析**（地平を越えた長期概念を狙う）。
 *
 * 例: npx tsx ai/scripts/_feature_mine.ts --games 200 --seed 90001 --budget 80
 */
import { setupGame } from '../../src/game/setup';
import { stepGame } from '../../src/game/reducer';
import { type Color, type GameState } from '../../src/game/types';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { parseIntArg, currentActorId } from './_runner';
import { writeFileSync, readFileSync } from 'node:fs';

const SLOTS = 5;
const THRESHOLD = 20;

/** ある局面 state における player pid の特徴ベクトル（名前付き）。NEW_* は現評価に無い長期/戦略特徴。 */
function playerFeatures(state: GameState, pid: number): Record<string, number> {
  const me = state.players[pid];
  const others = state.players.filter((p) => p.id !== pid);

  const topCount = new Map<Color, number>();
  const nearTop = new Map<Color, number>();
  let chainSeeds = 0, totalCards = 0, maxH = 0, minH = Infinity, emptySlots = 0;
  for (const slot of me.board.slots) {
    const n = slot.stack.length;
    totalCards += n;
    if (n > maxH) maxH = n;
    if (n < minH) minH = n;
    if (n === 0) { emptySlots++; minH = 0; continue; }
    const top = slot.stack[n - 1];
    topCount.set(top.color, (topCount.get(top.color) ?? 0) + 1);
    const near = new Set<Color>([top.color]);
    if (n >= 2) near.add(slot.stack[n - 2].color);
    for (const c of near) nearTop.set(c, (nearTop.get(c) ?? 0) + 1);
    if (n >= 2 && slot.stack[n - 2].color === top.color) chainSeeds++;
  }
  if (minH === Infinity) minH = 0;

  let reachMax = 0, reach2 = 0, reach3 = 0, reach4 = 0;
  for (const c of topCount.values()) {
    if (c > reachMax) reachMax = c;
    if (c >= 2) reach2++;
    if (c >= 3) reach3++;
    if (c >= 4) reach4++;
  }

  // まだ引ける色供給（山札 + 公開場）。地平の先の連鎖実現性に効く。
  const supply = new Map<Color, number>();
  for (const c of state.deck) supply.set(c.color, (supply.get(c.color) ?? 0) + 1);
  for (const pair of state.field) if (pair) for (const c of pair) supply.set(c.color, (supply.get(c.color) ?? 0) + 1);

  let chainCeiling = 0, bestColorSupply = 0, bestNear = 0;
  for (const [c, near] of nearTop) {
    if (near > bestNear) { bestNear = near; bestColorSupply = supply.get(c) ?? 0; }
    const ceil = Math.min(SLOTS, near + (supply.get(c) ?? 0));
    if (ceil > chainCeiling) chainCeiling = ceil;
  }

  let maxOppScore = 0, maxOppReach = 0, maxOppNearTop = 0;
  for (const o of others) {
    if (o.score > maxOppScore) maxOppScore = o.score;
    const oTop = new Map<Color, number>();
    const oNear = new Map<Color, number>();
    for (const slot of o.board.slots) {
      const n = slot.stack.length; if (n === 0) continue;
      const t = slot.stack[n - 1];
      oTop.set(t.color, (oTop.get(t.color) ?? 0) + 1);
      const near = new Set<Color>([t.color]);
      if (n >= 2) near.add(slot.stack[n - 2].color);
      for (const cc of near) oNear.set(cc, (oNear.get(cc) ?? 0) + 1);
    }
    for (const v of oTop.values()) if (v > maxOppReach) maxOppReach = v;
    for (const v of oNear.values()) if (v > maxOppNearTop) maxOppNearTop = v;
  }

  const scoreLead = me.score - maxOppScore;
  const distToMyTurn = (pid - state.currentPlayerIndex + state.players.length) % state.players.length;
  let fieldMatch = 0;
  for (const pair of state.field) if (pair) for (const card of pair) {
    if ((topCount.get(card.color) ?? 0) >= 2) fieldMatch++;
  }

  // 戦略分析(サブエージェント)由来の地平超え候補
  const seatDist = (pid - state.startPlayerIndex + state.players.length) % state.players.length;
  let lowSlots = 0;
  for (const slot of me.board.slots) if (slot.stack.length <= 1) lowSlots++;
  const basePts = (n: number) => (n >= 6 ? 15 : n === 5 ? 10 : n === 4 ? 3 : n === 3 ? 1 : 0);
  let realizableEndScore = 0, reachClosable = 0, bigReachReady = 0;
  for (const [c, t] of topCount) {
    if (t >= 4) bigReachReady++;
    if (t >= 3 && (supply.get(c) ?? 0) > 0) reachClosable++;
    if (state.endTriggered && t >= 3) realizableEndScore += basePts(t);
  }
  const winSpeed = reach3 + reach4; // 完成間近の連鎖数＝得点速度 proxy

  return {
    // 既存評価系（baseline）
    score: me.score,
    reachMax,
    reach2plus: reach2,
    reach3plus: reach3,
    reach4plus: reach4,
    chainSeeds,
    totalCards,
    stackSpread: maxH - minH,
    emptySlots,
    nearTopConc: bestNear,
    // NEW_*: 現評価に無い長期/戦略特徴
    NEW_scoreLead: scoreLead,
    NEW_gapToLeader: Math.max(0, -scoreLead),
    NEW_isLeader: scoreLead >= 0 ? 1 : 0,
    NEW_chainCeiling: chainCeiling,
    NEW_bestColorSupply: bestColorSupply,
    NEW_maxOppScore: maxOppScore,
    NEW_maxOppReach: maxOppReach,
    NEW_maxOppNearTop: maxOppNearTop,
    NEW_oppNearWin: maxOppScore / THRESHOLD,
    NEW_deckRemaining: state.deck.length,
    NEW_turnNumber: state.turnNumber,
    NEW_distToMyTurn: distToMyTurn,
    NEW_fieldMatch: fieldMatch,
    NEW_distinctColors: topCount.size,
    NEW_scoreToWin: THRESHOLD - me.score,
    NEW_seatDist: seatDist,
    NEW_lowSlots: lowSlots,
    NEW_realizableEndScore: realizableEndScore,
    NEW_reachClosable: reachClosable,
    NEW_bigReachReady: bigReachReady,
    NEW_winSpeed: winSpeed,
  };
}

interface Row { f: Record<string, number>; pid: number; didWin: number; turn: number; }

function genGame(seed: number, budget: number): Row[] {
  let state = setupGame({ seed, playerNames: ['p0', 'p1', 'p2', 'p3'], cpuFlags: [true, true, true, true] });
  const decider = (s: GameState, pid: number) => decideTempoFast(s, pid, undefined, { lookaheadTurns: 0, timeBudgetMs: budget });
  const rows: Row[] = [];
  let lastTurn = -1, steps = 0;
  const MAX = 20000;
  while (state.phase !== 'gameOver' && steps < MAX) {
    if (state.phase === 'awaitingDraw' && state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      for (let pid = 0; pid < 4; pid++) rows.push({ f: playerFeatures(state, pid), pid, didWin: 0, turn: state.turnNumber });
    }
    const actorId = currentActorId(state);
    const action = decider(state, actorId);
    if (!action) break;
    const before = state;
    state = stepGame(state, action);
    if (state === before) break;
    steps++;
  }
  if (state.phase !== 'gameOver' || state.winnerId === null) return [];
  for (const r of rows) r.didWin = r.pid === state.winnerId ? 1 : 0;
  return rows;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

// 標準化ロジスティック回帰（バッチ GD + L2）。返り値は [bias, w1..wd]（標準化特徴上の係数）。
function logreg(Z: number[][], y: number[], iters: number, lr: number, l2: number): number[] {
  const n = Z.length, d = Z[0].length;
  const w = new Array<number>(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const grad = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * Z[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const e = p - y[i];
      grad[0] += e;
      for (let j = 0; j < d; j++) grad[j + 1] += e * Z[i][j];
    }
    w[0] -= lr * grad[0] / n;
    for (let j = 0; j < d; j++) w[j + 1] -= lr * (grad[j + 1] / n + l2 * w[j + 1]);
  }
  return w;
}

// 行集合に対して 単変量相関 + 標準化ロジスティック回帰係数 を出す（部分集合の再利用用）。
function analyze(rows: Row[], title: string): void {
  if (rows.length < 80) { console.log(`\n##### ${title}: ${rows.length} rows（少なすぎ・スキップ）#####`); return; }
  const names = Object.keys(rows[0].f);
  const y = rows.map((r) => r.didWin);
  const winN = y.reduce((a, b) => a + b, 0);
  const cols: Record<string, number[]> = {};
  for (const nm of names) cols[nm] = rows.map((r) => r.f[nm]);
  const keep: string[] = [];
  const Zcols: number[][] = [];
  for (const nm of names) {
    const x = cols[nm];
    const m = x.reduce((a, b) => a + b, 0) / x.length;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / x.length);
    if (sd === 0) continue;
    keep.push(nm);
    Zcols.push(x.map((v) => (v - m) / sd));
  }
  const Z = rows.map((_, i) => keep.map((__, k) => Zcols[k][i]));
  const w = logreg(Z, y, 600, 0.3, 1e-3);
  const stats = keep.map((nm, k) => {
    const x = cols[nm];
    const r = pearson(x, y);
    let sw = 0, cw = 0, sl = 0, cl = 0;
    for (let i = 0; i < x.length; i++) { if (y[i] === 1) { sw += x[i]; cw++; } else { sl += x[i]; cl++; } }
    return { nm, corr: r, meanWin: cw ? sw / cw : 0, meanLose: cl ? sl / cl : 0, coef: w[k + 1] };
  });
  const fmt = (n: number) => (n >= 0 ? ' ' : '') + n.toFixed(3);
  console.log(`\n##### ${title}: n=${rows.length} win=${winN} (${(winN / rows.length * 100).toFixed(1)}%) #####`);
  console.log('-- NEW_* 独立寄与(|coef|降順): coef / corr / 勝平均・敗平均 --');
  for (const s of stats.filter((s) => s.nm.startsWith('NEW_')).sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)))
    console.log(`${s.nm.padEnd(22)} coef=${fmt(s.coef)} corr=${fmt(s.corr)} w/l=${fmt(s.meanWin)}/${fmt(s.meanLose)}`);
  console.log('-- 全特徴 |coef|降順 top10 --');
  for (const s of [...stats].sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)).slice(0, 10))
    console.log(`${s.nm.padEnd(22)} coef=${fmt(s.coef)} corr=${fmt(s.corr)}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  let games = 200, seed = 90001, budget = 80, loadPath = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') games = parseIntArg('--games', argv[++i]);
    else if (argv[i] === '--seed') seed = parseIntArg('--seed', argv[++i]);
    else if (argv[i] === '--budget') budget = parseIntArg('--budget', argv[++i]);
    else if (argv[i] === '--load') loadPath = argv[++i] ?? '';
    else throw new Error(`unknown arg: ${argv[i]}`);
  }

  let allRows: Row[];
  if (loadPath) {
    allRows = JSON.parse(readFileSync(loadPath, 'utf8')) as Row[];
    console.error(`[feature_mine] loaded ${allRows.length} rows from ${loadPath}`);
  } else {
    console.error(`[feature_mine] games=${games} seed=${seed} budget=${budget} (tempoFast LA=0 自己対戦)`);
    allRows = [];
    let finished = 0;
    const t0 = Date.now();
    for (let g = 0; g < games; g++) {
      const r = genGame(seed + g, budget);
      if (r.length > 0) { finished++; allRows.push(...r); }
      if ((g + 1) % 25 === 0) console.error(`  ${g + 1}/${games} games, ${allRows.length} rows, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    console.error(`finished=${finished}/${games} rows=${allRows.length}`);
    writeFileSync('/tmp/mine-rows.json', JSON.stringify(allRows));
    console.error('rows saved to /tmp/mine-rows.json');
  }
  analyze(allRows, 'ALL rows');
  const mxScore = (r: Row) => Math.max(r.f.score, r.f.NEW_maxOppScore);
  analyze(allRows.filter((r) => mxScore(r) >= 14), 'ENDGAME (maxScore>=14)');
  analyze(allRows.filter((r) => mxScore(r) >= 12 && Math.abs(r.f.NEW_scoreLead) <= 2), 'CLOSE+late (maxScore>=12 & |lead|<=2)');
}

main();
