import type { LogEntry } from './types';

/**
 * ログエントリの見出し（例: `R3-2(あなた)`）を生成する。
 * `turn` はゲーム全体の通算ターン番号、`playerCount` はプレイヤー数。
 * いずれかが 0 以下のシステムログ等は `R0(...)` 表記で扱う。
 */
export function formatLogHeading(entry: LogEntry, playerCount: number): string {
  const { turn, playerName } = entry;
  if (turn <= 0 || playerCount <= 0) {
    return `R0(${playerName})`;
  }
  const round = Math.floor((turn - 1) / playerCount) + 1;
  const seat = ((turn - 1) % playerCount) + 1;
  return `R${round}-${seat}(${playerName})`;
}
