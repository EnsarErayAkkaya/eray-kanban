import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdSchema } from '@shared/common';
import type { BoardEvent } from '@shared/events';
import { CreateProjectInput, UpdateProjectInput } from '@shared/project';
import { CreateTaskInput, TaskEventInput, UpdateTaskInput } from '@shared/task';
import { CreateTemplateInput, UpdateTemplateInput } from '@shared/template';
import { AcceptTaskInput, AnswerTaskInput, RejectTaskInput } from '@shared/review';
import type { ProjectService } from '../services/projectService';
import type { ReviewService } from '../services/reviewService';
import type { TaskService } from '../services/taskService';
import type { TemplateService } from '../services/templateService';
import { type ControlDeps, registerControl } from './control';

export interface RouteDeps {
  readonly projects: ProjectService;
  readonly tasks: TaskService;
  readonly review: ReviewService;
  readonly templates: TemplateService;
  readonly control: ControlDeps;
  readonly subscribe: (listener: (event: BoardEvent) => void) => () => void;
  readonly heartbeatMs: number;
}

const IdParams = z.object({ id: IdSchema });
const TaskQuery = z.object({ projectId: IdSchema.optional() });
const LogQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { projects, tasks } = deps;

  app.get('/api/health', async () => ({ ok: true }));
  registerControl(app, deps.control);

  app.get('/api/projects', async () => projects.list());
  app.get('/api/projects/status', async () => projects.statuses());
  app.get('/api/projects/usage', async () => projects.usage());
  app.get('/api/projects/:id/files', async (req) => projects.files(IdParams.parse(req.params).id));
  app.post('/api/projects/:id/check', async (req, reply) => {
    projects.check(IdParams.parse(req.params).id);
    reply.code(202);
    return { checking: true };
  });
  app.post('/api/projects', async (req, reply) => {
    reply.code(201);
    return projects.create(CreateProjectInput.parse(req.body));
  });
  app.patch('/api/projects/:id', async (req) => {
    return projects.update(IdParams.parse(req.params).id, UpdateProjectInput.parse(req.body));
  });

  app.get('/api/projects/:id/templates', async (req) => deps.templates.list(IdParams.parse(req.params).id));
  app.post('/api/projects/:id/templates', async (req, reply) => {
    const template = deps.templates.create(IdParams.parse(req.params).id, CreateTemplateInput.parse(req.body));
    reply.code(201);
    return template;
  });
  app.patch('/api/templates/:id', async (req) => {
    return deps.templates.update(IdParams.parse(req.params).id, UpdateTemplateInput.parse(req.body));
  });
  app.delete('/api/templates/:id', async (req, reply) => {
    deps.templates.delete(IdParams.parse(req.params).id);
    reply.code(204);
  });

  app.get('/api/tasks', async (req) => tasks.list(TaskQuery.parse(req.query).projectId));
  app.post('/api/tasks', async (req, reply) => {
    reply.code(201);
    return tasks.create(CreateTaskInput.parse(req.body));
  });
  app.patch('/api/tasks/:id', async (req) => {
    return tasks.update(IdParams.parse(req.params).id, UpdateTaskInput.parse(req.body));
  });
  app.post('/api/tasks/:id/events', async (req) => {
    return tasks.applyBoardEvent(IdParams.parse(req.params).id, TaskEventInput.parse(req.body).event);
  });
  app.post('/api/tasks/:id/reject', async (req) => {
    return deps.review.reject(IdParams.parse(req.params).id, RejectTaskInput.parse(req.body).feedback);
  });
  app.post('/api/tasks/:id/answer', async (req) => {
    return deps.review.answer(IdParams.parse(req.params).id, AnswerTaskInput.parse(req.body).answer);
  });
  app.get('/api/tasks/:id/changes', async (req) => deps.review.changes(IdParams.parse(req.params).id));
  app.get('/api/tasks/:id/checks', async (req) => deps.review.checks(IdParams.parse(req.params).id));
  app.get('/api/tasks/:id/screenshots', async (req) => deps.review.screenshots(IdParams.parse(req.params).id));
  app.get('/api/screenshots/:id/image', async (req, reply) => {
    const image = deps.review.screenshotImage(IdParams.parse(req.params).id);
    // Files never change once taken, so the browser may keep them.
    return reply.type('image/png').header('cache-control', 'private, max-age=86400').send(image);
  });
  app.post('/api/tasks/:id/accept', async (req) => {
    return deps.review.accept(IdParams.parse(req.params).id, AcceptTaskInput.parse(req.body ?? {}));
  });
  app.post('/api/tasks/:id/cancel', async (req) => deps.review.cancel(IdParams.parse(req.params).id));
  app.post('/api/tasks/:id/retry-push', async (req) => deps.review.retryPush(IdParams.parse(req.params).id));
  app.post('/api/tasks/:id/resolve-issue', async (req) => deps.review.resolveIssue(IdParams.parse(req.params).id));
  app.post('/api/tasks/:id/stop', async (req, reply) => {
    tasks.stop(IdParams.parse(req.params).id);
    reply.code(202);
    return { stopping: true };
  });
  app.get('/api/tasks/:id/runs', async (req) => tasks.runs(IdParams.parse(req.params).id));
  app.get('/api/runs/:id/log', async (req) => {
    return tasks.log(IdParams.parse(req.params).id, LogQuery.parse(req.query).after);
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = deps.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    // Keeps proxies and the browser from treating a quiet board as a dead connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), deps.heartbeatMs);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
