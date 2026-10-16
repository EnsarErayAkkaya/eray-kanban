import { z } from 'zod';
import { IdSchema, ModelSchema, TimestampSchema, TurnLimitSchema } from './common';
import { TASK_EVENTS, TASK_STATUSES } from './taskStatus';

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export const GIT_ISSUES = ['guard_tripped', 'merge_conflict', 'push_failed'] as const;
export type GitIssue = (typeof GIT_ISSUES)[number];

export const RouteSchema = z.string().trim().startsWith('/', 'routes start with /').max(200);

const fields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  acceptanceCriteria: z.string().max(10_000),
  priority: z.enum(PRIORITIES),
  visual: z.boolean(),
  routes: z.array(RouteSchema).max(20),
  model: ModelSchema,
  turnLimit: TurnLimitSchema,
  dependsOn: IdSchema.nullable(),
};

export const TaskSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  ...fields,
  status: z.enum(TASK_STATUSES),
  position: z.number(),
  gitIssue: z.enum(GIT_ISSUES).nullable(),
  gitIssueDetail: z.string().nullable(),
  pendingPush: z.string().nullable(),
  commitSha: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

// model and turnLimit stay optional: the service fills them from the project defaults.
export const CreateTaskInput = z.object({
  projectId: IdSchema,
  ...fields,
  description: fields.description.default(''),
  acceptanceCriteria: fields.acceptanceCriteria.default(''),
  priority: fields.priority.default('normal'),
  visual: fields.visual.default(false),
  routes: fields.routes.default([]),
  model: fields.model.optional(),
  turnLimit: fields.turnLimit.optional(),
  dependsOn: fields.dependsOn.default(null),
});
export type CreateTask = z.output<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object(fields).partial().strict();
export type TaskPatch = z.output<typeof UpdateTaskInput>;

export const TaskEventInput = z.object({ event: z.enum(TASK_EVENTS) }).strict();
