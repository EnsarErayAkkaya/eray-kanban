import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../domain/errors';
import { failedCheck, passedCheck } from '../../services/testFakes';
import { SqliteCheckRepo } from './sqliteCheckRepo';
import { SqliteRunRepo } from './sqliteRunRepo';
import { SqliteTaskRepo } from './sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from './testDb';

describe('SqliteCheckRepo', () => {
  let repo: SqliteCheckRepo;
  let runs: SqliteRunRepo;
  let taskId: number;
  const startRun = () => runs.start({ taskId, sessionId: 's', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' }).id;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    taskId = new SqliteTaskRepo(db, clock).create(newTask(seedProject(db, clock).id)).id;
    runs = new SqliteRunRepo(db, clock);
    repo = new SqliteCheckRepo(db);
  });

  it('stores results in order and counts them on the run', () => {
    const runId = startRun();
    repo.save(runId, [passedCheck('npm run typecheck'), failedCheck('npm run lint')]);
    expect(repo.listByTask(taskId)).toEqual([{ runId, results: [passedCheck('npm run typecheck'), failedCheck('npm run lint')] }]);
    expect(runs.get(runId)).toMatchObject({ checksPassed: 1, checksFailed: 1 });
  });

  it('groups results by run, oldest first', () => {
    const first = startRun();
    const second = startRun();
    repo.save(second, [passedCheck('b')]);
    repo.save(first, [failedCheck('a')]);
    expect(repo.listByTask(taskId).map((c) => c.runId)).toEqual([first, second]);
  });

  it('replaces the results when a run is checked again', () => {
    const runId = startRun();
    repo.save(runId, [failedCheck('npm test')]);
    repo.save(runId, [passedCheck('npm test')]);
    expect(repo.listByTask(taskId)[0]?.results).toEqual([passedCheck('npm test')]);
    expect(runs.get(runId)).toMatchObject({ checksPassed: 1, checksFailed: 0 });
  });

  it('rejects results for a missing run', () => {
    expect(() => repo.save(999, [passedCheck('x')])).toThrow(NotFoundError);
  });
});
