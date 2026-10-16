import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../domain/errors';
import { SqliteSnapshotRepo } from './sqliteSnapshotRepo';
import { SqliteTaskRepo } from './sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from './testDb';

const snapshot = { branch: 'develop', head: 'abc123', untracked: ['notes.txt'], emptyDirs: ['assets', 'assets/icons'] };

describe('SqliteSnapshotRepo', () => {
  let repo: SqliteSnapshotRepo;
  let taskId: number;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    taskId = new SqliteTaskRepo(db, clock).create(newTask(seedProject(db, clock).id)).id;
    repo = new SqliteSnapshotRepo(db, clock);
  });

  it('stores and reads back a snapshot', () => {
    repo.save(taskId, snapshot);
    expect(repo.get(taskId)).toEqual(snapshot);
    expect(repo.get(999)).toBeUndefined();
  });

  it('keeps the first snapshot of a task', () => {
    repo.save(taskId, snapshot);
    expect(() => repo.save(taskId, { ...snapshot, head: 'other' })).toThrow(ConflictError);
    expect(repo.get(taskId)?.head).toBe('abc123');
  });

  it('rejects a snapshot for a missing task', () => {
    expect(() => repo.save(999, snapshot)).toThrow(NotFoundError);
  });
});
