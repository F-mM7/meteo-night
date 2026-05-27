import { useEffect, useRef } from 'react';
import type { LogEntry } from '../game/types';
import { formatLogHeading } from '../game/log';

interface Props {
  entries: LogEntry[];
  playerCount: number;
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
            <span className="log-heading">{formatLogHeading(e, playerCount)}</span>
            <span className="log-message">{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
