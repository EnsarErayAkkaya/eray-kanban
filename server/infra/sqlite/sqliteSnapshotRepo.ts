import type { Database, Statement } from 'better-sqlite3';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { Clock, RepoSnapshot, SnapshotRepo } from '../../services/ports';
import { sqliteCode } from './sqliteUtil';

interface SnapshotRow {
  task_id: number;
  branch: string;
  head: string;
  untracked: string;
  empty_dirs: string;
  created_at: string;
}

const Paths = z.array(z.string());

export class SqliteSnapshotRepo implements SnapshotRepo {
  private readonly _insert: Statement<[SnapshotRow]>;
  private readonly _get: Statement<[number], SnapshotRow>;

  constructor(
    db: Database,
    private readonly _clock: Clock,
  ) {
    this._insert = db.prepare(`
      INSERT INTO snapshots (task_id, branch, head, untracked, empty_dirs, created_at)
      VALUES (@task_id, @branch, @head, @untracked, @empty_dirs, @created_at)`);
    this._get = db.prepare('SELECT * FROM snapshots WHERE task_id = ?');
  }

  save(taskId: number, snapshot: RepoSnapshot): void {
    try {
      this._insert.run({
        task_id: taskId,
        branch: snapshot.branch,
        head: snapshot.head,
        untracked: JSON.stringify(snapshot.untracked),
        empty_dirs: JSON.stringify(snapshot.emptyDirs),
        created_at: this._clock(),
      });
    } catch (err) {
      const code = sqliteCode(err);
      if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY') throw new ConflictError(`Task ${taskId} already has a snapshot`);
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new NotFoundError('task', taskId);
      throw err;
    }
  }

  get(taskId: number): RepoSnapshot | undefined {
    const row = this._get.get(taskId);
    if (!row) return undefined;
    return {
      branch: row.branch,
      head: row.head,
      untracked: Paths.parse(JSON.parse(row.untracked)),
      emptyDirs: Paths.parse(JSON.parse(row.empty_dirs)),
    };
  }
}
