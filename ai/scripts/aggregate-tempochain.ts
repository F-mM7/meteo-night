/**
 * aggregate-tempochain.ts ― optimize-tempochain.ts の全シャード結果(/tmp/opt-grid-*.jsonl)を
 * 集約し、勝率＋Wilson 95% CI でランキングして上位を表示する。途中でも実行可。
 *
 *   npx tsx ai/scripts/aggregate-tempochain.ts [topN] [prefix=/tmp/opt-grid]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { wilsonInterval } from './stats';

interface Row {
  idx: number;
  wins: number;
  games: number;
  genome: Record<string, unknown>;
}

function main(): void {
  const topN = process.argv[2] ? parseInt(process.argv[2], 10) : 25;
  const prefix = process.argv[3] ?? '/tmp/opt-grid';
  const dir = dirname(prefix);
  const base = basename(prefix);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.jsonl$`);
  const files = readdirSync(dir).filter((f) => re.test(f));
  const rows: Row[] = [];
  for (const f of files) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        /* 部分行は無視 */
      }
    }
  }
  if (rows.length === 0) {
    console.log('まだ結果がありません（候補1件=80局で約16分）。');
    return;
  }
  const totalGames = rows.reduce((a, r) => a + r.games, 0);
  rows.sort((a, b) => b.wins / b.games - a.wins / a.games);

  const g = (r: Row) => r.genome;
  const fmtGenome = (r: Row) =>
    `fire=${g(r).fireTarget} late=${g(r).lateThreshold}/${g(r).fireTargetLate} full=${g(r).fullThreshold} blend=${g(r).buildTempoBlend} ${g(r).distanceMode}`;

  console.log(`=== tempoChain 最適化 集約 (${rows.length}/400 候補完了, 計${totalGames}局) ===`);
  console.log(`順 勝率   95%CI        [W/G]  genome`);
  let significant = 0;
  rows.slice(0, topN).forEach((r, i) => {
    const wr = r.wins / r.games;
    const ci = wilsonInterval(r.wins, r.games);
    const sig = ci.low > 0.25 ? ' ★' : '';
    console.log(
      `${String(i + 1).padStart(2)} ${(wr * 100).toFixed(1)}% ${(ci.low * 100).toFixed(1)}-${(ci.high * 100).toFixed(1)}% [${r.wins}/${r.games}] ${fmtGenome(r)}${sig}`
    );
  });
  for (const r of rows) if (wilsonInterval(r.wins, r.games).low > 0.25) significant++;
  console.log(`\n公平25%をCI下限で有意超過(★): ${significant} 件（要・高局数で確証）`);
  console.log(`上位${Math.min(12, rows.length)}の idx: ${rows.slice(0, 12).map((r) => r.idx).join(',')}`);
}

main();
