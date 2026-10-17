import { describe, expect, it } from 'vitest';
import type { Run, RunLogLine } from '@shared/run';
import type { Task } from '@shared/task';
import { boardReducer, initialBoardState, usageTotals } from './boardState';

const task = (id: number, status: Task['status'] = 'backlog'): Task => ({
  id,
  projectId: 1,
  title: `Task ${id}`,
  description: '',
  acceptanceCriteria: '',
  status,
  priority: 'normal',
  position: id,
  visual: false,
  routes: [],
  model: 'sonnet',
  turnLimit: 30,
  dependsOn: null,
  gitIssue: null,
  gitIssueDetail: null,
  pendingPush: null,
  commitSha: null,
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
});

const line = (runId: number, seq: number, text = `line ${seq}`): RunLogLine => ({
  runId,
  seq,
  kind: 'text',
  text,
  at: '2026-10-16T09:00:00.000Z',
});

const run = (id: number, outcome: Run['outcome'] = 'running'): Run => ({
  id,
  taskId: 1,
  kind: 'initial',
  outcome,
  sessionId: null,
  pid: null,
  model: 'sonnet',
  turnLimit: 30,
  input: '',
  numTurns: null,
  inputTokens: null,
  outputTokens: null,
  cacheCreationTokens: null,
  cacheReadTokens: null,
  costUsd: null,
  error: null,
  startedAt: '2026-10-16T09:00:00.000Z',
  endedAt: null,
  review: null,
  checksPassed: null,
  checksFailed: null,
});

describe('boardReducer', () => {
  it('adds new tasks and replaces known ones from events', () => {
    let state = boardReducer(initialBoardState, { type: 'loaded', projects: [], tasks: [task(1), task(2)], statuses: [] });
    state = boardReducer(state, { type: 'event', event: { type: 'task', task: task(2, 'todo') } });
    state = boardReducer(state, { type: 'event', event: { type: 'task', task: task(3) } });
    expect(state.tasks.map((t) => [t.id, t.status])).toEqual([
      [1, 'backlog'],
      [2, 'todo'],
      [3, 'backlog'],
    ]);
  });

  it('drops a deleted task', () => {
    let state = boardReducer(initialBoardState, { type: 'loaded', projects: [], tasks: [task(1), task(2)], statuses: [] });
    state = boardReducer(state, { type: 'event', event: { type: 'taskDeleted', taskId: 1 } });
    expect(state.tasks.map((t) => t.id)).toEqual([2]);
  });

  it('ignores a task update older than the one it already has', () => {
    const started = { ...task(1, 'in_progress'), updatedAt: '2026-10-16T09:00:02.000Z' };
    const staleReply = { ...task(1, 'todo'), updatedAt: '2026-10-16T09:00:01.000Z' };
    let state = boardReducer(initialBoardState, { type: 'event', event: { type: 'task', task: started } });
    state = boardReducer(state, { type: 'event', event: { type: 'task', task: staleReply } });
    expect(state.tasks[0]?.status).toBe('in_progress');
  });

  it('merges streamed and fetched log lines without duplicates, in order', () => {
    let state = boardReducer(initialBoardState, { type: 'event', event: { type: 'log', taskId: 1, lines: [line(1, 3)] } });
    state = boardReducer(state, { type: 'logLoaded', taskId: 1, lines: [line(1, 1), line(1, 2), line(1, 3)] });
    state = boardReducer(state, { type: 'event', event: { type: 'log', taskId: 1, lines: [line(2, 1)] } });
    expect(state.logs[1]?.map((l) => `${l.runId}:${l.seq}`)).toEqual(['1:1', '1:2', '1:3', '2:1']);
  });

  it('keeps only the newest lines of a long log', () => {
    const lines = Array.from({ length: 1_200 }, (_, i) => line(1, i + 1));
    const state = boardReducer(initialBoardState, { type: 'logLoaded', taskId: 1, lines });
    expect(state.logs[1]).toHaveLength(1_000);
    expect(state.logs[1]?.[0]?.seq).toBe(201);
  });

  it('tracks why a project is waiting', () => {
    let state = boardReducer(initialBoardState, {
      type: 'loaded',
      projects: [],
      tasks: [],
      statuses: [
        { projectId: 1, blocked: 'Uncommitted changes: a.txt' },
        { projectId: 2, blocked: null },
      ],
    });
    expect(state.blocked).toEqual({ 1: 'Uncommitted changes: a.txt' });
    state = boardReducer(state, { type: 'event', event: { type: 'projectStatus', projectId: 2, blocked: 'Repo is on main' } });
    state = boardReducer(state, { type: 'event', event: { type: 'projectStatus', projectId: 1, blocked: null } });
    expect(state.blocked).toEqual({ 2: 'Repo is on main' });
  });

  it('updates a run in place when it finishes', () => {
    let state = boardReducer(initialBoardState, { type: 'event', event: { type: 'run', run: run(5) } });
    state = boardReducer(state, { type: 'event', event: { type: 'run', run: run(5, 'completed') } });
    expect(state.runs[1]?.map((r) => r.outcome)).toEqual(['completed']);
  });
});

describe('usageTotals', () => {
  const usage = (projectId: number, costUsd: number, numTurns: number) => ({
    projectId,
    runs: 2,
    numTurns,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    costUsd,
  });

  it('sums every project, or picks one', () => {
    const all = [usage(1, 0.5, 10), usage(2, 0.25, 4)];
    expect(usageTotals(all, null)).toEqual({
      runs: 4,
      numTurns: 14,
      inputTokens: 20,
      outputTokens: 40,
      cacheCreationTokens: 60,
      cacheReadTokens: 80,
      costUsd: 0.75,
    });
    expect(usageTotals(all, 2)).toMatchObject({ runs: 2, numTurns: 4, costUsd: 0.25 });
    expect(usageTotals(all, 9).runs).toBe(0);
  });

  it('replaces the totals when they are reloaded', () => {
    const state = boardReducer(initialBoardState, { type: 'usageLoaded', usage: [usage(1, 1, 1)] });
    expect(state.usage).toEqual([usage(1, 1, 1)]);
  });
});
