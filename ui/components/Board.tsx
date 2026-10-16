import { useState } from 'react';
import type { Project } from '@shared/project';
import type { Run, RunLogLine } from '@shared/run';
import type { Task } from '@shared/task';
import type { TaskStatus } from '@shared/taskStatus';
import { type CardActionId, TaskCard } from './TaskCard';

interface Column {
  readonly statuses: readonly TaskStatus[];
  readonly label: string;
  readonly hint: string;
  /** Columns that wait on you, not on the agent. */
  readonly yours?: boolean;
}

const COLUMNS: readonly Column[] = [
  { statuses: ['backlog'], label: 'Backlog', hint: 'Ideas, not ready for an agent' },
  { statuses: ['todo'], label: 'Todo', hint: 'The agent picks these up in order' },
  { statuses: ['in_progress'], label: 'Agent working', hint: 'One task per project at a time' },
  { statuses: ['needs_input'], label: 'Needs your answer', hint: 'The agent asked a question', yours: true },
  { statuses: ['in_review'], label: 'Ready for review', hint: 'The project waits until you decide', yours: true },
  { statuses: ['done', 'cancelled'], label: 'Finished', hint: 'Accepted or cancelled' },
];

// Dragging is only for the moves you make yourself; everything else is buttons or the agent.
const DROP_EVENTS: Partial<Record<TaskStatus, Partial<Record<TaskStatus, CardActionId>>>> = {
  backlog: { todo: 'promote' },
  todo: { backlog: 'demote' },
};

const PRIORITY_ORDER: Readonly<Record<Task['priority'], number>> = { high: 0, normal: 1, low: 2 };

function columnOrder(a: Task, b: Task): number {
  if (a.status === 'todo') return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.position - b.position;
  if (a.status === 'done' || a.status === 'cancelled') return b.updatedAt.localeCompare(a.updatedAt);
  return a.position - b.position;
}

interface Props {
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly showProjectNames: boolean;
  readonly runs: Readonly<Record<number, readonly Run[]>>;
  readonly logs: Readonly<Record<number, readonly RunLogLine[]>>;
  readonly onAction: (task: Task, action: CardActionId) => void;
  readonly onOpenLog: (task: Task) => void;
}

export function Board({ tasks, projects, showProjectNames, runs, logs, onAction, onOpenLog }: Props) {
  const [dragging, setDragging] = useState<Task | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? `project ${id}`;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dropEvent = (to: TaskStatus) => (dragging ? DROP_EVENTS[dragging.status]?.[to] : undefined);

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const status = col.statuses[0] ?? 'backlog';
        const cards = tasks.filter((t) => col.statuses.includes(t.status)).sort(columnOrder);
        const canDrop = dropEvent(status) !== undefined;
        return (
          <section
            key={status}
            className={`column${col.yours ? ' column--yours' : ''}${cards.length > 0 ? ' column--filled' : ''}${canDrop ? ' column--droppable' : ''}${canDrop && dropTarget === status ? ' column--over' : ''}`}
            onDragOver={(e) => {
              if (!canDrop) return;
              e.preventDefault();
              setDropTarget(status);
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              const event = dropEvent(status);
              if (dragging && event) onAction(dragging, event);
              setDragging(null);
              setDropTarget(null);
            }}
          >
            <header className="column__head">
              <h2>{col.label}</h2>
              <span className="column__count">{cards.length}</span>
              <p className="column__hint">{col.hint}</p>
            </header>
            <div className="column__cards">
              {cards.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  projectName={showProjectNames ? projectName(task.projectId) : null}
                  runs={runs[task.id] ?? []}
                  dependency={task.dependsOn === null ? null : (byId.get(task.dependsOn) ?? null)}
                  log={logs[task.id] ?? []}
                  draggable={DROP_EVENTS[task.status] !== undefined}
                  onDragStart={setDragging}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                  onAction={onAction}
                  onOpenLog={onOpenLog}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
