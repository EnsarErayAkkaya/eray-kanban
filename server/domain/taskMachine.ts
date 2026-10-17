import type { TaskEvent, TaskStatus } from '@shared/taskStatus';

export { TASK_EVENTS, type TaskEvent } from '@shared/taskStatus';

interface Transition {
  readonly from: readonly TaskStatus[];
  readonly to: TaskStatus;
}

// submit also covers a run that hit its turn limit or was stopped; the reason lives on the run.
const TRANSITIONS: Readonly<Record<TaskEvent, Transition>> = {
  promote: { from: ['backlog'], to: 'todo' },
  demote: { from: ['todo'], to: 'backlog' },
  start: { from: ['todo'], to: 'in_progress' },
  askInput: { from: ['in_progress'], to: 'needs_input' },
  answer: { from: ['needs_input'], to: 'in_progress' },
  submit: { from: ['in_progress'], to: 'in_review' },
  reject: { from: ['in_review'], to: 'in_progress' },
  accept: { from: ['in_review'], to: 'done' },
  cancel: { from: ['backlog', 'todo', 'in_progress', 'needs_input', 'in_review'], to: 'cancelled' },
  reopen: { from: ['cancelled'], to: 'backlog' },
};

// Invariant 3: while a task is in one of these, its project runs nothing else.
export const OCCUPYING_STATUSES: readonly TaskStatus[] = ['in_progress', 'needs_input', 'in_review'];

// The only value a repo accepts for writing task.status, so every write is decided here.
export interface StatusChange {
  readonly taskId: number;
  readonly event: TaskEvent;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly event: TaskEvent,
  ) {
    super(`Cannot ${event} a task in ${from}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TaskStatus, event: TaskEvent): boolean {
  return TRANSITIONS[event].from.includes(from);
}

export function nextStatus(from: TaskStatus, event: TaskEvent): TaskStatus {
  if (!canTransition(from, event)) throw new IllegalTransitionError(from, event);
  return TRANSITIONS[event].to;
}

export function transition(
  task: { readonly id: number; readonly status: TaskStatus },
  event: TaskEvent,
): StatusChange {
  return { taskId: task.id, event, from: task.status, to: nextStatus(task.status, event) };
}

export function occupiesProject(status: TaskStatus): boolean {
  return OCCUPYING_STATUSES.includes(status);
}
