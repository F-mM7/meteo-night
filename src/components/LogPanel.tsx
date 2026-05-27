import { useEffect, useRef } from 'react';
import type { LogEntry } from '../game/types';

interface Props {
  entries: LogEntry[];
  playerCount: number;
}

function formatHeading(entry: LogEntry, playerCount: number): string {
  const { turn, playerName } = entry;
  if (turn <= 0 || playerCount <= 0) {
    return `R0(${playerName})`;
  }
  const round = Math.floor((turn - 1) / playerCount) + 1;
  const seat = ((turn - 1) % playerCount) + 1;
  return `R${round}-${seat}(${playerName})`;
}

export function LogPanel({ entries, playerCount }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <section className="log-panel" aria-label="アクションログ">
      <h3>ログ</h3>
      <div className="log-entries" ref={ref}>
        {entries.map((e, i) => (
          <div
            key={i}
            className={`log-entry${e.emphasize ? ' log-entry-emphasize' : ''}`}
          >
            <span className="log-heading">{formatHeading(e, playerCount)}</span>
            <span className="log-message">{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
