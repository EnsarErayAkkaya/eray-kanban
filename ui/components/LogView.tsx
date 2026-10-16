import { useEffect, useRef } from 'react';
import type { RunLogLine } from '@shared/run';

interface Props {
  readonly lines: readonly RunLogLine[];
}

export function LogView({ lines }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0) return <div className="log log--empty">No output yet.</div>;

  return (
    <div
      className="log"
      ref={box}
      // Follow new output only while the reader is at the bottom.
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.map((line) => (
        <div key={`${line.runId}:${line.seq}`} className={`log__line log__line--${line.kind}`}>
          {line.text}
        </div>
      ))}
    </div>
  );
}
