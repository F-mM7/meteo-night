import { useEffect, useRef } from 'react';
import type { LogEntry } from '../game/types';

interface Props {
  entries: LogEntry[];
}

export function LogPanel({ entries }: Props) {
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
            <span className="log-turn">T{e.turn}</span>
            <span className="log-player">{e.playerName}</span>
            <span className="log-message">{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
