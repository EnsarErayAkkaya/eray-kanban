import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../infra/events/eventHub';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb } from '../infra/sqlite/testDb';
import { ProjectService } from '../services/projectService';
import { ReviewService } from '../services/reviewService';
import { TaskService } from '../services/taskService';
import { FakeGit, FakeScheduler } from '../services/testFakes';
import { SqliteCheckRepo } from '../infra/sqlite/sqliteCheckRepo';
import { SqliteSnapshotRepo } from '../infra/sqlite/sqliteSnapshotRepo';
import { buildServer } from './buildServer';

const API_PORT = 4317;
const UI_PORT = 5173;
const HOST = `127.0.0.1:${API_PORT}`;

describe('HTTP API', () => {
  let app: FastifyInstance;
  let kicked: number[];
  let scheduler: FakeScheduler;

  const send = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { host: HOST, ...headers }, ...(payload === undefined ? {} : { payload }) });
  const createProject = async () =>
    (await send('POST', '/api/projects', { name: 'shop', repoPath: '/repos/shop', workingBranch: 'develop' })).json();
  const createTask = async (projectId: number, title = 'Add settings page') =>
    (await send('POST', '/api/tasks', { projectId, title })).json();

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    const projects = new SqliteProjectRepo(db, clock);
    const tasks = new SqliteTaskRepo(db, clock);
    const runs = new SqliteRunRepo(db, clock);
    const hub = new EventHub();
    scheduler = new FakeScheduler();
    kicked = scheduler.kicked;
    app = buildServer(
      {
        projects: new ProjectService(projects, tasks, { isGitRepo: (p) => p.startsWith('/repos/') }, scheduler),
        tasks: new TaskService(projects, tasks, runs, scheduler, hub),
        review: new ReviewService({
          projects,
          tasks,
          runs,
          checks: new SqliteCheckRepo(db),
          snapshots: new SqliteSnapshotRepo(db, clock),
          git: new FakeGit(),
          scheduler,
          events: hub,
        }),
        subscribe: (l) => hub.subscribe(l),
        heartbeatMs: 60_000,
      },
      { logger: false, allowedPorts: [API_PORT, UI_PORT] },
    );
  });

  afterEach(() => app.close());

  describe('local-only guard', () => {
    it('answers requests for its own host', async () => {
      expect((await send('GET', '/api/health')).json()).toEqual({ ok: true });
    });

    it('refuses a foreign Host header (DNS rebinding)', async () => {
      expect((await send('GET', '/api/health', undefined, { host: 'evil.example:4317' })).statusCode).toBe(403);
    });

    it('refuses requests from other web pages', async () => {
      const res = await send('POST', '/api/projects', {}, { origin: 'https://evil.example' });
      expect(res.statusCode).toBe(403);
    });

    it('accepts the board UI through the Vite proxy', async () => {
      const res = await send('GET', '/api/projects', undefined, { host: `localhost:${UI_PORT}`, origin: `http://localhost:${UI_PORT}` });
      expect(res.statusCode).toBe(200);
    });

    it('refuses a form-style body, so a plain cross-site form cannot create tasks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: 'projectId=1&title=x',
        headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe('projects', () => {
    it('creates and lists projects with defaults', async () => {
      const project = await createProject();
      expect(project).toMatchObject({ id: 1, defaultModel: 'sonnet', defaultTurnLimit: 30 });
      expect((await send('GET', '/api/projects')).json()).toHaveLength(1);
    });

    it('explains invalid input', async () => {
      const res = await send('POST', '/api/projects', { name: 'x', repoPath: 'relative', workingBranch: '--evil' });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.map((i: { path: string }) => i.path)).toEqual(['repoPath', 'workingBranch']);
    });

    it('refuses a folder that is not a git repo', async () => {
      const res = await send('POST', '/api/projects', { name: 'x', repoPath: '/tmp/x', workingBranch: 'main' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Not a git repository: /tmp/x');
    });

    it('reports a duplicate as a conflict', async () => {
      await createProject();
      expect((await send('POST', '/api/projects', { name: 'shop', repoPath: '/repos/shop', workingBranch: 'main' })).statusCode).toBe(409);
    });
  });

  describe('tasks', () => {
    it('creates, filters and edits tasks', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      expect(task).toMatchObject({ status: 'backlog', model: 'sonnet' });
      expect((await send('GET', `/api/tasks?projectId=${projectId}`)).json()).toHaveLength(1);
      expect((await send('GET', '/api/tasks?projectId=99')).json()).toEqual([]);
      expect((await send('PATCH', `/api/tasks/${task.id}`, { priority: 'high' })).json().priority).toBe('high');
    });

    it('moves a task to Todo and wakes the scheduler', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      const res = await send('POST', `/api/tasks/${task.id}/events`, { event: 'promote' });
      expect(res.json().status).toBe('todo');
      expect(kicked).toEqual([projectId]);
    });

    it('maps domain errors to status codes', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      expect((await send('POST', `/api/tasks/${task.id}/events`, { event: 'accept' })).statusCode).toBe(409);
      expect((await send('POST', `/api/tasks/${task.id}/events`, { event: 'teleport' })).statusCode).toBe(400);
      expect((await send('POST', `/api/tasks/${task.id}/stop`)).statusCode).toBe(409);
      expect((await send('GET', '/api/tasks/999/runs')).statusCode).toBe(404);
      expect((await send('GET', '/api/tasks/abc/runs')).statusCode).toBe(400);
      expect((await send('PATCH', `/api/tasks/${task.id}`, { status: 'done' })).statusCode).toBe(400);
    });

    it('validates reject feedback and refuses tasks not in review', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      expect((await send('POST', `/api/tasks/${task.id}/reject`, { feedback: '  ' })).statusCode).toBe(400);
      const res = await send('POST', `/api/tasks/${task.id}/reject`, { feedback: 'Use a toggle' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Only a task in review can be rejected');
    });
  });

  describe('project status', () => {
    it('lists statuses and starts a check', async () => {
      const { id } = await createProject();
      expect((await send('GET', '/api/projects/status')).json()).toEqual([]);
      expect((await send('POST', `/api/projects/${id}/check`)).statusCode).toBe(202);
      expect(scheduler.kicked).toEqual([id]);
      expect((await send('POST', '/api/projects/99/check')).statusCode).toBe(404);
    });
  });

  it('streams board events over SSE', async () => {
    const { id: projectId } = await createProject();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no address');

    const received = new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: address.port, path: '/api/events', headers: { host: HOST } }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const event = buffer.split('\n\n').find((block) => block.startsWith('data: '));
          if (event) {
            req.destroy();
            resolve(event.slice('data: '.length));
          }
        });
        // The stream is open once the first comment arrives; then cause an event.
        res.once('data', () => void createTask(projectId));
      });
      req.on('error', reject);
    });

    expect(JSON.parse(await received)).toMatchObject({ type: 'task' });
  });
});
