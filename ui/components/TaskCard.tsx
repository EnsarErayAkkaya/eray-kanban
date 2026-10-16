import { useEffect, useState } from 'react';
import type { Run, RunLogLine } from '@shared/run';
import type { Task } from '@shared/task';
import type { TaskEvent, TaskStatus } from '@shared/taskStatus';
import { LogView } from './LogView';

interface CardAction {
  readonly label: string;
  readonly event: TaskEvent | 'stop';
  readonly tone?: 'danger';
}

const ACTIONS: Readonly<Record<TaskStatus, readonly CardAction[]>> = {
  backlog: [
    { label: 'To Todo', event: 'promote' },
    { label: 'Cancel', event: 'cancel', tone: 'danger' },
  ],
  todo: [
    { label: 'To Backlog', event: 'demote' },
    { label: 'Cancel', event: 'cancel', tone: 'danger' },
  ],
  in_progress: [{ label: 'Stop', event: 'stop', tone: 'danger' }],
  needs_input: [],
  in_review: [{ label: 'Accept (no commit)', event: 'accept' }],
  done: [],
  cancelled: [],
};

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
  readonly onAction: (task: Task, event: TaskEvent | 'stop') => void;
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
      <footer className="card__actions">
        {ACTIONS[task.status].map((a) => (
          <button key={a.event} className={a.tone === 'danger' ? 'btn btn--small btn--danger' : 'btn btn--small'} onClick={() => onAction(task, a.event)}>
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
