import { type FormEvent, useState } from 'react';
import { MODELS } from '@shared/common';
import { PRIORITIES } from '@shared/task';
import type { TaskTemplate } from '@shared/template';
import { type TemplateDraft, api } from '../state/apiClient';
import { useVersionedLoad } from '../state/useVersionedLoad';
import { ConfirmButton } from './ConfirmButton';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function describe(t: TaskTemplate): string {
  return [
    t.titlePrefix && `“${t.titlePrefix}…”`,
    t.priority !== 'normal' && t.priority,
    t.model ?? 'default model',
    t.turnLimit === null ? 'default turns' : `${t.turnLimit} turns`,
    t.visual && `visual · ${t.routes.length} routes`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Per-project starting points for the task form. Changes save at once, separately from the project settings. */
export function TemplatesEditor({ projectId }: { readonly projectId: number }) {
  const [version, setVersion] = useState(0);
  const { data: templates, error: loadError } = useVersionedLoad(() => api.templates(projectId), `${projectId}:${version}`);
  const [editing, setEditing] = useState<TaskTemplate | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setEditing(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');
    const model = text('model');
    const turnLimit = text('turnLimit').trim();
    const draft: TemplateDraft = {
      name: text('name').trim(),
      titlePrefix: text('titlePrefix'),
      description: text('description').trim(),
      acceptanceCriteria: text('acceptanceCriteria').trim(),
      priority: text('priority') as TemplateDraft['priority'],
      visual: form.get('visual') === 'on',
      routes: text('routes')
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean),
      model: model ? (model as NonNullable<TemplateDraft['model']>) : null,
      turnLimit: turnLimit ? Number(turnLimit) : null,
    };
    const target = editing;
    void run(() => (target === 'new' || target === null ? api.createTemplate(projectId, draft) : api.updateTemplate(target.id, draft)));
  };

  const current = editing === 'new' ? null : editing;

  return (
    <section className="panel">
      <h2>Task templates</h2>
      <p className="hint">Pre-fill the new-task form, e.g. bug fix, UI change, refactor. Saved as soon as you click Save.</p>
      {loadError && <p className="form-error">{loadError}</p>}
      {templates?.length === 0 && editing === null && <p className="hint">No templates yet.</p>}
      {templates && templates.length > 0 && (
        <ul className="templates">
          {templates.map((t) => (
            <li key={t.id} className="templates__row">
              <div>
                <strong>{t.name}</strong>
                <div className="hint">{describe(t)}</div>
              </div>
              <div className="templates__actions">
                <button type="button" className="btn btn--small" disabled={busy} onClick={() => setEditing(t)}>
                  Edit
                </button>
                <ConfirmButton
                  small
                  label="Delete"
                  confirmLabel="Click again to delete"
                  disabled={busy}
                  onConfirm={() => void run(() => api.deleteTemplate(t.id))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing === null ? (
        <div className="panel__actions">
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            Add template
          </button>
        </div>
      ) : (
        <form onSubmit={save} key={current?.id ?? 'new'}>
          <fieldset className="panel__group">
            <legend>{current ? `Edit “${current.name}”` : 'New template'}</legend>
            <div className="row">
              <label>
                Name
                <input name="name" required maxLength={80} defaultValue={current?.name} autoFocus />
              </label>
              <label>
                Title starts with
                <input name="titlePrefix" maxLength={80} placeholder="Fix: " defaultValue={current?.titlePrefix} />
              </label>
            </div>
            <div className="row">
              <label>
                Priority
                <select name="priority" defaultValue={current?.priority ?? 'normal'}>
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <select name="model" defaultValue={current?.model ?? ''}>
                  <option value="">project default</option>
                  {MODELS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label>
                Turn limit
                <input name="turnLimit" type="number" min={1} max={500} placeholder="default" defaultValue={current?.turnLimit ?? ''} />
              </label>
            </div>
            <label>
              Description
              <textarea name="description" rows={3} defaultValue={current?.description} />
            </label>
            <label>
              Acceptance criteria
              <textarea name="acceptanceCriteria" rows={2} defaultValue={current?.acceptanceCriteria} />
            </label>
            <label className="check">
              <input type="checkbox" name="visual" defaultChecked={current?.visual ?? false} />
              Visual task: screenshot these pages for the review
            </label>
            <label>
              Routes, one per line
              <textarea name="routes" rows={2} placeholder={'/\n/settings'} defaultValue={current?.routes.join('\n')} />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="panel__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn btn--primary" disabled={busy}>
                Save template
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {editing === null && error && <p className="form-error">{error}</p>}
    </section>
  );
}
