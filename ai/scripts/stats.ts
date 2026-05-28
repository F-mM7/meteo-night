/**
 * ベンチ集計の共通ユーティリティ。
 * 同一実装が `bench.ts` / `bench-neural.ts` / `grid-uct.ts` の 3 箇所に重複していたものを集約。
 */

/**
 * Wilson 95% 信頼区間。
 * n=0 のときは `{ low: 0, high: 0 }` を返す（無検体の慣例的扱い）。
 */
export function wilsonInterval(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * 順位分布 `rankCount[i]`（i+1 位の回数）から期待順位（平均順位）を求める。
 *
 * 呼び出し元によって denominator が `games` だったり `Math.max(1, games)` だったりと
 * 「ゼロ除算ガード有無」に差があるため、ここでは denominator を引数で受け取り
 * そのまま割る。呼び出し側でガードする責務を変えない（既存挙動を保つ）。
 */
export function expectedRankFromRankCount(
  rankCount: readonly number[],
  denominator: number
): number {
  return rankCount.reduce((acc, c, idx) => acc + c * (idx + 1), 0) / denominator;
}
