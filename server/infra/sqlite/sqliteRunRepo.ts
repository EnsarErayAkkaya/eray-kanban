import type { Database, Statement, Transaction } from 'better-sqlite3';
import { type ReviewJson, ReviewJsonSchema } from '@shared/review';
import { type Run, type RunLogLine, RunLogLineSchema, RunSchema } from '@shared/run';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { Clock, NewLogLine, NewRun, RunEnd, RunRepo } from '../../services/ports';
import { sqliteCode } from './sqliteUtil';

const StoredReview = ReviewJsonSchema.nullable();

interface RunRow {
  review_json: string | null;
  id: number;
  task_id: number;
  kind: string;
  outcome: string;
  session_id: string | null;
  pid: number | null;
  model: string;
  turn_limit: number;
  input: string;
  num_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

interface LogRow {
  run_id: number;
  seq: number;
  kind: string;
  text: string;
  at: string;
}

interface FinishParams {
  id: number;
  outcome: string;
  num_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  now: string;
}

function fromRow(r: RunRow): Run {
  return RunSchema.parse({
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    outcome: r.outcome,
    sessionId: r.session_id,
    pid: r.pid,
    model: r.model,
    turnLimit: r.turn_limit,
    input: r.input,
    numTurns: r.num_turns,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    costUsd: r.cost_usd,
    error: r.error,
    review: StoredReview.parse(r.review_json === null ? null : JSON.parse(r.review_json)),
    startedAt: r.started_at,
    endedAt: r.ended_at,
  });
}

function fromLogRow(r: LogRow): RunLogLine {
  return RunLogLineSchema.parse({ runId: r.run_id, seq: r.seq, kind: r.kind, text: r.text, at: r.at });
}

export class SqliteRunRepo implements RunRepo {
  private readonly _insert: Statement<
    [{ task_id: number; session_id: string; kind: string; model: string; turn_limit: number; input: string; now: string }],
    RunRow
  >;
  private readonly _setSession: Statement<[string, number]>;
  private readonly _setPid: Statement<[number, number]>;
  private readonly _setReview: Statement<[string, number]>;
  private readonly _running: Statement<[], RunRow>;
  private readonly _finish: Statement<[FinishParams]>;
  private readonly _get: Statement<[number], RunRow>;
  private readonly _byTask: Statement<[number], RunRow>;
  private readonly _logAfter: Statement<[number, number], LogRow>;
  private readonly _appendLog: Transaction<(runId: number, lines: readonly NewLogLine[]) => RunLogLine[]>;

  constructor(
    db: Database,
    private readonly _clock: Clock,
  ) {
    this._insert = db.prepare(`
      INSERT INTO runs (task_id, session_id, kind, model, turn_limit, input, started_at)
      VALUES (@task_id, @session_id, @kind, @model, @turn_limit, @input, @now)
      RETURNING *`);
    this._setSession = db.prepare('UPDATE runs SET session_id = ? WHERE id = ?');
    this._setPid = db.prepare('UPDATE runs SET pid = ? WHERE id = ?');
    this._setReview = db.prepare('UPDATE runs SET review_json = ? WHERE id = ?');
    this._running = db.prepare("SELECT * FROM runs WHERE outcome = 'running' ORDER BY id");
    this._finish = db.prepare(`
      UPDATE runs SET outcome = @outcome, num_turns = @num_turns, input_tokens = @input_tokens,
        output_tokens = @output_tokens, cache_creation_tokens = @cache_creation_tokens,
        cache_read_tokens = @cache_read_tokens, cost_usd = @cost_usd, error = @error, ended_at = @now
      WHERE id = @id AND outcome = 'running'`);
    this._get = db.prepare('SELECT * FROM runs WHERE id = ?');
    this._byTask = db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id');
    this._logAfter = db.prepare('SELECT * FROM run_log WHERE run_id = ? AND seq > ? ORDER BY seq');

    const maxSeq = db.prepare<[number], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM run_log WHERE run_id = ?');
    const insertLog = db.prepare<[LogRow]>('INSERT INTO run_log (run_id, seq, kind, text, at) VALUES (@run_id, @seq, @kind, @text, @at)');
    this._appendLog = db.transaction((runId: number, lines: readonly NewLogLine[]) => {
      let seq = maxSeq.get(runId)?.seq ?? 0;
      const at = this._clock();
      return lines.map((line) => {
        const row = { run_id: runId, seq: ++seq, kind: line.kind, text: line.text, at };
        insertLog.run(row);
        return fromLogRow(row);
      });
    });
  }

  start(run: NewRun): Run {
    try {
      const row = this._insert.get({
        task_id: run.taskId,
        session_id: run.sessionId,
        kind: run.kind,
        model: run.model,
        turn_limit: run.turnLimit,
        input: run.input,
        now: this._clock(),
      });
      if (!row) throw new Error('INSERT RETURNING gave no row');
      return fromRow(row);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new NotFoundError('task', run.taskId);
      throw err;
    }
  }

  setSessionId(runId: number, sessionId: string): void {
    if (this._setSession.run(sessionId, runId).changes === 0) throw new NotFoundError('run', runId);
  }

  setPid(runId: number, pid: number): void {
    if (this._setPid.run(pid, runId).changes === 0) throw new NotFoundError('run', runId);
  }

  setReview(runId: number, review: ReviewJson): void {
    if (this._setReview.run(JSON.stringify(review), runId).changes === 0) throw new NotFoundError('run', runId);
  }

  listRunning(): Run[] {
    return this._running.all().map(fromRow);
  }

  finish(runId: number, end: RunEnd): Run {
    const u = end.usage;
    const res = this._finish.run({
      id: runId,
      outcome: end.outcome,
      num_turns: u?.numTurns ?? null,
      input_tokens: u?.inputTokens ?? null,
      output_tokens: u?.outputTokens ?? null,
      cache_creation_tokens: u?.cacheCreationTokens ?? null,
      cache_read_tokens: u?.cacheReadTokens ?? null,
      cost_usd: u?.costUsd ?? null,
      error: end.error,
      now: this._clock(),
    });
    const run = this.get(runId);
    if (!run) throw new NotFoundError('run', runId);
    if (res.changes === 0) throw new ConflictError(`Run ${runId} already finished as ${run.outcome}`);
    return run;
  }

  get(id: number): Run | undefined {
    const row = this._get.get(id);
    return row && fromRow(row);
  }

  listByTask(taskId: number): Run[] {
    return this._byTask.all(taskId).map(fromRow);
  }

  appendLog(runId: number, lines: readonly NewLogLine[]): RunLogLine[] {
    try {
      return this._appendLog(runId, lines);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new NotFoundError('run', runId);
      throw err;
    }
  }

  logAfter(runId: number, afterSeq: number): RunLogLine[] {
    return this._logAfter.all(runId, afterSeq).map(fromLogRow);
  }
}
