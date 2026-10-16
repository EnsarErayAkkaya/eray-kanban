import { beforeEach, describe, expect, it } from 'vitest';
import { CreateTemplateInput } from '@shared/template';
import { NotFoundError } from '../domain/errors';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteTemplateRepo } from '../infra/sqlite/sqliteTemplateRepo';
import { fakeClock, memoryDb, seedProject } from '../infra/sqlite/testDb';
import { TemplateService } from './templateService';

describe('TemplateService', () => {
  let service: TemplateService;
  let projectId: number;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    projectId = seedProject(db, clock).id;
    service = new TemplateService(new SqliteProjectRepo(db, clock), new SqliteTemplateRepo(db, clock));
  });

  it('lists and creates templates of an existing project only', () => {
    service.create(projectId, CreateTemplateInput.parse({ name: 'Bug fix' }));
    expect(service.list(projectId).map((t) => t.name)).toEqual(['Bug fix']);
    expect(() => service.list(999)).toThrow(NotFoundError);
    expect(() => service.create(999, CreateTemplateInput.parse({ name: 'x' }))).toThrow(NotFoundError);
  });
});
