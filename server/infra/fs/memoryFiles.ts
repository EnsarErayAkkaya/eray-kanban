import fs from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_KINDS, type MemoryEntry, type MemoryKind, type ProjectMemory } from '@shared/memory';
import { MEMORY_DIR, MEMORY_FILES, parseMemory, renderMemory } from '../../domain/projectMemory';
import type { MemoryFiles } from '../../services/ports';

export function memoryFilePath(repo: string, kind: MemoryKind): string {
  return path.join(repo, MEMORY_DIR, MEMORY_FILES[kind]);
}

export class FsMemoryFiles implements MemoryFiles {
  async read(repo: string): Promise<ProjectMemory> {
    const [decisions, knowhow] = await Promise.all(MEMORY_KINDS.map((kind) => this._read(memoryFilePath(repo, kind))));
    return { decisions: decisions ?? [], knowhow: knowhow ?? [] };
  }

  async write(repo: string, kind: MemoryKind, entries: readonly MemoryEntry[]): Promise<void> {
    const file = memoryFilePath(repo, kind);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, renderMemory(kind, entries), 'utf8');
  }

  private async _read(file: string): Promise<MemoryEntry[]> {
    try {
      return parseMemory(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
