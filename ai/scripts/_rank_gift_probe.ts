/**
 * 順位期待値目的の配り（rankObjective・ワークストリーム B）の【発動率プローブ】（診断のみ・勝敗判定なし）。
 *
 * 早期撤退ゲート: rankObjective を on にして数局回し、「順位目的が既定 harm 経路と異なる配りを選んだ割合」
 * （= 発動率）を計測する。発動率 < 5% なら screening に進まず撤退（精液帯＝正規 fresh を焼かない）。
 *
 * 構成: 候補 1 席＝GRM 配信構成（V=20, P*=0.45, K=6）＋ giftPolicy.rankObjective=true、
 *       基準 3 席＝GRM 配信構成（rankObjective off）。screening と同じ席割り（候補 1 vs 現行 3）。
 * 発動率は時間予算に依存しない（配りの選好が harm と一致するかだけ）ので、プローブは予算を絞って高速化する。
 *
 * seed 帯: 110001-110008（8 局・診断専用）。正規 fresh（35001+）は触らない。
 *
 * 例: npx tsx ai/scripts/_rank_gift_probe.ts --games 8 --seed 110001
 * 出力: rankGiftStats（decisions / diverged / 発動率%）を stdout に JSON、進捗は stderr。
 */
import { pathToFileURL } from 'node:url';
import { playOneGameWithDeciders, type Decider } from './_runner';
import { decideAction as decideGrm, GRM_P_STAR, rankGiftStats, resetRankGiftStats, type GrmOptions } from '../../src/ai/grmAI';

/** `--name value` 形式の整数オプションを既定値つきで読む。 */
function intArg(argv: string[], name: string, def: number): number {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`${name} requires an integer, got: ${argv[i + 1]}`);
  return v;
}

// 配信構成（candidate/baseline 共通の土台）。発動率は時間予算非依存なので budget は絞る（高速化）。
const PROBE_BUDGET_MS = 400;
const BASE_OPTIONS: GrmOptions = { V: 20, P: GRM_P_STAR, H: 1, K: 6, timeBudgetMs: PROBE_BUDGET_MS };
const CAND_OPTIONS: GrmOptions = { ...BASE_OPTIONS, giftPolicy: { rankObjective: true } };

function main(): void {
  // 標準出力のバッファリング無効化（即時フラッシュ）
  if (typeof (process.stdout as { setNoDelay?: (b: boolean) => void }).setNoDelay === 'function') {
    (process.stdout as { setNoDelay: (b: boolean) => void }).setNoDelay(true);
  }
  const argv = process.argv.slice(2);
  const games = intArg(argv, '--games', 8);
  const seed = intArg(argv, '--seed', 110001);
  const maxSteps = intArg(argv, '--max-steps', 20000);

  const candidate: Decider = (state, pid) => decideGrm(state, pid, undefined, CAND_OPTIONS);
  const baseline: Decider = (state, pid) => decideGrm(state, pid, undefined, BASE_OPTIONS);

  resetRankGiftStats();
  const t0 = Date.now();
  let unfinished = 0;
  for (let g = 0; g < games; g++) {
    const candSeat = g % 4; // 席回転（screening と同じ公平割り）
    const deciders: Decider[] = [0, 1, 2, 3].map((s) => (s === candSeat ? candidate : baseline));
    const names = [0, 1, 2, 3].map((s) => (s === candSeat ? 'cand' : 'base'));
    const r = playOneGameWithDeciders({ seed: seed + g, deciders, names, maxSteps });
    if (!r.finished) unfinished++;
    const st = rankGiftStats();
    process.stderr.write(
      `[probe] game ${g + 1}/${games} seed=${seed + g} | 累計 decisions=${st.decisions} diverged=${st.diverged} ` +
        `(${st.decisions > 0 ? ((100 * st.diverged) / st.decisions).toFixed(1) : '0.0'}%) | ${((Date.now() - t0) / 1000).toFixed(1)}s\n`
    );
  }

  const st = rankGiftStats();
  const rate = st.decisions > 0 ? st.diverged / st.decisions : 0;
  const out = {
    games,
    seedBand: `${seed}-${seed + games - 1}`,
    unfinishedGames: unfinished,
    rankGiftDecisions: st.decisions,
    rankGiftDiverged: st.diverged,
    activationRatePct: +(100 * rate).toFixed(2),
    gate: '発動率 < 5% なら screening 中止・撤退（正規 fresh 35001+ は焼かない）',
    pass: rate >= 0.05,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
