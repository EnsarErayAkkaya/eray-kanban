export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'needs_input',
  'in_review',
  'done',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

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
