import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@shared/memory';
import { FsMemoryFiles, memoryFilePath } from './memoryFiles';

const entry: MemoryEntry = { area: 'db', text: 'Migrations are append-only', taskId: 3, date: '2026-10-17' };

describe('FsMemoryFiles', () => {
  let repo: string;
  const files = new FsMemoryFiles();

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-memory-'));
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('reads a repo without .kanban/ as empty and creates nothing', async () => {
    expect(await files.read(repo)).toEqual({ decisions: [], knowhow: [] });
    expect(fs.existsSync(path.join(repo, '.kanban'))).toBe(false);
  });

  it('writes one file and reads it back', async () => {
    await files.write(repo, 'knowhow', [entry]);
    expect(await files.read(repo)).toEqual({ decisions: [], knowhow: [entry] });
    expect(fs.existsSync(memoryFilePath(repo, 'decisions'))).toBe(false);
    expect(memoryFilePath(repo, 'knowhow')).toBe(path.join(repo, '.kanban', 'knowhow.md'));
  });
});
