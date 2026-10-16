import type { ProjectStatus } from '@shared/events';
import type { NewProject, Project, ProjectPatch } from '@shared/project';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import type { ProjectRepo, RepoProbe, TaskRepo, WorkScheduler } from './ports';

export class ProjectService {
  constructor(
    private readonly _projects: ProjectRepo,
    private readonly _tasks: TaskRepo,
    private readonly _probe: RepoProbe,
    private readonly _scheduler: WorkScheduler,
  ) {}

  list(): Project[] {
    return this._projects.list();
  }

  statuses(): ProjectStatus[] {
    return this._scheduler.statuses();
  }

  /** "Check again" after you cleaned the tree or switched branch; the result arrives as a projectStatus event. */
  check(id: number): void {
    if (!this._projects.get(id)) throw new NotFoundError('project', id);
    void this._scheduler.kick(id);
  }

  create(input: NewProject): Project {
    this._requireGitRepo(input.repoPath);
    return this._projects.create(input);
  }

  update(id: number, patch: ProjectPatch): Project {
    if (!this._projects.get(id)) throw new NotFoundError('project', id);
    if (patch.repoPath !== undefined) {
      this._requireGitRepo(patch.repoPath);
      if (this._tasks.activeTask(id)) throw new ConflictError('Cannot move the repo while a task is active');
    }
    return this._projects.update(id, patch);
  }

  private _requireGitRepo(path: string): void {
    if (!this._probe.isGitRepo(path)) throw new ValidationError(`Not a git repository: ${path}`);
  }
}
