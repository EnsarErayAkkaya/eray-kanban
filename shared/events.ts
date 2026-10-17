import { z } from 'zod';
import { RunLogLineSchema, RunSchema } from './run';
import { ProjectSchema } from './project';
import { TaskSchema } from './task';

// Pushed to the UI over SSE.
export const BoardEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task'), task: TaskSchema }),
  z.object({ type: z.literal('project'), project: ProjectSchema }),
  z.object({ type: z.literal('taskDeleted'), taskId: z.number().int().positive() }),
  z.object({ type: z.literal('run'), run: RunSchema }),
  z.object({ type: z.literal('log'), taskId: z.number().int().positive(), lines: z.array(RunLogLineSchema) }),
  // blocked says why the project's next task cannot start, or null once it can.
  z.object({ type: z.literal('projectStatus'), projectId: z.number().int().positive(), blocked: z.string().nullable() }),
]);
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const ProjectStatusSchema = z.object({ projectId: z.number().int().positive(), blocked: z.string().nullable() });
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
