import { type FormEvent, useState } from 'react';
import { MODELS } from '@shared/common';
import { ACCEPT_FOLLOWUPS, type Project } from '@shared/project';
import type { ProjectDraft } from '../state/apiClient';
import type { ActionResult } from '../state/useBoard';

const FOLLOWUP_LABEL: Readonly<Record<(typeof ACCEPT_FOLLOWUPS)[number], string>> = {
  none: 'nothing',
  push: 'push the working branch',
  merge: 'merge into the merge target',
};

const lines = (value: string) =>
  value
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);

interface Props {
  /** Given: edit this project's settings. Absent: create a new project. */
  readonly project?: Project;
  readonly onSubmit: (draft: ProjectDraft) => Promise<ActionResult>;
  readonly onClose: () => void;
}

export function ProjectForm({ project, onSubmit, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    setBusy(true);
    const result = await onSubmit({
      name: text('name'),
      repoPath: text('repoPath'),
      workingBranch: text('workingBranch'),
      mergeTarget: text('mergeTarget') || null,
      acceptCommit: form.get('acceptCommit') === 'on',
      acceptFollowup: text('acceptFollowup') as ProjectDraft['acceptFollowup'],
      pushAfterMerge: form.get('pushAfterMerge') === 'on',
      commitMessageFormat: text('commitMessageFormat'),
      defaultModel: text('defaultModel') as ProjectDraft['defaultModel'],
      defaultTurnLimit: Number(text('defaultTurnLimit')),
      allowedCommands: lines(text('allowedCommands')),
      checkCommands: lines(text('checkCommands')),
      autoFix: form.get('autoFix') === 'on',
    });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <h2>{project ? `${project.name} settings` : 'New project'}</h2>
      <label>
        Name
        <input name="name" required maxLength={80} autoFocus defaultValue={project?.name} />
      </label>
      <label>
        Repo path
        <input name="repoPath" required placeholder="/Users/you/Repos/my-app" defaultValue={project?.repoPath} />
      </label>
      <div className="row">
        <label>
          Working branch
          <input name="workingBranch" required defaultValue={project?.workingBranch ?? 'main'} />
        </label>
        <label>
          Merge target (optional)
          <input name="mergeTarget" placeholder="main" defaultValue={project?.mergeTarget ?? ''} />
        </label>
      </div>

      <fieldset className="panel__group">
        <legend>On accept, by default</legend>
        <label className="check">
          <input type="checkbox" name="acceptCommit" defaultChecked={project?.acceptCommit ?? true} />
          Commit the changed files
        </label>
        <div className="row">
          <label>
            Then
            <select name="acceptFollowup" defaultValue={project?.acceptFollowup ?? 'none'}>
              {ACCEPT_FOLLOWUPS.map((f) => (
                <option key={f} value={f}>
                  {FOLLOWUP_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="check check--inline">
            <input type="checkbox" name="pushAfterMerge" defaultChecked={project?.pushAfterMerge ?? false} />
            Push the target after a merge
          </label>
        </div>
        <label>
          Commit message
          <input name="commitMessageFormat" required defaultValue={project?.commitMessageFormat ?? 'feat(#{id}): {title}'} />
          <small>{'{id}'} and {'{title}'} are filled in; the agent summary becomes the body.</small>
        </label>
      </fieldset>

      <div className="row">
        <label>
          Default model
          <select name="defaultModel" defaultValue={project?.defaultModel ?? 'sonnet'}>
            {MODELS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Turn limit
          <input name="defaultTurnLimit" type="number" min={1} max={500} defaultValue={project?.defaultTurnLimit ?? 30} />
        </label>
      </div>
      <label>
        Commands the agent may run, one per line
        <textarea
          name="allowedCommands"
          rows={3}
          placeholder={'npm run test\nnpm run lint'}
          defaultValue={project?.allowedCommands.join('\n')}
        />
        <small>Leave empty to give the agent no shell at all. Shells and git are refused.</small>
      </label>

      <fieldset className="panel__group">
        <legend>Checks after each run</legend>
        <label>
          Check commands, one per line
          <textarea
            name="checkCommands"
            rows={3}
            placeholder={'npm run typecheck\nnpm run lint\nnpm test'}
            defaultValue={project?.checkCommands.join('\n')}
          />
          <small>Run by the board itself, in order, without a shell. Their results show in the review.</small>
        </label>
        <label className="check">
          <input type="checkbox" name="autoFix" defaultChecked={project?.autoFix ?? true} />
          When checks fail, let the agent try once to fix them before review
        </label>
      </fieldset>
      {error && <p className="form-error">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          {project ? 'Save settings' : 'Add project'}
        </button>
      </div>
    </form>
  );
}
