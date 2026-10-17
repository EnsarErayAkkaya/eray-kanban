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

  it('saves the adapter settings on create and on update', () => {
    const created = repo.create({ ...input('web'), checkCommands: ['npm test'], devUrl: 'http://localhost:3000' });
    expect(created).toMatchObject({ checkCommands: ['npm test'], autoFix: true, devUrl: 'http://localhost:3000' });
    const updated = repo.update(created.id, {
      autoFix: false,
      devCommand: 'npm run dev',
      screenshotSizes: ['desktop', 'mobile'],
    });
    expect(updated).toMatchObject({
      checkCommands: ['npm test'],
      autoFix: false,
      devCommand: 'npm run dev',
      screenshotSizes: ['desktop', 'mobile'],
    });
  });

  it('starts unpaused and saves the pause switch', () => {
    const created = repo.create(input('shop'));
    expect(created.paused).toBe(false);
    expect(repo.setPaused(created.id, true).paused).toBe(true);
    expect(repo.get(created.id)?.paused).toBe(true);
    expect(repo.update(created.id, { name: 'shop2' }).paused).toBe(true);
    expect(repo.setPaused(created.id, false).paused).toBe(false);
    expect(() => repo.setPaused(999, true)).toThrow(NotFoundError);
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
