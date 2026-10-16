import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../domain/errors';
import { FsScreenshotFiles } from '../fs/screenshotFiles';
import { SqliteRunRepo } from './sqliteRunRepo';
import { SqliteScreenshotRepo } from './sqliteScreenshotRepo';
import { SqliteTaskRepo } from './sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from './testDb';

const shot = (route: string, file: string | null, error: string | null = null) => ({
  route,
  size: 'desktop' as const,
  width: 1280,
  height: 800,
  file,
  error,
});

describe('SqliteScreenshotRepo', () => {
  let repo: SqliteScreenshotRepo;
  let runs: SqliteRunRepo;
  let taskId: number;

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    taskId = new SqliteTaskRepo(db, clock).create(newTask(seedProject(db, clock).id)).id;
    runs = new SqliteRunRepo(db, clock);
    repo = new SqliteScreenshotRepo(db, clock);
  });

  it('stores shots per run and hides the file path from listings', () => {
    const run = runs.start({ taskId, sessionId: 's', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' });
    const [ok, failed] = repo.save(run.id, [shot('/', '1/1/1-root-desktop.png'), shot('/x', null, 'timeout')]);
    expect(repo.listByTask(taskId)).toEqual([ok, failed]);
    expect(ok).toMatchObject({ route: '/', hasImage: true, error: null });
    expect(failed).toMatchObject({ hasImage: false, error: 'timeout' });
    expect(Object.keys(ok ?? {})).not.toContain('file');
    expect(repo.fileOf(ok?.id ?? 0)).toBe('1/1/1-root-desktop.png');
    expect(repo.fileOf(failed?.id ?? 0)).toBeNull();
    expect(repo.fileOf(999)).toBeUndefined();
  });

  it('rejects shots for a missing run', () => {
    expect(() => repo.save(999, [shot('/', null)])).toThrow(NotFoundError);
  });
});

describe('FsScreenshotFiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-files-'));
  fs.mkdirSync(path.join(root, '1/2'), { recursive: true });
  fs.writeFileSync(path.join(root, '1/2/a.png'), 'png');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new FsScreenshotFiles(root);

  it('reads a PNG inside the folder', () => {
    expect(files.read('1/2/a.png')?.toString()).toBe('png');
  });

  it.each(['../../etc/passwd', '/etc/hosts', 'secret.txt', '1/2/missing.png', '1/../../x.png'])('refuses %j', (file) => {
    expect(files.read(file)).toBeNull();
  });
});
