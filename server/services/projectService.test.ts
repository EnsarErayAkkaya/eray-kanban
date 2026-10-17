import { beforeEach, describe, expect, it } from 'vitest';
import { CreateProjectInput } from '@shared/project';
import { MAX_PROJECT_FILES } from '@shared/files';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask } from '../infra/sqlite/testDb';
import { ProjectService } from './projectService';
import { FakeGit, FakeScheduler } from './testFakes';

const probe = { isGitRepo: (path: string) => path.startsWith('/repos/') };
const input = (repoPath: string) => CreateProjectInput.parse({ name: 'shop', repoPath, workingBranch: 'develop' });

describe('ProjectService', () => {
  let tasks: SqliteTaskRepo;
  let service: ProjectService;
  let git: FakeGit;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    tasks = new SqliteTaskRepo(db, clock);
    git = new FakeGit();
    service = new ProjectService(new SqliteProjectRepo(db, clock), tasks, probe, new FakeScheduler(), { usageByProject: () => [] }, git);
  });

  it('creates a project for a git repo', () => {
    expect(service.create(input('/repos/shop')).repoPath).toBe('/repos/shop');
    expect(service.list()).toHaveLength(1);
  });

  it('refuses a path that is not a git repo', () => {
    expect(() => service.create(input('/Users/me/Desktop'))).toThrow(ValidationError);
    expect(() => service.update(service.create(input('/repos/shop')).id, { repoPath: '/tmp' })).toThrow(ValidationError);
  });

  it('refuses a dev URL another project already uses, localhost and 127.0.0.1 alike', () => {
    service.create({ ...input('/repos/shop'), devUrl: 'http://localhost:3000' });
    const api = { ...input('/repos/api'), name: 'api' };
    expect(() => service.create({ ...api, devUrl: 'http://127.0.0.1:3000' })).toThrow('shop already uses this dev server address');
    const created = service.create({ ...api, devUrl: 'http://127.0.0.1:3001' });
    expect(() => service.update(created.id, { devUrl: 'http://localhost:3000/app' })).toThrow(ConflictError);
    expect(service.update(created.id, { devUrl: 'http://127.0.0.1:3001/' }).devUrl).toBe('http://127.0.0.1:3001/');
  });

  it('refuses to move the repo while a task is active', () => {
    const project = service.create(input('/repos/shop'));
    const task = tasks.create(newTask(project.id));
    ['promote', 'start'].forEach((e) => tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, e as 'promote')));
    expect(() => service.update(project.id, { repoPath: '/repos/moved' })).toThrow(ConflictError);
    expect(service.update(project.id, { name: 'renamed' }).name).toBe('renamed');
  });

  it('lists the repo files for @-references, capped', async () => {
    const project = service.create(input('/repos/shop'));
    expect(await service.files(project.id)).toEqual({ files: ['README.md', 'src/app.ts'], truncated: false });
    git.files = Array.from({ length: MAX_PROJECT_FILES + 1 }, (_, i) => `f${i}.ts`);
    const big = await service.files(project.id);
    expect(big.files).toHaveLength(MAX_PROJECT_FILES);
    expect(big.truncated).toBe(true);
    await expect(service.files(999)).rejects.toThrow(NotFoundError);
  });
});
