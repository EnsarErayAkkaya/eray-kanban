import { type FormEvent, useState } from 'react';
import { MODELS } from '@shared/common';
import type { Project } from '@shared/project';
import { PRIORITIES } from '@shared/task';
import type { TaskDraft } from '../state/apiClient';
import type { ActionResult } from '../state/useBoard';

interface Props {
  readonly projects: readonly Project[];
  readonly defaultProjectId: number | null;
  readonly onSubmit: (draft: TaskDraft) => Promise<ActionResult>;
  readonly onClose: () => void;
}

export function TaskForm({ projects, defaultProjectId, onSubmit, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const model = text('model');
    const turnLimit = text('turnLimit');
    setBusy(true);
    const result = await onSubmit({
      projectId: Number(text('projectId')),
      title: text('title'),
      description: text('description'),
      acceptanceCriteria: text('acceptanceCriteria'),
      priority: text('priority') as TaskDraft['priority'],
      visual: form.get('visual') === 'on',
      routes: text('routes')
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean),
      ...(model ? { model: model as TaskDraft['model'] } : {}),
      ...(turnLimit ? { turnLimit: Number(turnLimit) } : {}),
    });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <h2>New task</h2>
      <div className="row">
        <label>
          Project
          <select name="projectId" defaultValue={defaultProjectId ?? projects[0]?.id}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select name="priority" defaultValue="normal">
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select name="model" defaultValue="">
            <option value="">project default</option>
            {MODELS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Turn limit
          <input name="turnLimit" type="number" min={1} max={500} placeholder="default" />
        </label>
      </div>
      <label>
        Title
        <input name="title" required maxLength={200} autoFocus />
      </label>
      <label>
        Description
        <textarea name="description" rows={4} />
      </label>
      <label>
        Acceptance criteria
        <textarea name="acceptanceCriteria" rows={3} placeholder="- One check per line" />
      </label>
      <fieldset className="panel__group">
        <legend>Screenshots</legend>
        <label className="check">
          <input type="checkbox" name="visual" />
          Visual task: screenshot these pages for the review
        </label>
        <label>
          Routes, one per line
          <textarea name="routes" rows={2} placeholder={'/\n/settings'} />
          <small>Taken at the sizes in the project settings, after the checks.</small>
        </label>
      </fieldset>
      <p className="hint">New tasks start in Backlog. Drag one to Todo when it is ready for the agent.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          Add task
        </button>
      </div>
    </form>
  );
}
