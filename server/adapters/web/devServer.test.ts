import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CreateProjectInput, type Project } from '@shared/project';
import { ProcessSupervisor } from '../../infra/process/processSupervisor';
import { DevServerManager, probeUrl } from './devServer';

// Integration tests: a real node HTTP server plays the project's dev server.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-dev-'));
fs.writeFileSync(
  path.join(dir, 'serve.js'),
  "require('http').createServer((q, s) => s.end('dev ok')).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('ready'))",
);
fs.writeFileSync(path.join(dir, 'crash.js'), "console.error('boom: port in use'); process.exit(1)");
fs.writeFileSync(path.join(dir, 'idle.js'), 'setInterval(() => {}, 1000)');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });

function project(port: number, devCommand: string | null): Project {
  return {
    ...CreateProjectInput.parse({ name: 'web', repoPath: dir, workingBranch: 'main' }),
    devUrl: `http://127.0.0.1:${port}`,
    devCommand,
    id: 1,
    createdAt: '2026-10-17T09:00:00.000Z',
    updatedAt: '2026-10-17T09:00:00.000Z',
  };
}

const manager = new DevServerManager(new ProcessSupervisor(200), { readyTimeoutMs: 5_000, maxLifetimeMs: 30_000, pollMs: 50 });
const never = new AbortController().signal;
const external: http.Server[] = [];
afterEach(() => {
  for (const srv of external.splice(0)) srv.close();
});

describe('DevServerManager', () => {
  it('reuses a server that already answers and leaves it running', async () => {
    const port = await freePort();
    await new Promise<void>((r) => external.push(http.createServer((_, s) => s.end('yours')).listen(port, '127.0.0.1', r)));

    const server = await manager.ensure(project(port, `${process.execPath} serve.js ${port}`), never);
    expect(server.startedByUs).toBe(false);
    await server.stop();
    expect(await probeUrl(`http://127.0.0.1:${port}`)).toBe(true);
  });

  it('starts the dev command, waits for the URL, and stops it again', async () => {
    const port = await freePort();
    const server = await manager.ensure(project(port, `${process.execPath} serve.js ${port}`), never);
    expect(server).toMatchObject({ startedByUs: true, url: `http://127.0.0.1:${port}` });
    expect(await probeUrl(server.url)).toBe(true);

    await server.stop();
    expect(await probeUrl(server.url)).toBe(false);
  });

  it('reports a dev command that exits before the URL answers, with its output', async () => {
    const port = await freePort();
    await expect(manager.ensure(project(port, `${process.execPath} crash.js`), never)).rejects.toThrow(
      /exited before .* answered:\nboom: port in use/,
    );
  });

  it('gives up when the URL never answers, and kills the command', async () => {
    const quick = new DevServerManager(new ProcessSupervisor(200), { readyTimeoutMs: 300, maxLifetimeMs: 30_000, pollMs: 50 });
    const port = await freePort();
    await expect(quick.ensure(project(port, `${process.execPath} idle.js`), never)).rejects.toThrow(/did not answer within/);
  });

  it('stops starting when the task is stopped', async () => {
    const port = await freePort();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(manager.ensure(project(port, `${process.execPath} idle.js`), controller.signal)).rejects.toThrow(
      'Stopped while the dev server was starting',
    );
  });

  it('explains a missing dev URL or dev command', async () => {
    const port = await freePort();
    await expect(manager.ensure({ ...project(port, null), devUrl: null }, never)).rejects.toThrow('Set a dev URL');
    await expect(manager.ensure(project(port, null), never)).rejects.toThrow('no dev command is set');
  });
});
