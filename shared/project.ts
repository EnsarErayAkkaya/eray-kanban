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

// Agent commands become Bash(<cmd>:*) allow rules; check and dev commands are split into argv with no shell.
// Either way, shells and git would reopen the bypass seen in the CLI test.
const BLOCKED_COMMANDS = new Set(['sh', 'bash', 'zsh', 'env', 'eval', 'exec', 'xargs', 'sudo', 'git']);
const CommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9 ._/:=@-]+$/, 'letters, digits, spaces and . _ / : = @ - only')
  .refine((cmd) => !BLOCKED_COMMANDS.has(cmd.split(' ')[0] ?? ''), 'shells and git are not allowed');

export const SCREENSHOT_SIZES = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
} as const;
export type ScreenshotSize = keyof typeof SCREENSHOT_SIZES;
const SIZE_NAMES = Object.keys(SCREENSHOT_SIZES) as [ScreenshotSize, ...ScreenshotSize[]];

// POSIX /…, Windows C:\… or C:/…, and UNC \\server\share. Shared with the UI, so no node:path.
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Screenshots only ever load the project's own local dev server.
const DevUrlSchema = z
  .url({ protocol: /^https?$/ })
  .refine((u) => LOCAL_HOSTS.has(new URL(u).hostname), 'must be a localhost URL');

const fields = {
  name: z.string().trim().min(1).max(80),
  repoPath: z.string().trim().regex(ABSOLUTE_PATH, 'must be an absolute path'),
  type: z.enum(PROJECT_TYPES),
  workingBranch: BranchSchema,
  mergeTarget: BranchSchema.nullable(),
  acceptCommit: z.boolean(),
  acceptFollowup: z.enum(ACCEPT_FOLLOWUPS),
  pushAfterMerge: z.boolean(),
  commitMessageFormat: z.string().trim().min(1).max(200),
  defaultModel: ModelSchema,
  defaultTurnLimit: TurnLimitSchema,
  allowedCommands: z.array(CommandSchema).max(50),
  checkCommands: z.array(CommandSchema).max(20),
  autoFix: z.boolean(),
  devCommand: CommandSchema.nullable(),
  devUrl: DevUrlSchema.nullable(),
  screenshotSizes: z
    .array(z.enum(SIZE_NAMES))
    .min(1)
    .refine((s) => new Set(s).size === s.length, 'each size once'),
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
  pushAfterMerge: fields.pushAfterMerge.default(false),
  commitMessageFormat: fields.commitMessageFormat.default('feat(#{id}): {title}'),
  defaultModel: fields.defaultModel.default('sonnet'),
  defaultTurnLimit: fields.defaultTurnLimit.default(30),
  allowedCommands: fields.allowedCommands.default([]),
  checkCommands: fields.checkCommands.default([]),
  autoFix: fields.autoFix.default(true),
  devCommand: fields.devCommand.default(null),
  devUrl: fields.devUrl.default(null),
  screenshotSizes: fields.screenshotSizes.default(['desktop']),
});
export type NewProject = z.output<typeof CreateProjectInput>;

// No defaults here: a PATCH must only touch the fields it names.
export const UpdateProjectInput = z.object(fields).partial().strict();
export type ProjectPatch = z.output<typeof UpdateProjectInput>;
