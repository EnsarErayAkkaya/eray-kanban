import { MEMORY_KINDS, type MemoryUpdate, type ProjectMemory } from '@shared/memory';
import { ConflictError, NotFoundError } from '../domain/errors';
import { prepareEntries, sameEntries } from '../domain/projectMemory';
import type { Clock, MemoryFiles, ProjectRepo, TaskRepo } from './ports';

/** The project's decisions and know-how, kept in its repo and loaded into every agent run. */
export class MemoryService {
  constructor(
    private readonly _projects: ProjectRepo,
    private readonly _tasks: Pick<TaskRepo, 'activeTask'>,
    private readonly _files: MemoryFiles,
    private readonly _clock: Clock,
  ) {}

  async get(projectId: number): Promise<ProjectMemory> {
    return this._files.read(this._repo(projectId));
  }

  async replace(projectId: number, update: MemoryUpdate): Promise<ProjectMemory> {
    const repo = this._repo(projectId);
    // Written mid-task, the edit would land in that task's diff and vanish on its rollback.
    const active = this._tasks.activeTask(projectId);
    if (active) throw new ConflictError(`Task #${active.id} is active; edit memory once it is accepted or rolled back`);

    const today = this._clock().slice(0, 10);
    const next: ProjectMemory = {
      decisions: prepareEntries('decisions', update.decisions, today),
      knowhow: prepareEntries('knowhow', update.knowhow, today),
    };
    const current = await this._files.read(repo);
    for (const kind of MEMORY_KINDS) {
      if (!sameEntries(current[kind], next[kind])) await this._files.write(repo, kind, next[kind]);
    }
    return next;
  }

  private _repo(projectId: number): string {
    const project = this._projects.get(projectId);
    if (!project) throw new NotFoundError('project', projectId);
    return project.repoPath;
  }
}
