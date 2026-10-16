import type { Database, Statement } from 'better-sqlite3';
import { type NewTemplate, type TaskTemplate, TaskTemplateSchema, type TemplatePatch } from '@shared/template';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { Clock, TemplateRepo } from '../../services/ports';
import { definedOnly, sqliteCode, toFlag } from './sqliteUtil';

interface TemplateRow {
  id: number;
  project_id: number;
  name: string;
  title_prefix: string;
  description: string;
  acceptance_criteria: string;
  priority: string;
  visual: number;
  routes: string;
  model: string | null;
  turn_limit: number | null;
  created_at: string;
  updated_at: string;
}

type TemplateParams = Omit<TemplateRow, 'id' | 'project_id' | 'created_at'>;

// One list drives both statements, so a new field cannot be saved on create but lost on update.
const COLUMNS: readonly (keyof TemplateParams)[] = [
  'name',
  'title_prefix',
  'description',
  'acceptance_criteria',
  'priority',
  'visual',
  'routes',
  'model',
  'turn_limit',
  'updated_at',
];

function fromRow(r: TemplateRow): TaskTemplate {
  return TaskTemplateSchema.parse({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    titlePrefix: r.title_prefix,
    description: r.description,
    acceptanceCriteria: r.acceptance_criteria,
    priority: r.priority,
    visual: r.visual === 1,
    routes: JSON.parse(r.routes),
    model: r.model,
    turnLimit: r.turn_limit,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function toParams(t: NewTemplate, updatedAt: string): TemplateParams {
  return {
    name: t.name,
    title_prefix: t.titlePrefix,
    description: t.description,
    acceptance_criteria: t.acceptanceCriteria,
    priority: t.priority,
    visual: toFlag(t.visual),
    routes: JSON.stringify(t.routes),
    model: t.model,
    turn_limit: t.turnLimit,
    updated_at: updatedAt,
  };
}

export class SqliteTemplateRepo implements TemplateRepo {
  private readonly _insert: Statement<[TemplateParams & { project_id: number; created_at: string }], TemplateRow>;
  private readonly _update: Statement<[TemplateParams & { id: number }]>;
  private readonly _get: Statement<[number], TemplateRow>;
  private readonly _byProject: Statement<[number], TemplateRow>;
  private readonly _delete: Statement<[number]>;

  constructor(
    db: Database,
    private readonly _clock: Clock,
  ) {
    const insertCols = ['project_id', ...COLUMNS, 'created_at'];
    this._insert = db.prepare(`
      INSERT INTO task_templates (${insertCols.join(', ')})
      VALUES (${insertCols.map((c) => `@${c}`).join(', ')})
      RETURNING *`);
    this._update = db.prepare(`UPDATE task_templates SET ${COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`);
    this._get = db.prepare('SELECT * FROM task_templates WHERE id = ?');
    this._byProject = db.prepare('SELECT * FROM task_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE');
    this._delete = db.prepare('DELETE FROM task_templates WHERE id = ?');
  }

  create(projectId: number, template: NewTemplate): TaskTemplate {
    const now = this._clock();
    return this._writing(projectId, () => {
      const row = this._insert.get({ ...toParams(template, now), project_id: projectId, created_at: now });
      if (!row) throw new Error('INSERT RETURNING gave no row');
      return fromRow(row);
    });
  }

  get(id: number): TaskTemplate | undefined {
    const row = this._get.get(id);
    return row && fromRow(row);
  }

  listByProject(projectId: number): TaskTemplate[] {
    return this._byProject.all(projectId).map(fromRow);
  }

  update(id: number, patch: TemplatePatch): TaskTemplate {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError('template', id);
    const next = { ...existing, ...definedOnly(patch) };
    return this._writing(existing.projectId, () => {
      this._update.run({ ...toParams(next, this._clock()), id });
      return this.get(id) ?? existing;
    });
  }

  delete(id: number): void {
    if (this._delete.run(id).changes === 0) throw new NotFoundError('template', id);
  }

  private _writing<T>(projectId: number, write: () => T): T {
    try {
      return write();
    } catch (err) {
      const code = sqliteCode(err);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ConflictError('This project already has a template with that name');
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new NotFoundError('project', projectId);
      throw err;
    }
  }
}
