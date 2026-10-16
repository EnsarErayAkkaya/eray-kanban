import type { TaskStatus } from '@shared/taskStatus';

export const TASK_EVENTS = [
  'promote',
  'demote',
  'start',
  'askInput',
  'answer',
  'submit',
  'reject',
  'accept',
  'cancel',
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

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
};

// Invariant 3: while a task is in one of these, its project runs nothing else.
const PROJECT_OCCUPYING: readonly TaskStatus[] = ['in_progress', 'needs_input', 'in_review'];

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

export function applyEvent<T extends { readonly status: TaskStatus }>(task: T, event: TaskEvent): T {
  return { ...task, status: nextStatus(task.status, event) };
}

export function occupiesProject(status: TaskStatus): boolean {
  return PROJECT_OCCUPYING.includes(status);
}
