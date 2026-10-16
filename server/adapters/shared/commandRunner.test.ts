import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor } from '../../infra/process/processSupervisor';
import { CommandRunner, splitCommand } from './commandRunner';

// Integration tests: real node processes stand in for npm scripts.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-checks-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  fs.writeFileSync(path.join(dir, name), body);
  return `${process.execPath} ${name}`;
}

const runner = new CommandRunner(new ProcessSupervisor(200), { timeoutMs: 5_000, maxOutputBytes: 200 }, {
  ...process.env,
  ANTHROPIC_API_KEY: 'sk-should-not-leak',
});
const never = new AbortController().signal;

describe('splitCommand', () => {
  it('splits on any whitespace and drops empty parts', () => {
    expect(splitCommand('  npm   run  test -- --run ')).toEqual(['npm', 'run', 'test', '--', '--run']);
  });
});

describe('CommandRunner', () => {
  it('passes on exit 0 and keeps stdout and stderr together', async () => {
    const result = await runner.run(dir, script('ok.js', "console.log('out'); console.error('err')"), never);
    expect(result).toMatchObject({ exitCode: 0, passed: true, timedOut: false });
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('fails on a non-zero exit and keeps the end of long output', async () => {
    const cmd = script('fail.js', "console.log('noise '.repeat(200)); console.error('THE REAL ERROR'); process.exit(2)");
    const result = await runner.run(dir, cmd, never);
    expect(result).toMatchObject({ exitCode: 2, passed: false });
    expect(result.output.startsWith('…')).toBe(true);
    expect(result.output.endsWith('THE REAL ERROR')).toBe(true);
  });

  it('runs non-interactively and without the API key', async () => {
    const cmd = script('env.js', 'console.log(process.env.CI, process.env.NO_COLOR, String(process.env.ANTHROPIC_API_KEY))');
    expect((await runner.run(dir, cmd, never)).output).toBe('1 1 undefined');
  });

  it('kills a command that runs past the timeout', async () => {
    const quick = new CommandRunner(new ProcessSupervisor(200), { timeoutMs: 200, maxOutputBytes: 200 });
    const result = await quick.run(dir, script('hang.js', 'setInterval(() => {}, 1000)'), never);
    expect(result).toMatchObject({ passed: false, timedOut: true });
    expect(result.output).toContain('Killed after');
  });

  it('reports a command that cannot start', async () => {
    const result = await runner.run(dir, 'definitely-not-a-command --version', never);
    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/Could not start: .*ENOENT/);
  });

  it('runs every command even after a failure, and stops on abort', async () => {
    const fail = script('f.js', 'process.exit(1)');
    const ok = script('o.js', '');
    expect((await runner.runAll(dir, [fail, ok], never)).map((r) => r.passed)).toEqual([false, true]);

    const controller = new AbortController();
    const hang = script('h.js', 'setInterval(() => {}, 1000)');
    setTimeout(() => controller.abort(), 150);
    const results = await runner.runAll(dir, [hang, ok], controller.signal);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ passed: false });
    expect(results[0]?.output).toContain('Stopped');
  });
});
