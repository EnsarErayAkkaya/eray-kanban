import type { ReviewJson } from '@shared/review';
import type { Run } from '@shared/run';
import { RouteSchema, type Task } from '@shared/task';

export const MAX_AGENT_ROUTES = 5;

export interface ScreenshotRoutes {
  readonly routes: readonly string[];
  readonly source: 'task' | 'agent' | 'none';
  /** What the agent named that was not a usable route, so the log can say so. */
  readonly dropped: readonly string[];
}

/** Your routes always win; without any, a visual task uses the pages the agent said it changed. */
export function pickScreenshotRoutes(task: Task, runs: readonly Run[]): ScreenshotRoutes {
  if (task.routes.length > 0) return { routes: task.routes, source: 'task', dropped: [] };
  const named = latestDoneReview(runs)?.routes ?? [];
  const routes: string[] = [];
  const dropped: string[] = [];
  for (const raw of named) {
    const parsed = RouteSchema.safeParse(raw);
    if (!parsed.success || routes.includes(parsed.data) || routes.length >= MAX_AGENT_ROUTES) dropped.push(raw);
    else routes.push(parsed.data);
  }
  return { routes, source: routes.length > 0 ? 'agent' : 'none', dropped };
}

function latestDoneReview(runs: readonly Run[]): Extract<ReviewJson, { outcome: 'done' }> | undefined {
  for (const run of [...runs].reverse()) {
    if (run.review?.outcome === 'done') return run.review;
  }
  return undefined;
}
