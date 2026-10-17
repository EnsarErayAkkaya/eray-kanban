import { type FormEvent, Fragment, useMemo, useRef, useState } from 'react';
import { MODELS } from '@shared/common';
import type { Project } from '@shared/project';
import { PRIORITIES, type Task } from '@shared/task';
import { type TaskDraft, api } from '../state/apiClient';
import { buildEntries } from '../state/fileRefs';
import type { ActionResult } from '../state/useBoard';
import { useVersionedLoad } from '../state/useVersionedLoad';
import { FileExplorer } from './FileExplorer';
import { type FieldHandle, MentionField } from './MentionField';

interface Props {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly defaultProjectId: number | null;
  /** Edits this task instead of creating one; its project and the template stay fixed. */
  readonly task?: Task;
  readonly onSubmit: (draft: TaskDraft) => Promise<ActionResult>;
  readonly onClose: () => void;
}

export function TaskForm({ projects, tasks, defaultProjectId, task, onSubmit, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(task?.projectId ?? defaultProjectId ?? projects[0]?.id ?? 0);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const { data: templates } = useVersionedLoad(() => api.templates(projectId), String(projectId));
  const template = templates?.find((t) => t.id === templateId);
  const initial = {
    priority: task?.priority ?? template?.priority ?? 'normal',
    model: task?.model ?? template?.model ?? '',
    turnLimit: task?.turnLimit ?? template?.turnLimit ?? '',
    title: task?.title ?? template?.titlePrefix ?? '',
    description: task?.description ?? template?.description ?? '',
    acceptanceCriteria: task?.acceptanceCriteria ?? template?.acceptanceCriteria ?? '',
    dependsOn: task?.dependsOn ?? '',
    visual: task?.visual ?? template?.visual ?? false,
    routes: (task?.routes ?? template?.routes ?? []).join('\n'),
  };
  const [filesVersion, setFilesVersion] = useState(0);
  const files = useVersionedLoad(() => api.files(projectId), `${projectId}:${filesVersion}`);
  const entries = useMemo(() => buildEntries(files.data?.files ?? []), [files.data]);
  // The explorer adds references to the field you used last; the description until you pick another.
  const lastField = useRef<FieldHandle | null>(null);
  const activate = (field: FieldHandle) => {
    lastField.current = field;
  };
  // Done tasks are already satisfied and cancelled ones never would be; an edit keeps the one it has.
  const candidates = tasks.filter(
    (t) =>
      t.projectId === projectId &&
      t.id !== task?.id &&
      (t.id === task?.dependsOn || (t.status !== 'done' && t.status !== 'cancelled')),
  );

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
      <h2>{task ? `Edit task #${task.id}` : 'New task'}</h2>
      <div className="row">
        <label>
          Project
          <select
            name="projectId"
            value={projectId}
            disabled={task !== undefined}
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
        {!task && (
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
        )}
      </div>
      {/* Picking a template remounts the fields so its values become their new defaults; all stay editable. */}
      <Fragment key={`${projectId}:${templateId ?? 'none'}`}>
        <div className="row">
          <label>
            Priority
            <select name="priority" defaultValue={initial.priority}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select name="model" defaultValue={initial.model}>
              {!task && <option value="">project default</option>}
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Turn limit
            <input
              name="turnLimit"
              type="number"
              min={1}
              max={500}
              placeholder="default"
              required={task !== undefined}
              defaultValue={initial.turnLimit}
            />
          </label>
        </div>
        <MentionField
          name="title"
          label="Title"
          multiline={false}
          required
          maxLength={200}
          autoFocus
          defaultValue={initial.title}
          entries={entries}
          onActivate={activate}
        />
        <MentionField
          name="description"
          label="Description"
          multiline
          rows={4}
          placeholder="Type @ to reference a file or folder, or drop one here"
          defaultValue={initial.description}
          entries={entries}
          onActivate={activate}
          registerDefault={(field) => {
            lastField.current ??= field;
          }}
        />
        <MentionField
          name="acceptanceCriteria"
          label="Acceptance criteria"
          multiline
          rows={3}
          placeholder="- One check per line"
          defaultValue={initial.acceptanceCriteria}
          entries={entries}
          onActivate={activate}
        />
        <details className="panel__group explorer-group">
          <summary>Project files</summary>
          <p className="hint">Click a file or folder to reference it in the field you used last, or drag it into a field.</p>
          <FileExplorer
            entries={entries}
            truncated={files.data?.truncated ?? false}
            loading={files.loading}
            error={files.error}
            onPick={(path) => lastField.current?.insert(path)}
            onRefresh={() => setFilesVersion((v) => v + 1)}
          />
        </details>
        <label>
          Depends on
          <select name="dependsOn" defaultValue={initial.dependsOn}>
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
            <input type="checkbox" name="visual" defaultChecked={initial.visual} />
            Visual task: screenshot these pages for the review
          </label>
          <label>
            Routes, one per line
            <textarea name="routes" rows={2} placeholder={'/\n/settings'} defaultValue={initial.routes} />
            <small>Taken at the sizes in the project settings, after the checks. Leave empty to let the agent pick the pages it changed.</small>
          </label>
        </fieldset>
      </Fragment>
      <p className="hint">
        {task?.status === 'cancelled'
          ? 'Saving moves the task back to Backlog. The agent starts it from scratch, on a fresh snapshot.'
          : task
            ? 'Changes apply the next time the agent starts this task.'
            : 'New tasks start in Backlog. Drag one to Todo when it is ready for the agent.'}
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          {task?.status === 'cancelled' ? 'Save & move to Backlog' : task ? 'Save' : 'Add task'}
        </button>
      </div>
    </form>
  );
}
