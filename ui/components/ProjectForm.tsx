import { type FormEvent, useState } from 'react';
import { MODELS } from '@shared/common';
import type { ProjectDraft } from '../state/apiClient';
import type { ActionResult } from '../state/useBoard';

interface Props {
  readonly onSubmit: (draft: ProjectDraft) => Promise<ActionResult>;
  readonly onClose: () => void;
}

export function ProjectForm({ onSubmit, onClose }: Props) {
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
      defaultModel: text('defaultModel') as ProjectDraft['defaultModel'],
      defaultTurnLimit: Number(text('defaultTurnLimit')),
      allowedCommands: text('allowedCommands')
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
    });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <h2>New project</h2>
      <label>
        Name
        <input name="name" required maxLength={80} autoFocus />
      </label>
      <label>
        Repo path
        <input name="repoPath" required placeholder="/Users/you/Repos/my-app" />
      </label>
      <div className="row">
        <label>
          Working branch
          <input name="workingBranch" required defaultValue="main" />
        </label>
        <label>
          Default model
          <select name="defaultModel" defaultValue="sonnet">
            {MODELS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Turn limit
          <input name="defaultTurnLimit" type="number" min={1} max={500} defaultValue={30} />
        </label>
      </div>
      <label>
        Commands the agent may run, one per line
        <textarea name="allowedCommands" rows={3} placeholder={'npm run test\nnpm run lint'} />
        <small>Leave empty to give the agent no shell at all. Shells and git are refused.</small>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          Add project
        </button>
      </div>
    </form>
  );
}
