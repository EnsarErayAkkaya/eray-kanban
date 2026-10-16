import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeControlToken } from './controlToken';

describe('writeControlToken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-token-'));
  const file = path.join(dir, 'control.token');
  afterEach(() => fs.rmSync(file, { force: true }));

  it('writes a new random token each start and removes only its own', () => {
    const first = writeControlToken(dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(first.token);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);

    const second = writeControlToken(dir);
    expect(second.token).not.toBe(first.token);
    first.remove();
    expect(fs.readFileSync(file, 'utf8')).toBe(second.token);
    second.remove();
    expect(fs.existsSync(file)).toBe(false);
    second.remove();
  });
});
