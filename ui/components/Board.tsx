import { useState } from 'react';
import type { Project } from '@shared/project';
import type { Run, RunLogLine } from '@shared/run';
import type { Task } from '@shared/task';
import type { TaskStatus } from '@shared/taskStatus';
import { type CardActionId, TaskCard } from './TaskCard';

const COLUMNS: readonly { readonly status: TaskStatus; readonly label: string; readonly hint: string }[] = [
  { status: 'backlog', label: 'Backlog', hint: 'Ideas, not ready for an agent' },
  { status: 'todo', label: 'Todo', hint: 'The agent picks these up in order' },
  { status: 'in_progress', label: 'In Progress', hint: 'Agent working' },
  { status: 'needs_input', label: 'Needs Input', hint: 'The agent asked a question' },
  { status: 'in_review', label: 'In Review', hint: 'Waiting for you; project paused' },
  { status: 'done', label: 'Done', hint: '' },
  { status: 'cancelled', label: 'Cancelled', hint: '' },
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
        const cards = tasks.filter((t) => t.status === col.status).sort(columnOrder);
        const canDrop = dropEvent(col.status) !== undefined;
        return (
          <section
            key={col.status}
            className={`column${canDrop ? ' column--droppable' : ''}${canDrop && dropTarget === col.status ? ' column--over' : ''}`}
            onDragOver={(e) => {
              if (!canDrop) return;
              e.preventDefault();
              setDropTarget(col.status);
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              const event = dropEvent(col.status);
              if (dragging && event) onAction(dragging, event);
              setDragging(null);
              setDropTarget(null);
            }}
          >
            <header className="column__head" title={col.hint}>
              <h2>{col.label}</h2>
              <span className="column__count">{cards.length}</span>
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
