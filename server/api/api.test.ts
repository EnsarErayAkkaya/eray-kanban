import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../infra/events/eventHub';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { SqliteTemplateRepo } from '../infra/sqlite/sqliteTemplateRepo';
import { fakeClock, memoryDb } from '../infra/sqlite/testDb';
import { MemoryService } from '../services/memoryService';
import { ProjectService } from '../services/projectService';
import { ReviewService } from '../services/reviewService';
import { TaskService } from '../services/taskService';
import { TemplateService } from '../services/templateService';
import { FakeGit, FakeMemoryFiles, FakeScheduler } from '../services/testFakes';
import { SqliteCheckRepo } from '../infra/sqlite/sqliteCheckRepo';
import { SqliteScreenshotRepo } from '../infra/sqlite/sqliteScreenshotRepo';
import { SqliteSnapshotRepo } from '../infra/sqlite/sqliteSnapshotRepo';
import { buildServer } from './buildServer';

const API_PORT = 4317;
const UI_PORT = 5173;
const HOST = `127.0.0.1:${API_PORT}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('HTTP API', () => {
  let app: FastifyInstance;
  let kicked: number[];
  let scheduler: FakeScheduler;
  let runRepo: SqliteRunRepo;
  let shotRepo: SqliteScreenshotRepo;
  let snapshotRepo: SqliteSnapshotRepo;

  const CONTROL_TOKEN = 'a'.repeat(64);
  let shutdowns = 0;
  const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
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
    runRepo = runs;
    shotRepo = new SqliteScreenshotRepo(db, clock);
    snapshotRepo = new SqliteSnapshotRepo(db, clock);
    const hub = new EventHub();
    scheduler = new FakeScheduler();
    kicked = scheduler.kicked;
    app = buildServer(
      {
        projects: new ProjectService(projects, tasks, { isGitRepo: (p) => p.startsWith('/repos/') }, scheduler, runs, new FakeGit(), hub),
        tasks: new TaskService(projects, tasks, runs, snapshotRepo, scheduler, hub),
        review: new ReviewService({
          projects,
          tasks,
          runs,
          checks: new SqliteCheckRepo(db),
          screenshots: shotRepo,
          screenshotFiles: { read: (file) => (file === '1/1/1-root-desktop.png' ? PNG : null) },
          snapshots: snapshotRepo,
          git: new FakeGit(),
          scheduler,
          events: hub,
        }),
        templates: new TemplateService(projects, new SqliteTemplateRepo(db, clock)),
        memory: new MemoryService(projects, tasks, new FakeMemoryFiles(), clock),
        control: { token: CONTROL_TOKEN, shutdown: () => shutdowns++ },
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

  describe('pause switch', () => {
    it('pauses and resumes one project', async () => {
      const { id } = await createProject();
      const paused = await send('POST', `/api/projects/${id}/pause`);
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({ id, paused: true });
      expect(scheduler.stoppedProjects).toEqual([id]);
      expect((await send('GET', '/api/projects')).json()[0].paused).toBe(true);
      expect((await send('POST', `/api/projects/${id}/resume`)).json()).toMatchObject({ id, paused: false });
      expect(kicked).toContain(id);
    });

    it('pauses and resumes every project', async () => {
      await createProject();
      const all = await send('POST', '/api/projects/pause-all');
      expect(all.json()).toMatchObject([{ paused: true }]);
      expect((await send('POST', '/api/projects/resume-all')).json()).toMatchObject([{ paused: false }]);
    });

    it('answers 404 for an unknown project', async () => {
      expect((await send('POST', '/api/projects/99/pause')).statusCode).toBe(404);
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

    it('reopens a cancelled task with edits and drops its old snapshot', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      expect((await send('POST', `/api/tasks/${task.id}/reopen`, {})).statusCode).toBe(409);
      await send('POST', `/api/tasks/${task.id}/cancel`);
      snapshotRepo.save(task.id, { branch: 'develop', head: 'abc123', untracked: [], emptyDirs: [] });

      expect((await send('POST', `/api/tasks/${task.id}/reopen`, { status: 'todo' })).statusCode).toBe(400);
      const res = await send('POST', `/api/tasks/${task.id}/reopen`, { title: 'Second try' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'backlog', title: 'Second try' });
      expect(snapshotRepo.get(task.id)).toBeUndefined();
      expect((await send('POST', '/api/tasks/999/reopen')).statusCode).toBe(404);
    });

    it('deletes only Backlog and Cancelled tasks', async () => {
      const { id: projectId } = await createProject();
      const backlog = await createTask(projectId, 'backlog');
      const todo = await createTask(projectId, 'todo');
      const cancelled = await createTask(projectId, 'cancelled');
      await send('POST', `/api/tasks/${todo.id}/events`, { event: 'promote' });
      await send('POST', `/api/tasks/${cancelled.id}/cancel`);

      expect((await send('DELETE', `/api/tasks/${todo.id}`)).statusCode).toBe(409);
      expect((await send('DELETE', `/api/tasks/${backlog.id}`)).statusCode).toBe(204);
      expect((await send('DELETE', `/api/tasks/${cancelled.id}`)).statusCode).toBe(204);
      expect((await send('DELETE', `/api/tasks/${cancelled.id}`)).statusCode).toBe(404);
      expect((await send('DELETE', '/api/tasks/abc')).statusCode).toBe(400);
      expect((await send('GET', '/api/tasks')).json().map((t: { id: number }) => t.id)).toEqual([todo.id]);
    });

    it('validates reject feedback and refuses tasks not in review', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      expect((await send('POST', `/api/tasks/${task.id}/reject`, { feedback: '  ' })).statusCode).toBe(400);
      const res = await send('POST', `/api/tasks/${task.id}/reject`, { feedback: 'Use a toggle' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Only a task in review can be rejected');
    });

    it('creates, lists, updates and deletes templates per project', async () => {
      const { id: projectId } = await createProject();
      const created = await send('POST', `/api/projects/${projectId}/templates`, { name: 'Bug fix', model: 'opus', turnLimit: 40 });
      expect(created.statusCode).toBe(201);
      const template = created.json();
      expect(template).toMatchObject({ projectId, name: 'Bug fix', titlePrefix: '', visual: false, model: 'opus', turnLimit: 40 });

      expect((await send('POST', `/api/projects/${projectId}/templates`, { name: 'Bug fix' })).statusCode).toBe(409);
      expect((await send('POST', `/api/projects/${projectId}/templates`, { name: 'x', routes: ['settings'] })).statusCode).toBe(400);
      expect((await send('POST', `/api/projects/${projectId}/templates`, { name: 'x', projectId: 2 })).statusCode).toBe(400);
      expect((await send('POST', '/api/projects/999/templates', { name: 'x' })).statusCode).toBe(404);

      const patched = await send('PATCH', `/api/templates/${template.id}`, { visual: true, routes: ['/'], model: null });
      expect(patched.json()).toMatchObject({ visual: true, routes: ['/'], model: null, turnLimit: 40 });
      expect((await send('GET', `/api/projects/${projectId}/templates`)).json()).toHaveLength(1);

      expect((await send('DELETE', `/api/templates/${template.id}`)).statusCode).toBe(204);
      expect((await send('DELETE', `/api/templates/${template.id}`)).statusCode).toBe(404);
      expect((await send('GET', `/api/projects/${projectId}/templates`)).json()).toEqual([]);
    });

    it('reads and replaces project memory, validating the body', async () => {
      const { id: projectId } = await createProject();
      expect((await send('GET', `/api/projects/${projectId}/memory`)).json()).toEqual({ decisions: [], knowhow: [] });

      const saved = await send('PUT', `/api/projects/${projectId}/memory`, { decisions: [{ area: 'deps', text: 'Ask before adding one' }], knowhow: [] });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().decisions).toEqual([{ area: 'deps', text: 'Ask before adding one', taskId: null, date: expect.stringMatching(/^\d{4}-/) }]);
      expect((await send('GET', `/api/projects/${projectId}/memory`)).json()).toEqual(saved.json());

      expect((await send('PUT', `/api/projects/${projectId}/memory`, { decisions: [{ text: ' ' }], knowhow: [] })).statusCode).toBe(400);
      expect((await send('PUT', `/api/projects/${projectId}/memory`, { decisions: [] })).statusCode).toBe(400);
      expect((await send('PUT', '/api/projects/999/memory', { decisions: [], knowhow: [] })).statusCode).toBe(404);
    });

    it('shuts down only for the right control token, after replying', async () => {
      shutdowns = 0;
      expect((await send('POST', '/api/shutdown')).statusCode).toBe(403);
      expect((await send('POST', '/api/shutdown', undefined, { 'x-kanban-token': 'b'.repeat(64) })).statusCode).toBe(403);
      expect((await send('POST', '/api/shutdown', undefined, { 'x-kanban-token': 'short' })).statusCode).toBe(403);
      // A page in the browser carries a foreign Origin and never gets as far as the token check.
      const page = await send('POST', '/api/shutdown', undefined, { 'x-kanban-token': CONTROL_TOKEN, origin: 'http://evil.example' });
      expect(page.statusCode).toBe(403);
      expect(shutdowns).toBe(0);

      const ok = await send('POST', '/api/shutdown', undefined, { 'x-kanban-token': CONTROL_TOKEN });
      expect(ok.statusCode).toBe(202);
      await new Promise((r) => setImmediate(r));
      expect(shutdowns).toBe(1);
    });

    it('lists the project files for @-references', async () => {
      const { id: projectId } = await createProject();
      expect((await send('GET', `/api/projects/${projectId}/files`)).json()).toEqual({ files: ['README.md', 'src/app.ts'], truncated: false });
      expect((await send('GET', '/api/projects/999/files')).statusCode).toBe(404);
      expect((await send('GET', '/api/projects/abc/files')).statusCode).toBe(400);
    });

    it('totals usage per project', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      runRepo.start({ taskId: task.id, sessionId: 's', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' });
      const res = await send('GET', '/api/projects/usage');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([expect.objectContaining({ projectId, runs: 1, costUsd: 0 })]);
    });

    it('validates an answer and refuses tasks not waiting for input', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      expect((await send('POST', `/api/tasks/${task.id}/answer`, { answer: '' })).statusCode).toBe(400);
      expect((await send('POST', `/api/tasks/${task.id}/answer`, { answer: 'x', extra: 1 })).statusCode).toBe(400);
      const res = await send('POST', `/api/tasks/${task.id}/answer`, { answer: '/settings' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Only a task waiting for input can be answered');
    });
  });

  describe('screenshots', () => {
    it('lists a task screenshots and serves the image as PNG', async () => {
      const { id: projectId } = await createProject();
      const task = await createTask(projectId);
      const run = runRepo.start({ taskId: task.id, sessionId: 's', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' });
      const [good, missing] = shotRepo.save(run.id, [
        { route: '/', size: 'desktop', width: 1280, height: 800, file: '1/1/1-root-desktop.png', error: null },
        { route: '/x', size: 'desktop', width: 1280, height: 800, file: null, error: 'timeout' },
      ]);

      const list = (await send('GET', `/api/tasks/${task.id}/screenshots`)).json();
      expect(list.map((s: { hasImage: boolean }) => s.hasImage)).toEqual([true, false]);

      const image = await send('GET', `/api/screenshots/${good?.id}/image`);
      expect(image.statusCode).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.rawPayload).toEqual(PNG);
      expect((await send('GET', `/api/screenshots/${missing?.id}/image`)).statusCode).toBe(404);
      expect((await send('GET', '/api/screenshots/999/image')).statusCode).toBe(404);
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
