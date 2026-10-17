import type { ProjectStatus } from '@shared/events';
import type { NewProject, Project, ProjectPatch } from '@shared/project';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { MAX_PROJECT_FILES, type ProjectFiles } from '@shared/files';
import type { ProjectUsage } from '@shared/run';
import type { GitPort, ProjectRepo, RepoProbe, RunRepo, TaskRepo, WorkScheduler } from './ports';

function devUrlKey(devUrl: string): string {
  const url = new URL(devUrl);
  return `${url.protocol}${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

export class ProjectService {
  constructor(
    private readonly _projects: ProjectRepo,
    private readonly _tasks: TaskRepo,
    private readonly _probe: RepoProbe,
    private readonly _scheduler: WorkScheduler,
    private readonly _runs: Pick<RunRepo, 'usageByProject'>,
    private readonly _git: Pick<GitPort, 'listFiles'>,
  ) {}

  /** For @-references in the task form. */
  async files(id: number): Promise<ProjectFiles> {
    const project = this._projects.get(id);
    if (!project) throw new NotFoundError('project', id);
    const all = await this._git.listFiles(project.repoPath);
    return { files: all.slice(0, MAX_PROJECT_FILES), truncated: all.length > MAX_PROJECT_FILES };
  }

  list(): Project[] {
    return this._projects.list();
  }

  statuses(): ProjectStatus[] {
    return this._scheduler.statuses();
  }

  usage(): ProjectUsage[] {
    return this._runs.usageByProject();
  }

  /** "Check again" after you cleaned the tree or switched branch; the result arrives as a projectStatus event. */
  check(id: number): void {
    if (!this._projects.get(id)) throw new NotFoundError('project', id);
    void this._scheduler.kick(id);
  }

  create(input: NewProject): Project {
    this._requireGitRepo(input.repoPath);
    this._requireOwnDevUrl(input.devUrl, null);
    return this._projects.create(input);
  }

  update(id: number, patch: ProjectPatch): Project {
    if (!this._projects.get(id)) throw new NotFoundError('project', id);
    if (patch.repoPath !== undefined) {
      this._requireGitRepo(patch.repoPath);
      if (this._tasks.activeTask(id)) throw new ConflictError('Cannot move the repo while a task is active');
    }
    if (patch.devUrl !== undefined) this._requireOwnDevUrl(patch.devUrl, id);
    return this._projects.update(id, patch);
  }

  // Two projects on one port would screenshot each other's app; localhost, 127.0.0.1 and ::1 count as one.
  private _requireOwnDevUrl(devUrl: string | null, selfId: number | null): void {
    if (devUrl === null) return;
    const key = devUrlKey(devUrl);
    const other = this._projects.list().find((p) => p.id !== selfId && p.devUrl !== null && devUrlKey(p.devUrl) === key);
    if (other) throw new ConflictError(`${other.name} already uses this dev server address`);
  }

  private _requireGitRepo(path: string): void {
    if (!this._probe.isGitRepo(path)) throw new ValidationError(`Not a git repository: ${path}`);
  }
}
