import { beforeEach, describe, expect, it } from 'vitest';
import { CreateTemplateInput } from '@shared/template';
import { ConflictError, NotFoundError } from '../../domain/errors';
import { SqliteTemplateRepo } from './sqliteTemplateRepo';
import { fakeClock, memoryDb, seedProject } from './testDb';

const input = (fields: Record<string, unknown>) => CreateTemplateInput.parse(fields);

describe('SqliteTemplateRepo', () => {
  let repo: SqliteTemplateRepo;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    projectId = seedProject(db, clock, 'web').id;
    otherProjectId = seedProject(db, clock, 'api').id;
    repo = new SqliteTemplateRepo(db, clock);
  });

  it('stores every field and lists a project by name', () => {
    const full = repo.create(
      projectId,
      input({
        name: 'UI change',
        titlePrefix: 'UI: ',
        description: 'Change the look',
        acceptanceCriteria: '- matches the mock',
        priority: 'high',
        visual: true,
        routes: ['/', '/settings'],
        model: 'opus',
        turnLimit: 50,
      }),
    );
    repo.create(projectId, input({ name: 'bug fix' }));
    repo.create(otherProjectId, input({ name: 'Refactor' }));

    expect(repo.get(full.id)).toMatchObject({
      projectId,
      titlePrefix: 'UI: ',
      priority: 'high',
      visual: true,
      routes: ['/', '/settings'],
      model: 'opus',
      turnLimit: 50,
    });
    expect(repo.listByProject(projectId).map((t) => t.name)).toEqual(['bug fix', 'UI change']);
    expect(repo.listByProject(otherProjectId).map((t) => t.name)).toEqual(['Refactor']);
  });

  it('keeps names unique per project only', () => {
    repo.create(projectId, input({ name: 'Bug fix' }));
    expect(() => repo.create(projectId, input({ name: 'Bug fix' }))).toThrow(ConflictError);
    expect(repo.create(otherProjectId, input({ name: 'Bug fix' })).name).toBe('Bug fix');
  });

  it('refuses a template for a missing project', () => {
    expect(() => repo.create(999, input({ name: 'x' }))).toThrow(NotFoundError);
  });

  it('updates only the given fields, and can clear the model back to the project default', () => {
    const t = repo.create(projectId, input({ name: 'Bug fix', model: 'opus', turnLimit: 20 }));
    expect(repo.update(t.id, { model: null, visual: true })).toMatchObject({ model: null, visual: true, turnLimit: 20 });
    expect(() => repo.update(999, { name: 'x' })).toThrow(NotFoundError);
  });

  it('deletes, once', () => {
    const t = repo.create(projectId, input({ name: 'Bug fix' }));
    repo.delete(t.id);
    expect(repo.get(t.id)).toBeUndefined();
    expect(() => repo.delete(t.id)).toThrow(NotFoundError);
  });
});
