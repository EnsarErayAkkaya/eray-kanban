import { z } from 'zod';
import { IdSchema, ModelSchema, TimestampSchema, TurnLimitSchema } from './common';
import { PRIORITIES, RouteSchema } from './task';

const fields = {
  name: z.string().trim().min(1).max(80),
  titlePrefix: z.string().max(80),
  description: z.string().max(20_000),
  acceptanceCriteria: z.string().max(10_000),
  priority: z.enum(PRIORITIES),
  visual: z.boolean(),
  routes: z.array(RouteSchema).max(20),
  /** null: use the project's default. */
  model: ModelSchema.nullable(),
  turnLimit: TurnLimitSchema.nullable(),
};

export const TaskTemplateSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  ...fields,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

// The project comes from the URL, not the body.
export const CreateTemplateInput = z
  .object({
    ...fields,
    titlePrefix: fields.titlePrefix.default(''),
    description: fields.description.default(''),
    acceptanceCriteria: fields.acceptanceCriteria.default(''),
    priority: fields.priority.default('normal'),
    visual: fields.visual.default(false),
    routes: fields.routes.default([]),
    model: fields.model.default(null),
    turnLimit: fields.turnLimit.default(null),
  })
  .strict();
export type NewTemplate = z.output<typeof CreateTemplateInput>;

export const UpdateTemplateInput = z.object(fields).partial().strict();
export type TemplatePatch = z.output<typeof UpdateTemplateInput>;
