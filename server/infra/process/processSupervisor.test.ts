import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ProcessSupervisor, type SpawnRequest } from './processSupervisor';

// Integration tests: real node child processes, since killing them is the whole point.
const supervisor = new ProcessSupervisor(200);

function nodeScript(script: string, overrides: Partial<SpawnRequest> = {}) {
  const lines: string[] = [];
  let pid = 0;
  const exit = supervisor.run({
    command: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    env: process.env,
    stdin: '',
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onSpawn: (p) => (pid = p),
    onStdoutLine: (l) => lines.push(l),
    ...overrides,
  });
  return { exit, lines, pid: () => pid };
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
};

// Spawns a grandchild that ignores SIGTERM, prints its pid, then idles.
const SPAWN_STUBBORN_CHILD = `
  const { spawn } = require('node:child_process');
  const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  console.log(c.pid);
  setInterval(() => {}, 1000);
`;

describe('ProcessSupervisor', () => {
  it('streams stdout line by line and reports the exit code', async () => {
    const run = nodeScript("process.stdout.write('one\\ntw'); setTimeout(() => { console.log('o'); process.exit(3) }, 20)");
    const exit = await run.exit;
    expect(run.lines).toEqual(['one', 'two']);
    expect(exit).toMatchObject({ code: 3, timedOut: false, cancelled: false, spawnError: null });
  });

  it('passes stdin and keeps the stderr tail', async () => {
    const run = nodeScript(
      "let s=''; process.stdin.on('data', d => s += d).on('end', () => { console.log(s.toUpperCase()); console.error('warn') })",
      { stdin: 'hello' },
    );
    expect(await run.exit).toMatchObject({ code: 0, stderrTail: 'warn' });
    expect(run.lines).toEqual(['HELLO']);
  });

  it('kills a process that runs past its timeout', async () => {
    const run = nodeScript('setInterval(() => {}, 1000)', { timeoutMs: 100 });
    const exit = await run.exit;
    expect(exit.timedOut).toBe(true);
    expect(isAlive(run.pid())).toBe(false);
  });

  it('kills the process and its stubborn grandchild on cancel', async () => {
    const controller = new AbortController();
    const run = nodeScript(SPAWN_STUBBORN_CHILD, { signal: controller.signal });
    await waitFor(() => run.lines.length > 0);
    const grandchild = Number(run.lines[0]);
    expect(isAlive(grandchild)).toBe(true);

    controller.abort();
    expect((await run.exit).cancelled).toBe(true);
    expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
  });

  it('kills leftovers in the group when the main process exits normally', async () => {
    const run = nodeScript(SPAWN_STUBBORN_CHILD.replace('setInterval(() => {}, 1000);', 'setTimeout(() => process.exit(0), 100);'));
    await run.exit;
    const grandchild = Number(run.lines[0]);
    expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
  });

  it('cancels immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const exit = await nodeScript('setInterval(() => {}, 1000)', { signal: controller.signal }).exit;
    expect(exit.cancelled).toBe(true);
  });

  it('reports a command that cannot start', async () => {
    const exit = await supervisor.run({
      command: '/nonexistent/claude',
      args: [],
      cwd: os.tmpdir(),
      env: process.env,
      stdin: '',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      onSpawn: () => undefined,
      onStdoutLine: () => undefined,
    });
    expect(exit.spawnError).toMatch(/ENOENT/);
  });

  it('killAll stops every live process', async () => {
    const own = new ProcessSupervisor(200);
    let pid = 0;
    const exit = own.run({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: os.tmpdir(),
      env: process.env,
      stdin: '',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onSpawn: (p) => (pid = p),
      onStdoutLine: () => undefined,
    });
    await waitFor(() => pid > 0);
    own.killAll();
    expect((await exit).signal).toBe('SIGKILL');
  });

  it('killStale only kills a pid whose command matches', async () => {
    const run = nodeScript('setInterval(() => {}, 1000) // stale-agent-marker');
    await waitFor(() => run.pid() > 0);
    expect(supervisor.killStale(run.pid(), 'not-this-process')).toBe(false);
    expect(isAlive(run.pid())).toBe(true);
    expect(supervisor.killStale(run.pid(), 'stale-agent-marker')).toBe(true);
    await run.exit;
    expect(supervisor.killStale(run.pid(), 'stale-agent-marker')).toBe(false);
  });
});
