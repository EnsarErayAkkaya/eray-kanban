import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSystemPrompt } from './systemPrompt';

describe('prepareSystemPrompt', () => {
  let repo: string;
  let tmp: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-prompt-repo-'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-prompt-tmp-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };

  it('passes nothing when the repo has no CLAUDE.md and no memory', async () => {
    expect((await prepareSystemPrompt(repo, 's1', tmp)).file).toBeNull();
  });

  it("uses the repo's own CLAUDE.md when there is no memory to add", async () => {
    write('CLAUDE.md', '# rules');
    write(path.join('.kanban', 'knowhow.md'), '# Know-how\n\nThings learned in earlier tasks in this repo.\n');
    expect((await prepareSystemPrompt(repo, 's1', tmp)).file).toBe(path.join(repo, 'CLAUDE.md'));
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('joins CLAUDE.md, decisions and know-how into one temp file and removes it on dispose', async () => {
    write('CLAUDE.md', '# rules\n');
    write(path.join('.kanban', 'decisions.md'), '# Project decisions\n\n- Use zod\n');
    write(path.join('.kanban', 'knowhow.md'), '# Know-how\n\n- Tests need --pool=forks\n');
    const prompt = await prepareSystemPrompt(repo, 's1', tmp);
    expect(prompt.file).toBe(path.join(tmp, 'kanban-system-s1.md'));
    expect(fs.readFileSync(prompt.file ?? '', 'utf8')).toBe(
      '# rules\n\n# Project decisions\n\n- Use zod\n\n# Know-how\n\n- Tests need --pool=forks\n',
    );
    await prompt.dispose();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('works with memory but no CLAUDE.md', async () => {
    write(path.join('.kanban', 'decisions.md'), '- Use zod\n');
    const prompt = await prepareSystemPrompt(repo, 's1', tmp);
    expect(fs.readFileSync(prompt.file ?? '', 'utf8')).toBe('- Use zod\n');
    await prompt.dispose();
  });
});
