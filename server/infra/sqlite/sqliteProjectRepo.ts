import type { Database, Statement } from 'better-sqlite3';
import { type NewProject, type Project, type ProjectPatch, ProjectSchema } from '@shared/project';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { Clock, ProjectRepo } from '../../services/ports';
import { definedOnly, sqliteCode, toFlag } from './sqliteUtil';

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  type: string;
  working_branch: string;
  merge_target: string | null;
  accept_commit: number;
  accept_followup: string;
  push_after_merge: number;
  commit_message_format: string;
  default_model: string;
  default_turn_limit: number;
  allowed_commands: string;
  check_commands: string;
  auto_fix: number;
  dev_command: string | null;
  dev_url: string | null;
  screenshot_sizes: string;
  paused: number;
  created_at: string;
  updated_at: string;
}

type ProjectParams = Omit<ProjectRow, 'id' | 'paused' | 'created_at'>;

// One list drives both statements, so a new setting cannot be saved on create but lost on update.
const COLUMNS: readonly (keyof ProjectParams)[] = [
  'name',
  'repo_path',
  'type',
  'working_branch',
  'merge_target',
  'accept_commit',
  'accept_followup',
  'push_after_merge',
  'commit_message_format',
  'default_model',
  'default_turn_limit',
  'allowed_commands',
  'check_commands',
  'auto_fix',
  'dev_command',
  'dev_url',
  'screenshot_sizes',
  'updated_at',
];

function fromRow(r: ProjectRow): Project {
  return ProjectSchema.parse({
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    type: r.type,
    workingBranch: r.working_branch,
    mergeTarget: r.merge_target,
    acceptCommit: r.accept_commit === 1,
    acceptFollowup: r.accept_followup,
    pushAfterMerge: r.push_after_merge === 1,
    commitMessageFormat: r.commit_message_format,
    defaultModel: r.default_model,
    defaultTurnLimit: r.default_turn_limit,
    allowedCommands: JSON.parse(r.allowed_commands),
    checkCommands: JSON.parse(r.check_commands),
    autoFix: r.auto_fix === 1,
    devCommand: r.dev_command,
    devUrl: r.dev_url,
    screenshotSizes: JSON.parse(r.screenshot_sizes),
    paused: r.paused === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function toParams(p: NewProject, updatedAt: string): ProjectParams {
  return {
    name: p.name,
    repo_path: p.repoPath,
    type: p.type,
    working_branch: p.workingBranch,
    merge_target: p.mergeTarget,
    accept_commit: toFlag(p.acceptCommit),
    accept_followup: p.acceptFollowup,
    push_after_merge: toFlag(p.pushAfterMerge),
    commit_message_format: p.commitMessageFormat,
    default_model: p.defaultModel,
    default_turn_limit: p.defaultTurnLimit,
    allowed_commands: JSON.stringify(p.allowedCommands),
    check_commands: JSON.stringify(p.checkCommands),
    auto_fix: toFlag(p.autoFix),
    dev_command: p.devCommand,
    dev_url: p.devUrl,
    screenshot_sizes: JSON.stringify(p.screenshotSizes),
    updated_at: updatedAt,
  };
}

export class SqliteProjectRepo implements ProjectRepo {
  private readonly _insert: Statement<[ProjectParams & { created_at: string }], ProjectRow>;
  private readonly _update: Statement<[ProjectParams & { id: number }]>;
  private readonly _get: Statement<[number], ProjectRow>;
  private readonly _list: Statement<[], ProjectRow>;
  private readonly _setPaused: Statement<{ id: number; paused: number; now: string }>;

  constructor(
    db: Database,
    private readonly _clock: Clock,
  ) {
    const insertCols = [...COLUMNS, 'created_at'];
    this._insert = db.prepare(`
      INSERT INTO projects (${insertCols.join(', ')})
      VALUES (${insertCols.map((c) => `@${c}`).join(', ')})
      RETURNING *`);
    this._update = db.prepare(`UPDATE projects SET ${COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`);
    this._get = db.prepare('SELECT * FROM projects WHERE id = ?');
    this._list = db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE');
    this._setPaused = db.prepare('UPDATE projects SET paused = @paused, updated_at = @now WHERE id = @id');
  }

  create(project: NewProject): Project {
    const now = this._clock();
    return this._writing(() => {
      const row = this._insert.get({ ...toParams(project, now), created_at: now });
      if (!row) throw new Error('INSERT RETURNING gave no row');
      return fromRow(row);
    });
  }

  get(id: number): Project | undefined {
    const row = this._get.get(id);
    return row && fromRow(row);
  }

  list(): Project[] {
    return this._list.all().map(fromRow);
  }

  update(id: number, patch: ProjectPatch): Project {
    const existing = this.get(id);
    if (!existing) throw new NotFoundError('project', id);
    const next = { ...existing, ...definedOnly(patch) };
    return this._writing(() => {
      this._update.run({ ...toParams(next, this._clock()), id });
      return this.get(id) ?? existing;
    });
  }

  setPaused(id: number, paused: boolean): Project {
    if (this._setPaused.run({ id, paused: toFlag(paused), now: this._clock() }).changes === 0) {
      throw new NotFoundError('project', id);
    }
    const project = this.get(id);
    if (!project) throw new NotFoundError('project', id);
    return project;
  }

  private _writing<T>(write: () => T): T {
    try {
      return write();
    } catch (err) {
      if (sqliteCode(err) === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Another project already uses this name or repo path');
      }
      throw err;
    }
  }
}
