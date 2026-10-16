import { describe, expect, it } from 'vitest';
import type { ReviewJson } from '@shared/review';
import type { Run } from '@shared/run';
import type { Task } from '@shared/task';
import { MAX_AGENT_ROUTES, pickScreenshotRoutes } from './screenshotRoutes';

const task = (routes: string[]) => ({ visual: true, routes }) as Task;
const run = (review: ReviewJson | null) => ({ review }) as Run;
const done = (routes: string[]): ReviewJson => ({ outcome: 'done', summary: 's', notes: [], concerns: [], routes });

describe('pickScreenshotRoutes', () => {
  it('uses your routes whatever the agent said', () => {
    expect(pickScreenshotRoutes(task(['/']), [run(done(['/x']))])).toEqual({ routes: ['/'], source: 'task', dropped: [] });
  });

  it("uses the latest done review's routes, skipping a later question", () => {
    const runs = [run(done(['/old'])), run(done(['/new'])), run({ outcome: 'needs_input', question: 'q', summary: '' })];
    expect(pickScreenshotRoutes(task([]), runs)).toMatchObject({ routes: ['/new'], source: 'agent' });
  });

  it('drops invalid, repeated and extra routes, and reports them', () => {
    const named = ['/a', 'b', '/a', '/b', '/c', '/d', '/e', '/f'];
    const picked = pickScreenshotRoutes(task([]), [run(done(named))]);
    expect(picked.routes).toEqual(['/a', '/b', '/c', '/d', '/e']);
    expect(picked.routes).toHaveLength(MAX_AGENT_ROUTES);
    expect(picked.dropped).toEqual(['b', '/a', '/f']);
  });

  it('has nothing to take when nobody named a page', () => {
    expect(pickScreenshotRoutes(task([]), [run(null), run(done([]))])).toEqual({ routes: [], source: 'none', dropped: [] });
  });
});
