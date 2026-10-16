import { useEffect, useState } from 'react';
import type { Run, RunLogLine } from '@shared/run';
import type { Task } from '@shared/task';
import type { TaskStatus } from '@shared/taskStatus';
import { LogView } from './LogView';

export type CardActionId = 'promote' | 'demote' | 'stop' | 'cancel' | 'open' | 'retryPush' | 'resolveIssue';

interface CardAction {
  readonly label: string;
  readonly id: CardActionId;
  readonly tone?: 'danger' | 'primary';
}

const DETAILS: CardAction = { label: 'Details', id: 'open' };

// Review decisions and rollback live in the review panel, so each has one place and one confirm.
const ACTIONS: Readonly<Record<TaskStatus, readonly CardAction[]>> = {
  backlog: [
    { label: 'To Todo', id: 'promote' },
    { label: 'Cancel', id: 'cancel', tone: 'danger' },
  ],
  todo: [
    { label: 'To Backlog', id: 'demote' },
    { label: 'Cancel', id: 'cancel', tone: 'danger' },
  ],
  in_progress: [{ label: 'Stop', id: 'stop' }, DETAILS],
  needs_input: [DETAILS],
  in_review: [{ label: 'Review', id: 'open', tone: 'primary' }],
  done: [DETAILS],
  cancelled: [DETAILS],
};

const ISSUE_LABEL: Readonly<Record<NonNullable<Task['gitIssue']>, string>> = {
  guard_tripped: 'Agent touched git',
  merge_conflict: 'Merge conflict',
  push_failed: 'Push failed',
};

function issueActions(task: Task): CardAction[] {
  if (task.status !== 'done' || task.gitIssue === null) return [];
  const retry: CardAction[] = task.gitIssue === 'push_failed' ? [{ label: 'Retry push', id: 'retryPush' }] : [];
  return [...retry, { label: 'Mark resolved', id: 'resolveIssue' }];
}

const OUTCOME_LABEL: Readonly<Record<Run['outcome'], string>> = {
  running: 'running',
  completed: 'completed',
  turn_limit: 'hit turn limit',
  stopped: 'stopped',
  timed_out: 'timed out',
  failed: 'failed',
};

interface Props {
  readonly task: Task;
  readonly projectName: string | null;
  readonly runs: readonly Run[];
  readonly log: readonly RunLogLine[];
  readonly draggable: boolean;
  readonly onDragStart: (task: Task) => void;
  readonly onDragEnd: () => void;
  readonly onAction: (task: Task, action: CardActionId) => void;
  readonly onOpenLog: (task: Task) => void;
}

const HAS_HISTORY: ReadonlySet<TaskStatus> = new Set(['in_progress', 'needs_input', 'in_review']);

export function TaskCard({ task, projectName, runs, log, draggable, onDragStart, onDragEnd, onAction, onOpenLog }: Props) {
  const [logOpen, setLogOpen] = useState(task.status === 'in_progress');

  // Once per mount (a card remounts when it changes column); later lines arrive over SSE.
  useEffect(() => {
    if (HAS_HISTORY.has(task.status)) onOpenLog(task);
  }, []);
  const lastRun = runs.at(-1);
  const checkedRun = [...runs].reverse().find((r) => r.checksPassed !== null);
  const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const totalTurns = runs.reduce((sum, r) => sum + (r.numTurns ?? 0), 0);

  const toggleLog = () => {
    if (!logOpen) onOpenLog(task);
    setLogOpen(!logOpen);
  };

  return (
    <article
      className={`card card--${task.status}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(task.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(task);
      }}
      onDragEnd={onDragEnd}
    >
      <header className="card__head">
        <span className="card__id">#{task.id}</span>
        {task.priority !== 'normal' && <span className={`badge badge--${task.priority}`}>{task.priority}</span>}
        {task.status === 'in_progress' && <span className="pulse" aria-label="Agent working" />}
      </header>
      <h3 className="card__title">{task.title}</h3>
      <div className="card__meta">
        {projectName && <span>{projectName}</span>}
        <span>{task.model}</span>
        <span>{task.turnLimit} turns max</span>
      </div>
      {lastRun && (
        <div className="card__run">
          Last run {OUTCOME_LABEL[lastRun.outcome]}
          {totalTurns > 0 && ` · ${totalTurns} turns · $${totalCost.toFixed(3)}`}
          {lastRun.error && <div className="card__error">{lastRun.error}</div>}
        </div>
      )}
      {task.gitIssue && (
        <div className={`card__issue card__issue--${task.gitIssue}`}>
          <strong>{ISSUE_LABEL[task.gitIssue]}</strong>
          {task.gitIssueDetail && <div>{task.gitIssueDetail}</div>}
        </div>
      )}
      {checkedRun && checkedRun.checksFailed !== null && checkedRun.checksPassed !== null && (
        <div className={`card__checks card__checks--${checkedRun.checksFailed > 0 ? 'fail' : 'pass'}`}>
          {checkedRun.checksFailed > 0
            ? `✗ ${checkedRun.checksFailed} of ${checkedRun.checksFailed + checkedRun.checksPassed} checks failed`
            : `✓ ${checkedRun.checksPassed} checks passed`}
        </div>
      )}
      {task.commitSha && <div className="card__meta">Commit {task.commitSha.slice(0, 8)}</div>}
      <footer className="card__actions">
        {[...ACTIONS[task.status], ...issueActions(task)].map((a) => (
          <button key={a.id} className={`btn btn--small${a.tone ? ` btn--${a.tone}` : ''}`} onClick={() => onAction(task, a.id)}>
            {a.label}
          </button>
        ))}
        {task.status !== 'backlog' && task.status !== 'todo' && (
          <button className="btn btn--small btn--ghost" onClick={toggleLog} aria-expanded={logOpen}>
            {logOpen ? 'Hide log' : 'Log'}
          </button>
        )}
      </footer>
      {logOpen && <LogView lines={log} />}
    </article>
  );
}
