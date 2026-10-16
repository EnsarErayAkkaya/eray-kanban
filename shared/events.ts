import type { Run, RunLogLine } from './run';
import type { Task } from './task';

// Pushed to the UI over SSE.
export type BoardEvent =
  | { readonly type: 'task'; readonly task: Task }
  | { readonly type: 'run'; readonly run: Run }
  | { readonly type: 'log'; readonly taskId: number; readonly lines: readonly RunLogLine[] };
