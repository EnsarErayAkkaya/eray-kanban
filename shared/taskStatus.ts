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
