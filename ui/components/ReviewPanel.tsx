import { type FormEvent, useEffect, useState } from 'react';
import type { Project } from '@shared/project';
import type { AcceptOptions } from '@shared/review';
import type { Run, RunLogLine } from '@shared/run';
import type { Screenshot } from '@shared/screenshot';
import type { Task } from '@shared/task';
import type { ActionResult, ReviewAction } from '../state/useBoard';
import { api } from '../state/apiClient';
import { useVersionedLoad } from '../state/useVersionedLoad';
import { ChecksView } from './ChecksView';
import { ScreenshotLightbox, ScreenshotsView } from './ScreenshotsView';
import { ConfirmButton } from './ConfirmButton';
import { DiffView } from './DiffView';
import { LogView } from './LogView';

const KIND_LABEL: Readonly<Record<Run['kind'], string>> = {
  initial: 'First run',
  feedback: 'After your feedback',
  check_fix: 'Fix pass for checks',
  answer: 'After your answer',
};

const STATUS_LABEL: Readonly<Record<Task['status'], string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  needs_input: 'Needs input',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

interface Props {
  readonly task: Task;
  readonly project: Project | undefined;
  readonly runs: readonly Run[];
  readonly log: readonly RunLogLine[];
  readonly onReview: (action: ReviewAction) => Promise<ActionResult>;
  readonly onStop: () => void;
  readonly onClose: () => void;
}

export function ReviewPanel({ task, project, runs, log, onReview, onStop, onClose }: Props) {
  const lastRun = runs.at(-1);
  const version = `${task.status}:${task.updatedAt}:${runs.length}:${lastRun?.outcome ?? ''}`;
  const { data: changes, loading, error: changesError } = useVersionedLoad(() => api.changes(task.id), version);
  const { data: checks } = useVersionedLoad(() => api.checks(task.id), version);
  const latestChecks = checks?.at(-1);
  const checkedRun = runs.find((r) => r.id === latestChecks?.runId);
  const { data: allShots } = useVersionedLoad(() => api.screenshots(task.id), version);
  const shotRunId = allShots?.at(-1)?.runId;
  const shots = allShots?.filter((s) => s.runId === shotRunId) ?? [];
  const [openShot, setOpenShot] = useState<Screenshot | null>(null);
  const review = [...runs].reverse().find((r) => r.review !== null)?.review ?? null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [commit, setCommit] = useState(project?.acceptCommit ?? true);
  const [followup, setFollowup] = useState<NonNullable<AcceptOptions['followup']>>(project?.acceptFollowup ?? 'none');
  const [pushAfterMerge, setPushAfterMerge] = useState(project?.pushAfterMerge ?? false);

  useEffect(() => {
    // Escape closes the enlarged screenshot first, then the panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openShot) setOpenShot(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, openShot]);

  const act = async (action: ReviewAction, closeOnSuccess: boolean) => {
    setBusy(true);
    setError(null);
    const result = await onReview(action);
    setBusy(false);
    if (!result.ok) setError(result.error);
    else if (closeOnSuccess) onClose();
    return result.ok;
  };

  const reject = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ kind: 'reject', feedback }, false)) setFeedback('');
  };

  const answer = async (e: FormEvent) => {
    e.preventDefault();
    if (await act({ kind: 'answer', answer: answerText }, false)) setAnswerText('');
  };

  const inReview = task.status === 'in_review';
  const started = task.status === 'in_progress' || task.status === 'needs_input' || inReview;
  const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return (
    <div className="drawer" role="dialog" aria-label={`Review of task ${task.id}`}>
      <div className="drawer__backdrop" onClick={onClose} />
      <aside className="drawer__panel">
        <header className="drawer__head">
          <div>
            <div className="drawer__meta">
              #{task.id} · {STATUS_LABEL[task.status]} · {project?.name ?? 'unknown project'}
            </div>
            <h2>{task.title}</h2>
          </div>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {task.gitIssue === 'guard_tripped' && (
          <div className="card__issue">
            <strong>The agent changed git itself.</strong> {task.gitIssueDetail} You can still accept (keeping what it did) or
            cancel, which rolls it all back.
          </div>
        )}

        <section className="drawer__section">
          <h3>Agent summary</h3>
          {review === null ? (
            <p className="hint">The agent did not leave a summary.</p>
          ) : review.outcome === 'needs_input' ? (
            <>
              <p>
                <strong>Question:</strong> {review.question}
              </p>
              {task.status === 'needs_input' && (
                <form onSubmit={(e) => void answer(e)} className="drawer__reject">
                  <label>
                    Your answer
                    <textarea
                      rows={3}
                      value={answerText}
                      onChange={(e) => setAnswerText(e.target.value)}
                      placeholder="The agent resumes with its context and carries on."
                    />
                  </label>
                  <button className="btn btn--primary" disabled={busy || answerText.trim() === ''}>
                    Send answer
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <p>{review.summary}</p>
              {review.notes.length > 0 && (
                <ul className="drawer__list">
                  {review.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {review.concerns.length > 0 && (
                <ul className="drawer__list drawer__list--concerns">
                  {review.concerns.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {task.visual && (
          <section className="drawer__section">
            <h3>Screenshots</h3>
            {shots.length === 0 ? (
              <p className="hint">
                {task.status === 'in_progress'
                  ? task.routes.length > 0
                    ? 'Taken after the run and its checks.'
                    : 'Taken after the run and its checks, of the pages the agent names.'
                  : task.routes.length > 0
                    ? 'No screenshots for this task yet.'
                    : 'No screenshots: the task lists no pages and the agent named none.'}
              </p>
            ) : (
              <>
                {task.routes.length === 0 && <p className="hint">Pages chosen by the agent.</p>}
                <ScreenshotsView shots={shots} imageUrl={api.screenshotUrl} onOpen={setOpenShot} />
              </>
            )}
          </section>
        )}

        {latestChecks && (
          <section className="drawer__section">
            <h3>
              Checks
              {checkedRun?.kind === 'check_fix' && <span className="hint"> · after the automatic fix pass</span>}
            </h3>
            <ChecksView results={latestChecks.results} />
          </section>
        )}

        <section className="drawer__section">
          <h3>
            Changed files{changes?.available ? ` (${changes.files.length})` : ''}
            {changes?.baseHead && <span className="hint"> against {changes.baseHead.slice(0, 8)}</span>}
          </h3>
          {loading && !changes && <p className="hint">Reading the repo…</p>}
          {changesError && <p className="form-error">{changesError}</p>}
          {changes && !changes.available && <p className="hint">{changes.reason}</p>}
          {changes?.available && changes.files.length === 0 && <p className="hint">No files changed.</p>}
          {changes?.files.map((f) => (
            <DiffView key={f.path} file={f} open={changes.files.length <= 5} />
          ))}
        </section>

        {inReview && (
          <section className="drawer__section drawer__actions">
            <form onSubmit={(e) => void reject(e)} className="drawer__reject">
              <label>
                Feedback for the agent
                <textarea
                  rows={3}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="What should change? The agent resumes with its context."
                />
              </label>
              <button className="btn" disabled={busy || feedback.trim() === ''}>
                Reject with feedback
              </button>
            </form>

            <div className="drawer__accept">
              <label className="check">
                <input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} />
                Commit the changed files
              </label>
              <fieldset disabled={!commit} className="drawer__followup">
                <legend>Then</legend>
                <label className="check">
                  <input type="radio" checked={followup === 'none'} onChange={() => setFollowup('none')} />
                  nothing
                </label>
                <label className="check">
                  <input type="radio" checked={followup === 'push'} onChange={() => setFollowup('push')} />
                  push {project?.workingBranch}
                </label>
                <label className="check" title={project?.mergeTarget ? '' : 'Set a merge target in project settings'}>
                  <input
                    type="radio"
                    checked={followup === 'merge'}
                    disabled={!project?.mergeTarget}
                    onChange={() => setFollowup('merge')}
                  />
                  merge into {project?.mergeTarget ?? '(no target set)'}
                </label>
                {followup === 'merge' && (
                  <label className="check">
                    <input type="checkbox" checked={pushAfterMerge} onChange={(e) => setPushAfterMerge(e.target.checked)} />
                    and push {project?.mergeTarget}
                  </label>
                )}
              </fieldset>
              {!commit && <p className="hint">Without a commit the project stays paused until you commit or discard the changes.</p>}
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() =>
                  void act({ kind: 'accept', options: { commit, followup: commit ? followup : 'none', pushAfterMerge } }, true)
                }
              >
                Accept
              </button>
            </div>
          </section>
        )}

        {started && (
          <section className="drawer__section drawer__danger">
            {task.status === 'in_progress' && (
              <button className="btn" onClick={onStop} disabled={busy}>
                Stop the agent
              </button>
            )}
            <ConfirmButton
              label="Cancel & roll back"
              confirmLabel="Click again to roll back"
              disabled={busy}
              onConfirm={() => void act({ kind: 'cancel' }, true)}
            />
            <span className="hint">Restores the repo to how it was before this task. Ignored files are left alone.</span>
          </section>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <section className="drawer__section">
          <h3>
            Runs{runs.length > 0 && <span className="hint"> · ${totalCost.toFixed(3)} total</span>}
          </h3>
          {runs.length === 0 && <p className="hint">No runs yet.</p>}
          <ol className="runs">
            {runs.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{KIND_LABEL[r.kind]}</strong> · {r.outcome.replace('_', ' ')}
                  {r.numTurns !== null && ` · ${r.numTurns} turns`}
                  {r.costUsd !== null && ` · $${r.costUsd.toFixed(3)}`}
                  <span className="hint"> · {new Date(r.startedAt).toLocaleTimeString()}</span>
                </div>
                {r.error && <div className="card__error">{r.error}</div>}
                {r.kind !== 'initial' && (
                  <details>
                    <summary className="hint">What the agent was sent</summary>
                    <pre className="runs__input">{r.input}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
          <details open={task.status === 'in_progress'}>
            <summary className="hint">Log</summary>
            <LogView lines={log} />
          </details>
        </section>
      </aside>
      {openShot && <ScreenshotLightbox shot={openShot} imageUrl={api.screenshotUrl} onClose={() => setOpenShot(null)} />}
    </div>
  );
}
