import { type FormEvent, Fragment, useState } from 'react';
import { MODELS } from '@shared/common';
import type { Project } from '@shared/project';
import { PRIORITIES, type Task } from '@shared/task';
import { type TaskDraft, api } from '../state/apiClient';
import type { ActionResult } from '../state/useBoard';
import { useVersionedLoad } from '../state/useVersionedLoad';

interface Props {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly defaultProjectId: number | null;
  readonly onSubmit: (draft: TaskDraft) => Promise<ActionResult>;
  readonly onClose: () => void;
}

export function TaskForm({ projects, tasks, defaultProjectId, onSubmit, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? 0);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const { data: templates } = useVersionedLoad(() => api.templates(projectId), String(projectId));
  const template = templates?.find((t) => t.id === templateId);
  // Done tasks are already satisfied and cancelled ones never would be.
  const candidates = tasks.filter((t) => t.projectId === projectId && t.status !== 'done' && t.status !== 'cancelled');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const model = text('model');
    const turnLimit = text('turnLimit');
    const dependsOn = text('dependsOn');
    setBusy(true);
    const result = await onSubmit({
      projectId,
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
      dependsOn: dependsOn ? Number(dependsOn) : null,
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
          <select
            name="projectId"
            value={projectId}
            onChange={(e) => {
              setProjectId(Number(e.target.value));
              setTemplateId(null);
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Template
          <select
            value={templateId ?? ''}
            disabled={!templates?.length}
            onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{templates?.length ? 'none' : 'no templates'}</option>
            {templates?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* Picking a template remounts the fields so its values become their new defaults; all stay editable. */}
      <Fragment key={`${projectId}:${templateId ?? 'none'}`}>
        <div className="row">
          <label>
            Priority
            <select name="priority" defaultValue={template?.priority ?? 'normal'}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select name="model" defaultValue={template?.model ?? ''}>
              <option value="">project default</option>
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Turn limit
            <input name="turnLimit" type="number" min={1} max={500} placeholder="default" defaultValue={template?.turnLimit ?? ''} />
          </label>
        </div>
        <label>
          Title
          <input name="title" required maxLength={200} autoFocus defaultValue={template?.titlePrefix ?? ''} />
        </label>
        <label>
          Description
          <textarea name="description" rows={4} defaultValue={template?.description ?? ''} />
        </label>
        <label>
          Acceptance criteria
          <textarea
            name="acceptanceCriteria"
            rows={3}
            placeholder="- One check per line"
            defaultValue={template?.acceptanceCriteria ?? ''}
          />
        </label>
        <label>
          Depends on
          <select name="dependsOn" defaultValue="">
            <option value="">nothing, can start any time</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.id} {t.title}
              </option>
            ))}
          </select>
          <small>The agent starts this task only after that one is accepted.</small>
        </label>
        <fieldset className="panel__group">
          <legend>Screenshots</legend>
          <label className="check">
            <input type="checkbox" name="visual" defaultChecked={template?.visual ?? false} />
            Visual task: screenshot these pages for the review
          </label>
          <label>
            Routes, one per line
            <textarea name="routes" rows={2} placeholder={'/\n/settings'} defaultValue={template?.routes.join('\n') ?? ''} />
            <small>Taken at the sizes in the project settings, after the checks. Leave empty to let the agent pick the pages it changed.</small>
          </label>
        </fieldset>
      </Fragment>
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
