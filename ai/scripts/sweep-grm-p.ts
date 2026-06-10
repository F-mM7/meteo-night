/**
 * sweep-grm-p ― GRM の目標到達確率 P を複数値でスイープし、それぞれ GRM vs tempoFast の勝率を出して
 * 最良 P を探る（§7 の P フィッティング用）。
 *
 * 各 P について bench-grm と同じ対戦ロジック（GRM 1 席 vs tempoFast 3 席, 席回転, 公平 25%）で
 * 勝率と Wilson CI を計算する。対戦処理は bench-grm.ts の runGrmMatch を import して再利用（DRY）。
 *
 * 例:
 *   npx tsx ai/scripts/sweep-grm-p.ts --games 16 --seed 6001 --budget 200 --Ps 0.5,0.65,0.8,0.9 --V 20 --H 1 --K 7
 *
 * 出力: 各 P の {P, winRate, ci, grmAvgScore} 配列を JSON で stdout。最良 P（勝率最大）を stderr にハイライト。
 */
import { parseIntArg, parseFloatArg } from './_runner';
import { runGrmMatch } from './bench-grm';
import type { GrmOptions } from '../../src/ai/grmAI';

interface SweepArgs {
  games: number;
  seed: number;
  budget: number;
  Ps: number[];
  V: number;
  H: number;
  K: number;
}

const DEFAULT_PS = [0.5, 0.65, 0.8, 0.9];

function parsePsArg(raw: string | undefined): number[] {
  if (raw === undefined) {
    throw new Error('--Ps requires a value');
  }
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('--Ps requires at least one value');
  }
  return parts.map((p, idx) => parseFloatArg(`--Ps[${idx}]`, p));
}

function parseArgs(argv: string[]): SweepArgs {
  const a: SweepArgs = {
    games: 16,
    seed: 6001,
    budget: 200,
    Ps: [...DEFAULT_PS],
    V: 20,
    H: 1,
    K: 7,
  };
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
      case '--Ps':
        a.Ps = parsePsArg(argv[++i]);
        break;
      case '--V':
        a.V = parseIntArg('--V', argv[++i]);
        break;
      case '--H':
        a.H = parseIntArg('--H', argv[++i]);
        break;
      case '--K':
        a.K = parseIntArg('--K', argv[++i]);
        break;
      default:
        throw new Error(`unknown arg: ${k}`);
    }
  }
  return a;
}

interface PResult {
  P: number;
  games: number;
  grmWins: number;
  winRate: number;
  ci: { low: number; high: number };
  grmAvgScore: number;
  baseAvgScore: number;
  grmRankDist: number[];
  unfinishedGames: number;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.error(
    `[sweep-grm-p] Ps=[${args.Ps.join(', ')}] | GRM(V=${args.V}, H=${args.H}, K=${args.K}) vs tempoFast(budget=${args.budget}, LA=1) | games=${args.games} seed=${args.seed}`
  );

  const results: PResult[] = [];
  for (const P of args.Ps) {
    console.error(`\n[sweep-grm-p] P=${P} 対戦中...`);
    const grmOptions: GrmOptions = { V: args.V, P, H: args.H, K: args.K };
    // 各 P で同一 seed・同一席回転にして P 以外の条件を揃える（フェアな比較）。
    const res = runGrmMatch({
      games: args.games,
      seed: args.seed,
      budget: args.budget,
      maxSteps: 20000,
      grmOptions,
      onProgress: (done, grmWins, sec) =>
        console.error(`    P=${P}: ${done}/${args.games} done, grmWins=${grmWins}, ${sec.toFixed(0)}s`),
    });
    results.push({
      P,
      games: res.games,
      grmWins: res.grmWins,
      winRate: res.grmWinRate,
      ci: res.winRateCI95,
      grmAvgScore: res.grmAvgScore,
      baseAvgScore: res.baseAvgScore,
      grmRankDist: res.grmRankDist,
      unfinishedGames: res.unfinishedGames,
    });
    console.error(
      `  → P=${P}: 勝率 ${(res.grmWinRate * 100).toFixed(1)}% (CI ${(res.winRateCI95.low * 100).toFixed(1)}-${(res.winRateCI95.high * 100).toFixed(1)}%)`
    );
  }

  console.log(JSON.stringify({ seed: args.seed, games: args.games, budget: args.budget, results }, null, 2));

  const best = results.reduce((acc, r) => (r.winRate > acc.winRate ? r : acc), results[0]);
  console.error(
    `\n🏆 最良 P = ${best.P}  勝率 ${(best.winRate * 100).toFixed(1)}% (CI ${(best.ci.low * 100).toFixed(1)}-${(best.ci.high * 100).toFixed(1)}%)  vs 公平基準 25%`
  );
}

main();
