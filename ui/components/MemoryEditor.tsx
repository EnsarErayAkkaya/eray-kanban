import { useEffect, useState } from 'react';
import { MEMORY_KINDS, MEMORY_LIMITS, type MemoryEntry, type MemoryKind, type ProjectMemory } from '@shared/memory';
import { api } from '../state/apiClient';
import { useVersionedLoad } from '../state/useVersionedLoad';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Row {
  readonly key: string;
  readonly area: string;
  readonly text: string;
  readonly taskId: number | null;
  /** undefined for a row added here; the server stamps it on save. */
  readonly date?: string | null;
}
type Drafts = Readonly<Record<MemoryKind, readonly Row[]>>;

const COPY: Readonly<Record<MemoryKind, { title: string; hint: string; placeholder: string }>> = {
  decisions: { title: 'Decisions', hint: 'Choices you made for this project.', placeholder: 'Use zod for validation, not yup' },
  knowhow: { title: 'Know-how', hint: 'Things agents should know about this repo.', placeholder: 'Run vitest with --pool=forks' },
};

const toRows = (entries: readonly MemoryEntry[]): Row[] => entries.map((e) => ({ ...e, key: crypto.randomUUID() }));
const toDrafts = (memory: ProjectMemory): Drafts => ({ decisions: toRows(memory.decisions), knowhow: toRows(memory.knowhow) });

function meta(row: Row): string {
  if (row.date === undefined) return 'new';
  return [row.taskId !== null && `#${row.taskId}`, row.date].filter(Boolean).join(' · ');
}

/** The project's .kanban/ files. Every agent run reads them, so they stay short. */
export function MemoryEditor({ projectId }: { readonly projectId: number }) {
  const { data, error: loadError } = useVersionedLoad(() => api.memory(projectId), String(projectId));
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDrafts(toDrafts(data));
  }, [data]);

  const change = (kind: MemoryKind, rows: readonly Row[]) => {
    setDrafts((d) => (d ? { ...d, [kind]: rows } : d));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (!drafts) return;
    setBusy(true);
    setError(null);
    try {
      const body = (kind: MemoryKind) =>
        drafts[kind].filter((r) => r.text.trim()).map(({ area, text, taskId, date }) => ({ area, text, taskId, ...(date === undefined ? {} : { date }) }));
      setDrafts(toDrafts(await api.saveMemory(projectId, { decisions: body('decisions'), knowhow: body('knowhow') })));
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Memory</h2>
      <p className="hint">
        Saved in <code>.kanban/</code> in the repo and added to every agent run. Keep entries short. Commit the change yourself
        before the next task starts. You can't edit memory while a task is active.
      </p>
      {loadError && <p className="form-error">{loadError}</p>}
      {drafts &&
        MEMORY_KINDS.map((kind) => {
          const rows = drafts[kind];
          const limit = MEMORY_LIMITS[kind].entries;
          return (
            <fieldset key={kind} className="panel__group">
              <legend>
                {COPY[kind].title} · {rows.length}/{limit}
              </legend>
              <p className="hint">{COPY[kind].hint}</p>
              {rows.length > 0 && (
                <ul className="memory">
                  {rows.map((row, i) => {
                    const update = (patch: Partial<Row>) => change(kind, rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
                    return (
                      <li key={row.key} className="memory__row">
                        <input
                          className="memory__area"
                          aria-label="Area"
                          placeholder="area"
                          maxLength={40}
                          value={row.area}
                          onChange={(e) => update({ area: e.target.value })}
                        />
                        <input
                          className="memory__text"
                          aria-label={`${COPY[kind].title} entry`}
                          placeholder={COPY[kind].placeholder}
                          maxLength={500}
                          value={row.text}
                          onChange={(e) => update({ text: e.target.value })}
                        />
                        <span className="hint memory__meta">{meta(row)}</span>
                        <button
                          type="button"
                          className="btn btn--small btn--ghost"
                          aria-label="Remove entry"
                          onClick={() => change(kind, rows.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={rows.length >= limit}
                  onClick={() => change(kind, [...rows, { key: crypto.randomUUID(), area: '', text: '', taskId: null }])}
                >
                  Add {kind === 'decisions' ? 'decision' : 'know-how'}
                </button>
              </div>
            </fieldset>
          );
        })}
      {error && <p className="form-error">{error}</p>}
      <div className="panel__actions">
        {saved && <span className="hint">Saved to .kanban/</span>}
        <button type="button" className="btn btn--primary" disabled={!dirty || busy} onClick={() => void save()}>
          Save memory
        </button>
      </div>
    </section>
  );
}
