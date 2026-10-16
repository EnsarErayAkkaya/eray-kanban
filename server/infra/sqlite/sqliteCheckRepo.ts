import type { Database, Statement, Transaction } from 'better-sqlite3';
import { type CheckResult, CheckResultSchema, type RunChecks } from '@shared/check';
import { NotFoundError } from '../../domain/errors';
import type { CheckRepo } from '../../services/ports';
import { sqliteCode, toFlag } from './sqliteUtil';

interface CheckRow {
  run_id: number;
  seq: number;
  command: string;
  exit_code: number | null;
  passed: number;
  timed_out: number;
  duration_ms: number;
  output: string;
}

function fromRow(r: CheckRow): CheckResult {
  return CheckResultSchema.parse({
    command: r.command,
    exitCode: r.exit_code,
    passed: r.passed === 1,
    timedOut: r.timed_out === 1,
    durationMs: r.duration_ms,
    output: r.output,
  });
}

export class SqliteCheckRepo implements CheckRepo {
  private readonly _save: Transaction<(runId: number, results: readonly CheckResult[]) => void>;
  private readonly _byTask: Statement<[number], CheckRow>;

  constructor(db: Database) {
    const clear = db.prepare<[number]>('DELETE FROM check_results WHERE run_id = ?');
    const insert = db.prepare<[CheckRow]>(`
      INSERT INTO check_results (run_id, seq, command, exit_code, passed, timed_out, duration_ms, output)
      VALUES (@run_id, @seq, @command, @exit_code, @passed, @timed_out, @duration_ms, @output)`);
    const counts = db.prepare<[number, number, number]>('UPDATE runs SET checks_passed = ?, checks_failed = ? WHERE id = ?');
    this._save = db.transaction((runId: number, results: readonly CheckResult[]) => {
      clear.run(runId);
      results.forEach((r, i) =>
        insert.run({
          run_id: runId,
          seq: i + 1,
          command: r.command,
          exit_code: r.exitCode,
          passed: toFlag(r.passed),
          timed_out: toFlag(r.timedOut),
          duration_ms: r.durationMs,
          output: r.output,
        }),
      );
      const passed = results.filter((r) => r.passed).length;
      if (counts.run(passed, results.length - passed, runId).changes === 0) throw new NotFoundError('run', runId);
    });
    this._byTask = db.prepare(`
      SELECT c.* FROM check_results c JOIN runs r ON r.id = c.run_id
      WHERE r.task_id = ? ORDER BY c.run_id, c.seq`);
  }

  save(runId: number, results: readonly CheckResult[]): void {
    try {
      this._save(runId, results);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new NotFoundError('run', runId);
      throw err;
    }
  }

  listByTask(taskId: number): RunChecks[] {
    const byRun = new Map<number, CheckResult[]>();
    for (const row of this._byTask.all(taskId)) {
      const list = byRun.get(row.run_id) ?? [];
      list.push(fromRow(row));
      byRun.set(row.run_id, list);
    }
    return [...byRun].map(([runId, results]) => ({ runId, results }));
  }
}
