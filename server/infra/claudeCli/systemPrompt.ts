import fs from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_KINDS } from '@shared/memory';
import { parseMemory } from '../../domain/projectMemory';
import { memoryFilePath } from '../fs/memoryFiles';

export interface SystemPrompt {
  /** What --append-system-prompt-file gets; null when the repo has none of the files. */
  readonly file: string | null;
  dispose(): Promise<void>;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// The CLI keeps only the last --append-system-prompt-file (tested on 2.1.296), so CLAUDE.md and memory share one file.
export async function prepareSystemPrompt(cwd: string, sessionId: string, tmpDir: string): Promise<SystemPrompt> {
  const claudeMd = path.join(cwd, 'CLAUDE.md');
  const rules = await readIfPresent(claudeMd);
  const memory = (await Promise.all(MEMORY_KINDS.map((kind) => readIfPresent(memoryFilePath(cwd, kind))))).filter(
    (text): text is string => text !== null && parseMemory(text).length > 0,
  );

  const none = async () => {};
  if (memory.length === 0) return { file: rules === null ? null : claudeMd, dispose: none };

  const file = path.join(tmpDir, `kanban-system-${sessionId}.md`);
  await fs.writeFile(file, [rules, ...memory].filter((t) => t !== null).map((t) => t.trim()).join('\n\n') + '\n', 'utf8');
  return { file, dispose: () => fs.rm(file, { force: true }) };
}
