import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { NewRun } from '../../services/ports';
import { SqliteRunRepo } from './sqliteRunRepo';
import { SqliteTaskRepo } from './sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from './testDb';

describe('SqliteRunRepo', () => {
  let repo: SqliteRunRepo;
  let run: NewRun;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    const project = seedProject(db, clock);
    const task = new SqliteTaskRepo(db, clock).create(newTask(project.id));
    repo = new SqliteRunRepo(db, clock);
    run = { taskId: task.id, kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'Add settings page' };
  });

  it('starts a run with no usage yet', () => {
    const started = repo.start(run);
    expect(started).toMatchObject({ ...run, outcome: 'running', sessionId: null, numTurns: null, endedAt: null });
  });

  it('rejects a run for a missing task', () => {
    expect(() => repo.start({ ...run, taskId: 999 })).toThrow(NotFoundError);
  });

  it('records the session id', () => {
    const { id } = repo.start(run);
    repo.setSessionId(id, 'ff3c019d');
    expect(repo.get(id)?.sessionId).toBe('ff3c019d');
    expect(() => repo.setSessionId(999, 'x')).toThrow(NotFoundError);
  });

  it('finishes with usage, once', () => {
    const { id } = repo.start(run);
    const usage = {
      numTurns: 7,
      inputTokens: 12,
      outputTokens: 1069,
      cacheCreationTokens: 3344,
      cacheReadTokens: 26380,
      costUsd: 0.02672,
    };
    const done = repo.finish(id, { outcome: 'completed', usage, error: null });
    expect(done).toMatchObject({ outcome: 'completed', ...usage, error: null });
    expect(done.endedAt).not.toBeNull();
    expect(() => repo.finish(id, { outcome: 'failed', usage: null, error: 'late' })).toThrow(ConflictError);
    expect(repo.get(id)?.outcome).toBe('completed');
  });

  it('finishes a failed run without usage', () => {
    const { id } = repo.start(run);
    expect(repo.finish(id, { outcome: 'timed_out', usage: null, error: 'killed after 30m' })).toMatchObject({
      outcome: 'timed_out',
      numTurns: null,
      error: 'killed after 30m',
    });
  });

  it('lists runs of a task in order', () => {
    const first = repo.start(run);
    const second = repo.start({ ...run, kind: 'feedback', input: 'Use a toggle' });
    expect(repo.listByTask(run.taskId).map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it('numbers log lines across appends and reads after a sequence', () => {
    const { id } = repo.start(run);
    repo.appendLog(id, [
      { kind: 'system', text: 'session started' },
      { kind: 'tool_use', text: 'Write hello.txt' },
    ]);
    const more = repo.appendLog(id, [{ kind: 'text', text: 'DONE' }]);
    expect(more.map((l) => l.seq)).toEqual([3]);
    expect(repo.logAfter(id, 1).map((l) => [l.seq, l.kind, l.text])).toEqual([
      [2, 'tool_use', 'Write hello.txt'],
      [3, 'text', 'DONE'],
    ]);
  });

  it('rejects log lines for a missing run', () => {
    expect(() => repo.appendLog(999, [{ kind: 'text', text: 'x' }])).toThrow(NotFoundError);
  });
});
