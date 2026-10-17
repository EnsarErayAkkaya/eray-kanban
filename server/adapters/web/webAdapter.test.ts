import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreateProjectInput, type Project } from '@shared/project';
import type { Shot } from '../../services/ports';
import type { CaptureRequest } from './screenshotter';
import { DevServerError, type RunningServer } from './devServer';
import { WebAdapter } from './webAdapter';

const project: Project = {
  ...CreateProjectInput.parse({
    name: 'web',
    repoPath: '/repos/web',
    workingBranch: 'main',
    devUrl: 'http://localhost:3000',
    screenshotSizes: ['desktop', 'mobile'],
  }),
  paused: false,
  id: 1,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
};
const target = { taskId: 7, runId: 3, routes: ['/', '/settings'] };
const never = new AbortController().signal;
const noCommands = { runAll: () => Promise.resolve([]) };

function setup(opts: { devError?: string; captureError?: Error; captureMs?: number } = {}) {
  const events: string[] = [];
  const requests: CaptureRequest[] = [];
  const devServers = {
    ensure: (): Promise<RunningServer> => {
      events.push('ensure');
      if (opts.devError) return Promise.reject(new DevServerError(opts.devError));
      return Promise.resolve({ url: 'http://localhost:3000', startedByUs: true, stop: async () => void events.push('stop') });
    },
  };
  const screenshotter = {
    capture: async (req: CaptureRequest): Promise<Shot[]> => {
      events.push('capture');
      requests.push(req);
      if (opts.captureMs) await new Promise((r) => setTimeout(r, opts.captureMs));
      if (opts.captureError) throw opts.captureError;
      return [];
    },
  };
  return { adapter: new WebAdapter(noCommands, devServers, screenshotter, '/data/screenshots'), events, requests };
}

describe('WebAdapter.screenshots', () => {
  it('captures into the task/run folder at the project sizes and stops the server after', async () => {
    const { adapter, events, requests } = setup();
    await adapter.screenshots(project, target, never);
    expect(events).toEqual(['ensure', 'capture', 'stop']);
    expect(requests[0]).toMatchObject({
      baseUrl: 'http://localhost:3000',
      routes: ['/', '/settings'],
      sizes: ['desktop', 'mobile'],
      dir: path.join('/data/screenshots', '7', '3'),
      relativeDir: '7/3',
    });
  });

  it('turns a dev server problem into a failed shot per route and size', async () => {
    const { adapter } = setup({ devError: 'Nothing answers at http://localhost:3000' });
    const shots = await adapter.screenshots(project, target, never);
    expect(shots).toHaveLength(4);
    expect(shots.every((s) => s.file === null && s.error === 'Nothing answers at http://localhost:3000')).toBe(true);
  });

  it('stops the server even when the capture throws', async () => {
    const { adapter, events } = setup({ captureError: new Error('chrome crashed') });
    await expect(adapter.screenshots(project, target, never)).rejects.toThrow('chrome crashed');
    expect(events).toEqual(['ensure', 'capture', 'stop']);
  });

  it('runs one capture at a time across projects', async () => {
    const { adapter, events } = setup({ captureMs: 50 });
    await Promise.all([adapter.screenshots(project, target, never), adapter.screenshots(project, target, never)]);
    expect(events).toEqual(['ensure', 'capture', 'stop', 'ensure', 'capture', 'stop']);
  });
});
