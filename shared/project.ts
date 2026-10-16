import { z } from 'zod';
import { IdSchema, ModelSchema, TimestampSchema, TurnLimitSchema } from './common';

export const PROJECT_TYPES = ['web', 'generic'] as const;
export const ACCEPT_FOLLOWUPS = ['none', 'push', 'merge'] as const;

// Branch names reach git argv, so a leading dash or odd characters could become an option.
const BranchSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]+$/, 'letters, digits, . _ / - only')
  .refine((s) => !s.startsWith('-') && !s.includes('..'), 'not a safe branch name');

// Each entry becomes a Bash(<cmd>:*) allow rule; shells and git would reopen the bypass seen in the CLI test.
const BLOCKED_COMMANDS = new Set(['sh', 'bash', 'zsh', 'env', 'eval', 'exec', 'xargs', 'sudo', 'git']);
const AllowedCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9 ._/:=@-]+$/, 'letters, digits, spaces and . _ / : = @ - only')
  .refine((cmd) => !BLOCKED_COMMANDS.has(cmd.split(' ')[0] ?? ''), 'shells and git are not allowed');

const fields = {
  name: z.string().trim().min(1).max(80),
  repoPath: z.string().trim().startsWith('/', 'must be an absolute path'),
  type: z.enum(PROJECT_TYPES),
  workingBranch: BranchSchema,
  mergeTarget: BranchSchema.nullable(),
  acceptCommit: z.boolean(),
  acceptFollowup: z.enum(ACCEPT_FOLLOWUPS),
  commitMessageFormat: z.string().trim().min(1).max(200),
  defaultModel: ModelSchema,
  defaultTurnLimit: TurnLimitSchema,
  allowedCommands: z.array(AllowedCommandSchema).max(50),
};

export const ProjectSchema = z.object({
  id: IdSchema,
  ...fields,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInput = z.object({
  ...fields,
  type: fields.type.default('web'),
  mergeTarget: fields.mergeTarget.default(null),
  acceptCommit: fields.acceptCommit.default(true),
  acceptFollowup: fields.acceptFollowup.default('none'),
  commitMessageFormat: fields.commitMessageFormat.default('feat(#{id}): {title}'),
  defaultModel: fields.defaultModel.default('sonnet'),
  defaultTurnLimit: fields.defaultTurnLimit.default(30),
  allowedCommands: fields.allowedCommands.default([]),
});
export type NewProject = z.output<typeof CreateProjectInput>;

// No defaults here: a PATCH must only touch the fields it names.
export const UpdateProjectInput = z.object(fields).partial().strict();
export type ProjectPatch = z.output<typeof UpdateProjectInput>;
