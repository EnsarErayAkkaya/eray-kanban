import { beforeEach, describe, expect, it } from 'vitest';
import { CreateProjectInput } from '@shared/project';
import { ConflictError, ValidationError } from '../domain/errors';
import { transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask } from '../infra/sqlite/testDb';
import { ProjectService } from './projectService';

const probe = { isGitRepo: (path: string) => path.startsWith('/repos/') };
const input = (repoPath: string) => CreateProjectInput.parse({ name: 'shop', repoPath, workingBranch: 'develop' });

describe('ProjectService', () => {
  let tasks: SqliteTaskRepo;
  let service: ProjectService;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    tasks = new SqliteTaskRepo(db, clock);
    service = new ProjectService(new SqliteProjectRepo(db, clock), tasks, probe);
  });

  it('creates a project for a git repo', () => {
    expect(service.create(input('/repos/shop')).repoPath).toBe('/repos/shop');
    expect(service.list()).toHaveLength(1);
  });

  it('refuses a path that is not a git repo', () => {
    expect(() => service.create(input('/Users/me/Desktop'))).toThrow(ValidationError);
    expect(() => service.update(service.create(input('/repos/shop')).id, { repoPath: '/tmp' })).toThrow(ValidationError);
  });

  it('refuses to move the repo while a task is active', () => {
    const project = service.create(input('/repos/shop'));
    const task = tasks.create(newTask(project.id));
    ['promote', 'start'].forEach((e) => tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, e as 'promote')));
    expect(() => service.update(project.id, { repoPath: '/repos/moved' })).toThrow(ConflictError);
    expect(service.update(project.id, { name: 'renamed' }).name).toBe('renamed');
  });
});
