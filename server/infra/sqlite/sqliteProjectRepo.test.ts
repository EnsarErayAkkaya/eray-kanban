import { beforeEach, describe, expect, it } from 'vitest';
import { CreateProjectInput } from '@shared/project';
import { ConflictError, NotFoundError } from '../../domain/errors';
import { SqliteProjectRepo } from './sqliteProjectRepo';
import { fakeClock, memoryDb } from './testDb';

const input = (name: string) => CreateProjectInput.parse({ name, repoPath: `/repos/${name}`, workingBranch: 'develop' });

describe('SqliteProjectRepo', () => {
  let repo: SqliteProjectRepo;

  beforeEach(() => {
    repo = new SqliteProjectRepo(memoryDb(), fakeClock());
  });

  it('creates a project with its defaults and reads it back', () => {
    const created = repo.create(input('shop'));
    expect(created).toMatchObject({
      name: 'shop',
      repoPath: '/repos/shop',
      type: 'web',
      workingBranch: 'develop',
      mergeTarget: null,
      acceptCommit: true,
      acceptFollowup: 'none',
      pushAfterMerge: false,
      defaultModel: 'sonnet',
      defaultTurnLimit: 30,
      allowedCommands: [],
    });
    expect(repo.get(created.id)).toEqual(created);
  });

  it('lists projects by name', () => {
    repo.create(input('zeta'));
    repo.create(input('Alpha'));
    expect(repo.list().map((p) => p.name)).toEqual(['Alpha', 'zeta']);
  });

  it('updates only the fields in the patch', () => {
    const created = repo.create(input('shop'));
    const updated = repo.update(created.id, { mergeTarget: 'main', allowedCommands: ['npm test'] });
    expect(updated).toEqual({
      ...created,
      mergeTarget: 'main',
      allowedCommands: ['npm test'],
      updatedAt: updated.updatedAt,
    });
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  it('rejects a duplicate name or repo path', () => {
    repo.create(input('shop'));
    expect(() => repo.create(input('shop'))).toThrow(ConflictError);
    expect(() => repo.create({ ...input('other'), repoPath: '/repos/shop' })).toThrow(ConflictError);
  });

  it('fails to update a missing project', () => {
    expect(() => repo.update(99, { name: 'x' })).toThrow(NotFoundError);
    expect(repo.get(99)).toBeUndefined();
  });
});
