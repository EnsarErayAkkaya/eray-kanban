import { z } from 'zod';
import { IdSchema, ModelSchema, TimestampSchema } from './common';

export const RUN_KINDS = ['initial', 'feedback', 'check_fix', 'answer'] as const;
export const RUN_OUTCOMES = ['running', 'completed', 'turn_limit', 'stopped', 'timed_out', 'failed'] as const;
export const LOG_KINDS = ['text', 'tool_use', 'tool_result', 'error', 'system'] as const;

export type RunKind = (typeof RUN_KINDS)[number];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type LogKind = (typeof LOG_KINDS)[number];

const Count = z.number().int().nonnegative();

export const RunSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  kind: z.enum(RUN_KINDS),
  outcome: z.enum(RUN_OUTCOMES),
  sessionId: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  model: ModelSchema,
  turnLimit: z.number().int().positive(),
  input: z.string(),
  numTurns: Count.nullable(),
  inputTokens: Count.nullable(),
  outputTokens: Count.nullable(),
  cacheCreationTokens: Count.nullable(),
  cacheReadTokens: Count.nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunLogLineSchema = z.object({
  runId: IdSchema,
  seq: z.number().int().positive(),
  kind: z.enum(LOG_KINDS),
  text: z.string(),
  at: TimestampSchema,
});
export type RunLogLine = z.infer<typeof RunLogLineSchema>;
