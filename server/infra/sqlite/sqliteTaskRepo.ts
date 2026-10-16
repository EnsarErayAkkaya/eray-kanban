import type { Database, Statement } from 'better-sqlite3';
import { type Task, type TaskPatch, TaskSchema } from '@shared/task';
import { ConflictError, NotFoundError, ProjectBusyError, StaleStatusError } from '../../domain/errors';
import { OCCUPYING_STATUSES, type StatusChange } from '../../domain/taskMachine';
import type { Clock, NewTask, TaskGitIssue, TaskRepo } from '../../services/ports';
import { definedOnly, sqliteCode, toFlag } from './sqliteUtil';

interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: string;
  priority: string;
  position: number;
  visual: number;
  routes: string;
  model: string;
  turn_limit: number;
  depends_on: number | null;
  git_issue: string | null;
  git_issue_detail: string | null;
  pending_push: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

type EditableParams = Pick<
  TaskRow,
  'title' | 'description' | 'acceptance_criteria' | 'priority' | 'visual' | 'routes' | 'model' | 'turn_limit' | 'depends_on'
>;

function fromRow(r: TaskRow): Task {
  return TaskSchema.parse({
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    acceptanceCriteria: r.acceptance_criteria,
    status: r.status,
    priority: r.priority,
    position: r.position,
    visual: r.visual === 1,
    routes: JSON.parse(r.routes),
    model: r.model,
    turnLimit: r.turn_limit,
    dependsOn: r.depends_on,
    gitIssue: r.git_issue,
    gitIssueDetail: r.git_issue_detail,
    pendingPush: r.pending_push,
    commitSha: r.commit_sha,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function toEditable(t: Omit<NewTask, 'projectId'>): EditableParams {
  return {
    title: t.title,
    description: t.description,
    acceptance_criteria: t.acceptanceCriteria,
    priority: t.priority,
    visual: toFlag(t.visual),
    routes: JSON.stringify(t.routes),
    model: t.model,
    turn_limit: t.turnLimit,
    depends_on: t.dependsOn,
  };
}

const OCCUPYING_SQL = OCCUPYING_STATUSES.map((s) => `'${s}'`).join(', ');

export class SqliteTaskRepo implements TaskRepo {
  private readonly _insert: Statement<[EditableParams & { project_id: number; now: string }], TaskRow>;
  private readonly _update: Statement<[EditableParams & { id: number; now: string }]>;
  private readonly _setStatus: Statement<{ id: number; from: string; to: string; now: string }>;
  private readonly _get: Statement<[number], TaskRow>;
  private readonly _listAll: Statement<[], TaskRow>;
  private readonly _listByProject: Statement<[number], TaskRow>;
  private readonly _nextTodo: Statement<[number], TaskRow>;
  private readonly _active: Statement<[number], TaskRow>;
  private readonly _setGitIssue: Statement<{
    id: number;
    issue: string | null;
    detail: string | null;
    pending: string | null;
    now: string;
  }>;
  private readonly _setCommitSha: Statement<{ id: number; sha: string; now: string }>;

  constructor(
    db: Database,
    private readonly _clock: Clock,
  ) {
    this._insert = db.prepare(`
      INSERT INTO tasks (project_id, title, description, acceptance_criteria, priority, position, visual, routes,
        model, turn_limit, depends_on, created_at, updated_at)
      VALUES (@project_id, @title, @description, @acceptance_criteria, @priority,
        (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks),
        @visual, @routes, @model, @turn_limit, @depends_on, @now, @now)
      RETURNING *`);
    this._update = db.prepare(`
      UPDATE tasks SET title = @title, description = @description, acceptance_criteria = @acceptance_criteria,
        priority = @priority, visual = @visual, routes = @routes, model = @model, turn_limit = @turn_limit,
        depends_on = @depends_on, updated_at = @now
      WHERE id = @id`);
    this._setStatus = db.prepare('UPDATE tasks SET status = @to, updated_at = @now WHERE id = @id AND status = @from');
    this._get = db.prepare('SELECT * FROM tasks WHERE id = ?');
    this._listAll = db.prepare('SELECT * FROM tasks ORDER BY position');
    this._listByProject = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position');
    this._nextTodo = db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN tasks dep ON dep.id = t.depends_on
      WHERE t.project_id = ? AND t.status = 'todo' AND (t.depends_on IS NULL OR dep.status = 'done')
      ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.position
      LIMIT 1`);
    this._active = db.prepare(`SELECT * FROM tasks WHERE project_id = ? AND status IN (${OCCUPYING_SQL})`);
    this._setGitIssue = db.prepare(`
      UPDATE tasks SET git_issue = @issue, git_issue_detail = @detail, pending_push = @pending, updated_at = @now
      WHERE id = @id`);
    this._setCommitSha = db.prepare('UPDATE tasks SET commit_sha = @sha, updated_at = @now WHERE id = @id');
  }

  create(task: NewTask): Task {
    return this._writing(() => {
      const row = this._insert.get({ ...toEditable(task), project_id: task.projectId, now: this._clock() });
      if (!row) throw new Error('INSERT RETURNING gave no row');
      return fromRow(row);
    });
  }

  get(id: number): Task | undefined {
    const row = this._get.get(id);
    return row && fromRow(row);
  }

  list(filter: { projectId?: number } = {}): Task[] {
    const rows = filter.projectId === undefined ? this._listAll.all() : this._listByProject.all(filter.projectId);
    return rows.map(fromRow);
  }

  update(id: number, patch: TaskPatch): Task {
    const existing = this._require(id);
    if (patch.dependsOn === id) throw new ConflictError('A task cannot depend on itself');
    const next = { ...existing, ...definedOnly(patch) };
    this._writing(() => this._update.run({ ...toEditable(next), id, now: this._clock() }));
    return this._require(id);
  }

  applyStatusChange(change: StatusChange): Task {
    const existing = this._require(change.taskId);
    try {
      const res = this._setStatus.run({ id: change.taskId, from: change.from, to: change.to, now: this._clock() });
      if (res.changes === 0) throw new StaleStatusError(change.taskId, change.from);
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') throw new ProjectBusyError(existing.projectId);
      throw err;
    }
    return this._require(change.taskId);
  }

  nextTodo(projectId: number): Task | undefined {
    const row = this._nextTodo.get(projectId);
    return row && fromRow(row);
  }

  setGitIssue(id: number, issue: TaskGitIssue | null): Task {
    const params = {
      id,
      issue: issue?.kind ?? null,
      detail: issue?.detail ?? null,
      pending: issue?.pendingPush ?? null,
      now: this._clock(),
    };
    if (this._setGitIssue.run(params).changes === 0) throw new NotFoundError('task', id);
    return this._require(id);
  }

  setCommitSha(id: number, sha: string): Task {
    if (this._setCommitSha.run({ id, sha, now: this._clock() }).changes === 0) throw new NotFoundError('task', id);
    return this._require(id);
  }

  activeTask(projectId: number): Task | undefined {
    const row = this._active.get(projectId);
    return row && fromRow(row);
  }

  private _require(id: number): Task {
    const task = this.get(id);
    if (!task) throw new NotFoundError('task', id);
    return task;
  }

  private _writing<T>(write: () => T): T {
    try {
      return write();
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new ConflictError('Unknown project or dependency task');
      }
      throw err;
    }
  }
}
