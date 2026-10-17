import { z } from 'zod';
import { RunChecksSchema } from '@shared/check';
import { ProjectFilesSchema } from '@shared/files';
import { type BoardEvent, BoardEventSchema, ProjectStatusSchema } from '@shared/events';
import { ProjectMemorySchema, type UpdateMemoryInput } from '@shared/memory';
import { type CreateProjectInput, ProjectSchema, type UpdateProjectInput } from '@shared/project';
import { type AcceptOptions, ReviewChangesSchema } from '@shared/review';
import { ProjectUsageSchema, RunLogLineSchema, RunSchema } from '@shared/run';
import { ScreenshotSchema } from '@shared/screenshot';
import { type CreateTaskInput, TaskSchema, type UpdateTaskInput } from '@shared/task';
import { type CreateTemplateInput, TaskTemplateSchema, type UpdateTemplateInput } from '@shared/template';
import type { TaskEvent } from '@shared/taskStatus';

export type ProjectDraft = z.input<typeof CreateProjectInput>;
export type ProjectPatchDraft = z.input<typeof UpdateProjectInput>;
export type TaskDraft = z.input<typeof CreateTaskInput>;
export type TaskPatchDraft = z.input<typeof UpdateTaskInput>;
export type TemplateDraft = z.input<typeof CreateTemplateInput>;
export type TemplatePatchDraft = z.input<typeof UpdateTemplateInput>;
export type MemoryDraft = z.input<typeof UpdateMemoryInput>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const ErrorBody = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

function describeError(body: unknown, status: number): string {
  const parsed = ErrorBody.safeParse(body);
  if (!parsed.success) return `Request failed (${status})`;
  const issues = parsed.data.issues?.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  return issues?.length ? issues.join('; ') : parsed.data.error;
}

async function call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`/api${path}`, init);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(describeError(data, res.status), res.status);
  return schema.parse(data);
}

export const api = {
  projects: () => call(z.array(ProjectSchema), 'GET', '/projects'),
  projectStatuses: () => call(z.array(ProjectStatusSchema), 'GET', '/projects/status'),
  projectUsage: () => call(z.array(ProjectUsageSchema), 'GET', '/projects/usage'),
  files: (projectId: number) => call(ProjectFilesSchema, 'GET', `/projects/${projectId}/files`),
  templates: (projectId: number) => call(z.array(TaskTemplateSchema), 'GET', `/projects/${projectId}/templates`),
  createTemplate: (projectId: number, draft: TemplateDraft) =>
    call(TaskTemplateSchema, 'POST', `/projects/${projectId}/templates`, draft),
  updateTemplate: (id: number, patch: TemplatePatchDraft) => call(TaskTemplateSchema, 'PATCH', `/templates/${id}`, patch),
  deleteTemplate: (id: number) => call(z.null(), 'DELETE', `/templates/${id}`),
  memory: (projectId: number) => call(ProjectMemorySchema, 'GET', `/projects/${projectId}/memory`),
  saveMemory: (projectId: number, draft: MemoryDraft) => call(ProjectMemorySchema, 'PUT', `/projects/${projectId}/memory`, draft),
  pauseProject: (projectId: number) => call(ProjectSchema, 'POST', `/projects/${projectId}/pause`),
  resumeProject: (projectId: number) => call(ProjectSchema, 'POST', `/projects/${projectId}/resume`),
  pauseAll: () => call(z.array(ProjectSchema), 'POST', '/projects/pause-all'),
  resumeAll: () => call(z.array(ProjectSchema), 'POST', '/projects/resume-all'),
  checkProject: (projectId: number) => call(z.object({ checking: z.boolean() }), 'POST', `/projects/${projectId}/check`),
  reject: (taskId: number, feedback: string) => call(TaskSchema, 'POST', `/tasks/${taskId}/reject`, { feedback }),
  answer: (taskId: number, answer: string) => call(TaskSchema, 'POST', `/tasks/${taskId}/answer`, { answer }),
  accept: (taskId: number, options: AcceptOptions) => call(TaskSchema, 'POST', `/tasks/${taskId}/accept`, options),
  cancel: (taskId: number) => call(TaskSchema, 'POST', `/tasks/${taskId}/cancel`),
  retryPush: (taskId: number) => call(TaskSchema, 'POST', `/tasks/${taskId}/retry-push`),
  resolveIssue: (taskId: number) => call(TaskSchema, 'POST', `/tasks/${taskId}/resolve-issue`),
  createProject: (draft: ProjectDraft) => call(ProjectSchema, 'POST', '/projects', draft),
  updateProject: (projectId: number, patch: ProjectPatchDraft) => call(ProjectSchema, 'PATCH', `/projects/${projectId}`, patch),
  changes: (taskId: number) => call(ReviewChangesSchema, 'GET', `/tasks/${taskId}/changes`),
  checks: (taskId: number) => call(z.array(RunChecksSchema), 'GET', `/tasks/${taskId}/checks`),
  screenshots: (taskId: number) => call(z.array(ScreenshotSchema), 'GET', `/tasks/${taskId}/screenshots`),
  screenshotUrl: (screenshotId: number) => `/api/screenshots/${screenshotId}/image`,
  tasks: () => call(z.array(TaskSchema), 'GET', '/tasks'),
  createTask: (draft: TaskDraft) => call(TaskSchema, 'POST', '/tasks', draft),
  updateTask: (taskId: number, patch: TaskPatchDraft) => call(TaskSchema, 'PATCH', `/tasks/${taskId}`, patch),
  reopenTask: (taskId: number, patch: TaskPatchDraft) => call(TaskSchema, 'POST', `/tasks/${taskId}/reopen`, patch),
  deleteTask: (taskId: number) => call(z.null(), 'DELETE', `/tasks/${taskId}`),
  sendEvent: (taskId: number, event: TaskEvent) => call(TaskSchema, 'POST', `/tasks/${taskId}/events`, { event }),
  stop: (taskId: number) => call(z.object({ stopping: z.boolean() }), 'POST', `/tasks/${taskId}/stop`),
  runs: (taskId: number) => call(z.array(RunSchema), 'GET', `/tasks/${taskId}/runs`),
  log: (runId: number, after = 0) => call(z.array(RunLogLineSchema), 'GET', `/runs/${runId}/log?after=${after}`),
};

export interface BoardStream {
  close(): void;
}

// EventSource reconnects by itself; onConnection(true) after a drop means events may have been missed.
export function openBoardStream(onEvent: (event: BoardEvent) => void, onConnection: (connected: boolean) => void): BoardStream {
  const source = new EventSource('/api/events');
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.onmessage = (msg: MessageEvent<string>) => {
    const parsed = BoardEventSchema.safeParse(JSON.parse(msg.data));
    if (parsed.success) onEvent(parsed.data);
  };
  return { close: () => source.close() };
}
