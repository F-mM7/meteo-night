/**
 * 順位期待値目的の配り（rankObjective・ワークストリーム B）の【screening】（160 局・band 111001-111159）。
 * 候補 1 席＝GRM 配信構成（V=20, P*=0.45, K=6, budget=3000ms）＋ rankObjective、基準 3 席＝同・rankObjective off。
 * 事前宣言: 点推定 ≥28%（読み合い 25.0% parity を明確に超える線）を screening 通過条件とする。
 * 正規 fresh（35001+）は touch しない。本 screening は仮判定のみ（確証 fresh は別ウェーブ）。
 *
 * 例: npx tsx ai/scripts/_rank_gift_screen.ts --games 160 --seed 111001
 */
import { pathToFileURL } from 'node:url';
import { runGrmMatch } from './bench-grm';
import { GRM_P_STAR, rankGiftStats, resetRankGiftStats, type GrmOptions } from '../../src/ai/grmAI';
import { wilsonInterval } from './stats';

function intArg(argv: string[], name: string, def: number): number {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`${name} requires an integer`);
  return v;
}

function main(): void {
  const argv = process.argv.slice(2);
  const games = intArg(argv, '--games', 160);
  const seed = intArg(argv, '--seed', 111001);

  // 候補 = 配信構成 + rankObjective。基準 (--base grm) は runGrmMatch 内で配信構成 GRM。
  const cand: GrmOptions = {
    V: 20,
    P: GRM_P_STAR,
    H: 1,
    K: 6,
    timeBudgetMs: 3000,
    giftPolicy: { rankObjective: true },
  };

  resetRankGiftStats();
  process.stderr.write(
    `[screen] rankGift screening: 候補=GRM(配信構成+rankObjective) vs 基準=GRM(配信構成) | games=${games} band ${seed}-${seed + games - 1}\n`
  );

  const res = runGrmMatch({
    games,
    seed,
    budget: 0,
    maxSteps: 20000,
    grmOptions: cand,
    base: 'grm',
    onProgress: (done, wins, sec) => {
      const ci = wilsonInterval(wins, done);
      process.stderr.write(
        `[screen] ${done}/${games} | wins=${wins} (${((100 * wins) / done).toFixed(1)}%, CI ${(100 * ci.low).toFixed(1)}-${(100 * ci.high).toFixed(1)}) | ${sec.toFixed(0)}s\n`
      );
    },
  });

  const ci = wilsonInterval(res.grmWins, res.games);
  const rg = rankGiftStats();
  const out = {
    line: 'rankGift screening (ワークストリーム B・OBJECTIVE §5-1)',
    band: `${seed}-${seed + games - 1}`,
    games: res.games,
    grmWins: res.grmWins,
    winRatePct: +(100 * res.grmWinRate).toFixed(2),
    ci95Pct: { low: +(100 * ci.low).toFixed(2), high: +(100 * ci.high).toFixed(2) },
    fairBaselinePct: 25,
    grmAvgScore: res.grmAvgScore,
    baseAvgScore: res.baseAvgScore,
    grmRankDist: res.grmRankDist,
    unfinishedGames: res.unfinishedGames,
    rankGiftDecisions: rg.decisions,
    rankGiftDiverged: rg.diverged,
    activationRatePct: rg.decisions > 0 ? +((100 * rg.diverged) / rg.decisions).toFixed(2) : 0,
    screenGate: '点推定 ≥28% で fresh 確証（別ウェーブ）を検討。<28% は parity 域で見送り。',
    pass28: 100 * res.grmWinRate >= 28,
    elapsedSec: res.elapsedSec,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
