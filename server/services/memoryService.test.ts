import { beforeEach, describe, expect, it } from 'vitest';
import { UpdateMemoryInput } from '@shared/memory';
import type { Project } from '@shared/project';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from '../infra/sqlite/testDb';
import { MemoryService } from './memoryService';
import { FakeMemoryFiles } from './testFakes';

describe('MemoryService', () => {
  let files: FakeMemoryFiles;
  let tasks: SqliteTaskRepo;
  let project: Project;
  let service: MemoryService;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    project = seedProject(db, clock);
    tasks = new SqliteTaskRepo(db, clock);
    files = new FakeMemoryFiles();
    service = new MemoryService(new SqliteProjectRepo(db, clock), tasks, files, clock);
  });

  const update = (body: unknown) => service.replace(project.id, UpdateMemoryInput.parse(body));

  it('stamps new entries and writes only the files that changed', async () => {
    const saved = await update({ decisions: [{ text: '  Use zod,\n not yup ' }], knowhow: [] });
    expect(saved.decisions).toEqual([{ area: '', text: 'Use zod, not yup', taskId: null, date: '2026-10-16' }]);
    expect(files.writes).toEqual([[project.repoPath, 'decisions']]);
    expect(await service.get(project.id)).toEqual(saved);
  });

  it('refuses edits while a task is active', async () => {
    const todo = tasks.applyStatusChange(transition(tasks.create(newTask(project.id)), 'promote'));
    tasks.applyStatusChange(transition(todo, 'start'));
    await expect(update({ decisions: [], knowhow: [{ text: 'x' }] })).rejects.toThrow(ConflictError);
    expect(files.writes).toEqual([]);
  });

  it('rejects an oversized file and an unknown project', async () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ text: `${i} ${'x'.repeat(450)}` }));
    await expect(update({ decisions: [], knowhow: long })).rejects.toThrow(ValidationError);
    await expect(service.get(999)).rejects.toThrow(NotFoundError);
  });
});
