/**
 * bench-grm ― 新 CPU AI「GRM（目標到達確率最大化法）」を現状最強 tempoFast と対戦させて強さを測る。
 *
 * GRM を候補として 1 席に置き、残り 3 席を tempoFast（現状最強 baseline）にする。
 * 席は毎ゲーム回転（grmSeat = g % 4, 公平基準勝率 25%）。物差しは smart 非依存
 * （現状最強 self との相対）なので、評価関数の盲点を共有して検出不能になる問題がない。
 *
 * GRM 本体は src/ai/grmAI.ts（別途実装中。下記シグネチャを想定）:
 *   export function decideAction(state, playerId, seed?, options?: GrmOptions): Action | null;
 *   export interface GrmOptions { V?; P?; H?; K?; maxNodes?; }
 *
 * 例:
 *   npx tsx ai/scripts/bench-grm.ts --games 24 --seed 5001 --budget 200 --V 20 --P 0.8 --H 1 --K 7
 *
 * 出力: GRM の勝率（公平基準 25%）、Wilson 95%CI、GRM 平均スコア、baseline 平均スコア、
 *       GRM 順位分布 [1位,2位,3位,4位]、未完了ゲーム数。最終結果は JSON を stdout、進捗・判定は stderr。
 */
import { pathToFileURL } from 'node:url';
import { playOneGameWithDeciders, parseIntArg, parseFloatArg, type Decider } from './_runner';
import { decideAction as decideGrm, GRM_P_STAR, type GrmOptions } from '../../src/ai/grmAI';
import { decideAction as decideTempoFast } from '../../src/ai/tempoFastAI';
import { decideAction as decideTempoChain } from '../../src/ai/tempoChainAI';
import { wilsonInterval } from './stats';

/** baseline の種類: fast=tempoFast(LA=1, budget) / chain=旧既定 tempoChain(DEFAULT_GENOME) /
 * grm=GRM 配信構成（V=20, P=P*, K=6, budget=3000ms）＝L2 逸脱テスト（OBJECTIVE.md）の基準席。 */
export type GrmBaseline = 'fast' | 'chain' | 'grm';

/** L2 逸脱テスト（self-play 不動点）の基準席構成。配信 wrapper と同一に保つ。 */
const GRM_BASELINE_OPTIONS: GrmOptions = { V: 20, P: GRM_P_STAR, H: 1, K: 6, timeBudgetMs: 3000 };

export interface BenchGrmArgs {
  games: number;
  seed: number;
  budget: number;
  maxSteps: number;
  V: number;
  P: number;
  H: number;
  K: number;
  base: GrmBaseline;
  /** GRM 側の 1 決定あたり壁時計予算（ms）。0 = 無制限（従来挙動）。 */
  grmBudget: number;
  /** 山札チャネルの 15 パターン期待値化（SPEED-PLAN 5b）を有効化。 */
  deck15: boolean;
}

export const BENCH_GRM_DEFAULTS: BenchGrmArgs = {
  games: 24,
  seed: 5001,
  budget: 200,
  maxSteps: 20000,
  V: 20,
  P: 0.8,
  H: 1,
  K: 7,
  base: 'fast',
  grmBudget: 0,
  deck15: false,
};

export function parseBenchGrmArgs(argv: string[]): BenchGrmArgs {
  const a: BenchGrmArgs = { ...BENCH_GRM_DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--games':
        a.games = parseIntArg('--games', argv[++i]);
        break;
      case '--seed':
        a.seed = parseIntArg('--seed', argv[++i]);
        break;
      case '--budget':
        a.budget = parseIntArg('--budget', argv[++i]);
        break;
      case '--max-steps':
        a.maxSteps = parseIntArg('--max-steps', argv[++i]);
        break;
      case '--V':
        a.V = parseIntArg('--V', argv[++i]);
        break;
      case '--P':
        a.P = parseFloatArg('--P', argv[++i]);
        break;
      case '--H':
        a.H = parseIntArg('--H', argv[++i]);
        break;
      case '--K':
        a.K = parseIntArg('--K', argv[++i]);
        break;
      case '--base': {
        const v = argv[++i];
        if (v !== 'fast' && v !== 'chain' && v !== 'grm') throw new Error('--base requires: fast|chain|grm');
        a.base = v;
        break;
      }
      case '--grm-budget':
        a.grmBudget = parseIntArg('--grm-budget', argv[++i]);
        break;
      case '--deck15':
        a.deck15 = true;
        break;
      default:
        throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

export interface GrmMatchResult {
  games: number;
  grmWins: number;
  grmWinRate: number;
  fairBaseline: number;
  winRateCI95: { low: number; high: number };
  grmAvgScore: number;
  baseAvgScore: number;
  grmRankDist: number[];
  unfinishedGames: number;
  elapsedSec: number;
}

/**
 * GRM 1 席 vs tempoFast（baseline）3 席を席回転で対戦させ、GRM の成績を集計する。
 * sweep-grm-p.ts からも再利用するため関数として切り出す（DRY）。
 * @param grmOptions GRM に渡す GrmOptions（V/P/H/K 等）
 * @param onProgress 進捗コールバック（done ゲーム数, 累積勝数, 経過秒）。8 ゲームごと等に呼ばれる。
 */
export function runGrmMatch(opts: {
  games: number;
  seed: number;
  budget: number;
  maxSteps: number;
  grmOptions: GrmOptions;
  /** 省略時 'fast'（従来互換）。'chain' で現 champion tempoChain(DEFAULT_GENOME) を baseline にする。 */
  base?: GrmBaseline;
  onProgress?: (done: number, grmWins: number, elapsedSec: number) => void;
}): GrmMatchResult {
  const base = opts.base ?? 'fast';
  const baseline: Decider =
    base === 'grm'
      ? (state, pid) => decideGrm(state, pid, undefined, GRM_BASELINE_OPTIONS)
      : base === 'chain'
        ? (state, pid) => decideTempoChain(state, pid)
        : (state, pid) =>
            decideTempoFast(state, pid, undefined, { timeBudgetMs: opts.budget, lookaheadTurns: 1 });
  const candidate: Decider = (state, pid) => decideGrm(state, pid, undefined, opts.grmOptions);

  let grmWins = 0;
  let grmScoreSum = 0;
  let baseScoreSum = 0;
  const grmRankCount = [0, 0, 0, 0];
  let unfinished = 0;
  const t0 = Date.now();

  for (let g = 0; g < opts.games; g++) {
    const grmSeat = g % 4;
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === grmSeat ? candidate : baseline));
    const names = [0, 1, 2, 3].map((s) => (s === grmSeat ? 'grm' : 'base'));
    const r = playOneGameWithDeciders({ seed: opts.seed + g, deciders, names, maxSteps: opts.maxSteps });
    if (r.ranking[grmSeat] === 0) grmWins++;
    grmRankCount[r.ranking[grmSeat]]++;
    grmScoreSum += r.scores[grmSeat];
    for (let s = 0; s < 4; s++) if (s !== grmSeat) baseScoreSum += r.scores[s];
    if (!r.finished) unfinished++;
    if (opts.onProgress && (g + 1) % 8 === 0) {
      opts.onProgress(g + 1, grmWins, (Date.now() - t0) / 1000);
    }
  }

  const winRate = grmWins / opts.games;
  const ci = wilsonInterval(grmWins, opts.games);
  return {
    games: opts.games,
    grmWins,
    grmWinRate: +winRate.toFixed(4),
    fairBaseline: 0.25,
    winRateCI95: { low: +ci.low.toFixed(4), high: +ci.high.toFixed(4) },
    grmAvgScore: +(grmScoreSum / opts.games).toFixed(2),
    baseAvgScore: +(baseScoreSum / (opts.games * 3)).toFixed(2),
    grmRankDist: grmRankCount,
    unfinishedGames: unfinished,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
}

function main(): void {
  const args = parseBenchGrmArgs(process.argv.slice(2));
  const grmOptions: GrmOptions = { V: args.V, P: args.P, H: args.H, K: args.K };
  if (args.grmBudget > 0) grmOptions.timeBudgetMs = args.grmBudget;
  if (args.deck15) grmOptions.deck15 = true;

  const baseName =
    args.base === 'grm'
      ? `GRM(配信構成 P*=${GRM_P_STAR}, budget=3000ms)`
      : args.base === 'chain'
        ? 'tempoChain(DEFAULT_GENOME)'
        : `tempoFast(budget=${args.budget}, LA=1)`;
  const grmName = `GRM(V=${args.V}, P=${args.P}, H=${args.H}, K=${args.K}${args.grmBudget > 0 ? `, budget=${args.grmBudget}ms` : ''}${args.deck15 ? ', deck15' : ''})`;
  console.error(
    `[bench-grm] ${grmName} vs ${baseName} | games=${args.games} seed=${args.seed} (GRM 1 席 vs baseline 3 席, rotate)`
  );

  const res = runGrmMatch({
    games: args.games,
    seed: args.seed,
    budget: args.budget,
    maxSteps: args.maxSteps,
    grmOptions,
    base: args.base,
    onProgress: (done, grmWins, sec) =>
      console.error(`  ${done}/${args.games} done, grmWins=${grmWins}, ${sec.toFixed(0)}s`),
  });

  console.log(JSON.stringify(res, null, 2));

  const { low, high } = res.winRateCI95;
  const verdict =
    low > 0.25
      ? '✅ GRM が有意に強い'
      : high < 0.25
        ? '❌ 有意に弱い'
        : '― 有意差なし';
  console.error(
    `\nGRM 勝率 ${(res.grmWinRate * 100).toFixed(1)}% (CI ${(low * 100).toFixed(1)}-${(high * 100).toFixed(1)}%) vs 公平基準 25%  → ${verdict}`
  );
}

// sweep-grm-p.ts が runGrmMatch を import するため、直接実行されたときのみ main を走らせる
// （無条件実行だと import 側の argv を解析して `unknown arg` で落ちる）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
