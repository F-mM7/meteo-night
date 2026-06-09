/**
 * confirm-aggregate.ts ― confirm-tempochain.ts の出力を idx×seed で合算し、
 * 採用判定（Wilson 95% CI 下限 > 25% を fresh seed 2本で再現）を評価する。
 *
 *   npx tsx ai/scripts/confirm-aggregate.ts [prefix=/tmp/confirm]
 *
 * {prefix} で始まる *.jsonl を全て読む（複数 seed・複数シャードを横断）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { wilsonInterval } from './stats';

interface Row {
  idx: number;
  seed: number;
  baseLA: number;
  budget: number;
  wins: number;
  games: number;
  genome: Record<string, unknown>;
}

const CI_THRESH = 0.25;

function fmtGenome(g: Record<string, unknown>): string {
  return `fire=${g.fireTarget} late=${g.lateThreshold}/${g.fireTargetLate} full=${g.fullThreshold} blend=${g.buildTempoBlend} ${g.distanceMode} nl=${g.nodeLimit}`;
}

function main(): void {
  const prefix = process.argv[2] ?? '/tmp/confirm';
  const dir = dirname(prefix);
  const base = basename(prefix);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.jsonl$`);
  const files = readdirSync(dir).filter((f) => re.test(f));
  // (idx,seed,baseLA,budget) ごとに wins/games を合算。
  const groups = new Map<string, Row>();
  for (const f of files) {
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r: Row;
      try {
        r = JSON.parse(line) as Row;
      } catch {
        continue;
      }
      const key = `${r.idx}|${r.seed}|${r.baseLA}|${r.budget}`;
      const cur = groups.get(key);
      if (cur) {
        cur.wins += r.wins;
        cur.games += r.games;
      } else {
        groups.set(key, { ...r });
      }
    }
  }
  if (groups.size === 0) {
    console.log('まだ confirm 結果がありません。');
    return;
  }
  // idx ごとに seed 行をまとめる。
  const byIdx = new Map<number, Row[]>();
  for (const r of groups.values()) {
    const arr = byIdx.get(r.idx) ?? [];
    arr.push(r);
    byIdx.set(r.idx, arr);
  }
  // idx を「全 seed 合算勝率」降順で並べる。
  const idxOrder = [...byIdx.keys()].sort((a, b) => {
    const sum = (rows: Row[]) => rows.reduce((acc, r) => acc + r.wins, 0) / rows.reduce((acc, r) => acc + r.games, 0);
    return sum(byIdx.get(b)!) - sum(byIdx.get(a)!);
  });

  console.log(`=== tempoChain 確証集約 (${files.length} files, ${groups.size} (idx×seed×cfg) groups) ===`);
  console.log(`採用基準: Wilson 95% CI 下限 > ${(CI_THRESH * 100).toFixed(0)}% を fresh seed 2本で再現（各 seed 行に ★）\n`);

  const adopted: number[] = [];
  for (const idx of idxOrder) {
    const rows = byIdx.get(idx)!.sort((a, b) => a.baseLA - b.baseLA || a.seed - b.seed);
    const totW = rows.reduce((a, r) => a + r.wins, 0);
    const totG = rows.reduce((a, r) => a + r.games, 0);
    const genome = rows[0].genome;
    console.log(`idx=${idx}  [${fmtGenome(genome)}]  合算 ${(100 * totW / totG).toFixed(1)}% (${totW}/${totG})`);
    // seed×baseLA 行ごとに CI。
    const la0Seeds = rows.filter((r) => r.baseLA === 0);
    let starCount = 0;
    for (const r of rows) {
      const wr = r.wins / r.games;
      const ci = wilsonInterval(r.wins, r.games);
      const star = ci.low > CI_THRESH ? ' ★' : '';
      if (r.baseLA === 0 && ci.low > CI_THRESH) starCount++;
      console.log(
        `    LA=${r.baseLA} budget=${r.budget} seed=${r.seed}: ${(wr * 100).toFixed(1)}% CI ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}% [${r.wins}/${r.games}]${star}`
      );
    }
    // 採用判定: LA=0 の seed が 2本以上あり、いずれも CI 下限 > 25%。
    const reproduced = la0Seeds.length >= 2 && starCount >= 2;
    if (reproduced) {
      adopted.push(idx);
      console.log(`    → 採用候補 ✓✓（LA=0 fresh seed ${starCount}本で CI下限>25% 再現）`);
    } else if (starCount >= 1) {
      console.log(`    → 一部のみ（★ ${starCount} seed / 要 2本再現）`);
    }
    console.log('');
  }
  console.log(`採用基準クリア（LA=0 2 seed 再現）: ${adopted.length ? adopted.join(',') : 'なし'}`);
}

main();
