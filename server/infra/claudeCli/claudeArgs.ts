import path from 'node:path';
import type { AgentRequest } from '../../services/ports';

export const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;

// Invariant 2. The allow-list is the real fence; these catch direct calls if an allowed prefix ever overlaps.
export const DENIED_BASH = [
  'git commit',
  'git add',
  'git push',
  'git reset',
  'git checkout',
  'git merge',
  'git rebase',
  'git stash',
  'git clean',
  'git restore',
  'git switch',
  'rm',
  'npm publish',
] as const;

// The prompt goes on stdin, so it never meets argv parsing or the variadic tool flags.
export function buildClaudeArgs(req: AgentRequest, opts: { hasClaudeMd: boolean }): string[] {
  const bash = req.allowedCommands.length > 0;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    req.model,
    '--max-turns',
    String(req.maxTurns),
    '--restricted',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ];
  if (opts.hasClaudeMd) args.push('--append-system-prompt-file', path.join(req.cwd, 'CLAUDE.md'));
  // Either way the session UUID lands in argv, which is how the orphan reaper recognizes the process.
  args.push(req.resume ? '--resume' : '--session-id', req.sessionId);
  args.push('--tools', ...FILE_TOOLS, ...(bash ? ['Bash'] : []));
  args.push('--allowedTools', ...FILE_TOOLS, ...req.allowedCommands.map((cmd) => `Bash(${cmd}:*)`));
  args.push('--disallowedTools', ...DENIED_BASH.map((cmd) => `Bash(${cmd}:*)`));
  return args;
}
