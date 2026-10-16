import { z } from 'zod';
import { ACCEPT_FOLLOWUPS } from './project';

const Lines = z.array(z.string().trim().min(1).max(2_000)).max(30);

// The JSON block the agent ends its final message with; everything else in a review comes from the orchestrator.
export const ReviewJsonSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('done'),
    summary: z.string().trim().min(1).max(4_000),
    notes: Lines.default([]),
    concerns: Lines.default([]),
  }),
  z.object({
    outcome: z.literal('needs_input'),
    question: z.string().trim().min(1).max(4_000),
    summary: z.string().trim().max(4_000).default(''),
  }),
]);
export type ReviewJson = z.output<typeof ReviewJsonSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'modified', 'deleted']),
  patch: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type FileDiffView = z.infer<typeof FileDiffSchema>;

// Read live from the working tree, so it always shows exactly what an accept would commit.
export const ReviewChangesSchema = z.object({
  available: z.boolean(),
  /** Why there is nothing to show, when available is false. */
  reason: z.string().nullable(),
  baseHead: z.string().nullable(),
  files: z.array(FileDiffSchema),
});
export type ReviewChanges = z.infer<typeof ReviewChangesSchema>;

export const RejectTaskInput = z.object({ feedback: z.string().trim().min(1).max(10_000) }).strict();

// Anything left out comes from the project's accept defaults.
export const AcceptTaskInput = z
  .object({
    commit: z.boolean().optional(),
    followup: z.enum(ACCEPT_FOLLOWUPS).optional(),
    pushAfterMerge: z.boolean().optional(),
  })
  .strict();
export type AcceptOptions = z.output<typeof AcceptTaskInput>;
