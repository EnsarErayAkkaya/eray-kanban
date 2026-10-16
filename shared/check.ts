import { z } from 'zod';

export const CheckResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  passed: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** The end of stdout and stderr together, where failures usually are. */
  output: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const RunChecksSchema = z.object({
  runId: z.number().int().positive(),
  results: z.array(CheckResultSchema),
});
export type RunChecks = z.infer<typeof RunChecksSchema>;
