import { z } from 'zod';
import { RunLogLineSchema, RunSchema } from './run';
import { TaskSchema } from './task';

// Pushed to the UI over SSE.
export const BoardEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task'), task: TaskSchema }),
  z.object({ type: z.literal('run'), run: RunSchema }),
  z.object({ type: z.literal('log'), taskId: z.number().int().positive(), lines: z.array(RunLogLineSchema) }),
]);
export type BoardEvent = z.infer<typeof BoardEventSchema>;
