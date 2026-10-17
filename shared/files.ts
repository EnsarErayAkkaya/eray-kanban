import { z } from 'zod';

/** Enough for any normal repo; past this the explorer and @-search show what fits and say so. */
export const MAX_PROJECT_FILES = 20_000;

export const ProjectFilesSchema = z.object({
  /** Repo-relative, with / separators, sorted. Folders are implied by the paths. */
  files: z.array(z.string()),
  truncated: z.boolean(),
});
export type ProjectFiles = z.infer<typeof ProjectFilesSchema>;
