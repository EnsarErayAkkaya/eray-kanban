import type { Database, Statement, Transaction } from 'better-sqlite3';
import { type Screenshot, ScreenshotSchema } from '@shared/screenshot';
import { NotFoundError } from '../../domain/errors';
import type { Clock, ScreenshotRepo, Shot } from '../../services/ports';
import { sqliteCode } from './sqliteUtil';

interface ShotRow {
  id: number;
  run_id: number;
  route: string;
  size: string;
  width: number;
  height: number;
  file: string | null;
  error: string | null;
  taken_at: string;
}

function fromRow(r: ShotRow): Screenshot {
  return ScreenshotSchema.parse({
    id: r.id,
    runId: r.run_id,
    route: r.route,
    size: r.size,
    width: r.width,
    height: r.height,
    hasImage: r.file !== null,
    error: r.error,
    takenAt: r.taken_at,
  });
}

export class SqliteScreenshotRepo implements ScreenshotRepo {
  private readonly _save: Transaction<(runId: number, shots: readonly Shot[]) => Screenshot[]>;
  private readonly _byTask: Statement<[number], ShotRow>;
  private readonly _file: Statement<[number], { file: string | null }>;

  constructor(
    db: Database,
    private readonly _clock: Clock,
  ) {
    const insert = db.prepare<[Omit<ShotRow, 'id'>], ShotRow>(`
      INSERT INTO screenshots (run_id, route, size, width, height, file, error, taken_at)
      VALUES (@run_id, @route, @size, @width, @height, @file, @error, @taken_at)
      RETURNING *`);
    this._save = db.transaction((runId: number, shots: readonly Shot[]) => {
      const takenAt = this._clock();
      return shots.flatMap((s) => {
        const row = insert.get({
          run_id: runId,
          route: s.route,
          size: s.size,
          width: s.width,
          height: s.height,
          file: s.file,
          error: s.error,
          taken_at: takenAt,
        });
        return row ? [fromRow(row)] : [];
      });
    });
    this._byTask = db.prepare(`
      SELECT s.* FROM screenshots s JOIN runs r ON r.id = s.run_id
      WHERE r.task_id = ? ORDER BY s.run_id, s.id`);
    this._file = db.prepare('SELECT file FROM screenshots WHERE id = ?');
  }

  save(runId: number, shots: readonly Shot[]): Screenshot[] {
    try {
      return this._save(runId, shots);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new NotFoundError('run', runId);
      throw err;
    }
  }

  listByTask(taskId: number): Screenshot[] {
    return this._byTask.all(taskId).map(fromRow);
  }

  fileOf(id: number): string | null | undefined {
    return this._file.get(id)?.file;
  }
}
