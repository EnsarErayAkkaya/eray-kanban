import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../services/ports';
import { buildClaudeArgs } from './claudeArgs';

const request: AgentRequest = {
  cwd: '/repos/shop',
  prompt: 'unused here',
  model: 'sonnet',
  maxTurns: 30,
  allowedCommands: [],
  sessionId: '0b6f3d2e-9c41-4a8e-b1f7-2d5c8e9a4f10',
  resume: false,
  timeoutMs: 1_000,
};

// Values that follow a flag, up to the next flag.
function valuesOf(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start === -1) return [];
  const rest = args.slice(start + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end === -1 ? rest : rest.slice(0, end);
}

describe('buildClaudeArgs', () => {
  it('runs headless, locked down, with the task model and turn cap', () => {
    const args = buildClaudeArgs(request, { hasClaudeMd: false });
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(valuesOf(args, '--model')).toEqual(['sonnet']);
    expect(valuesOf(args, '--max-turns')).toEqual(['30']);
    expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config', '--disable-slash-commands']));
    expect(args).not.toContain('--bare');
  });

  it('never puts the prompt in argv', () => {
    expect(buildClaudeArgs({ ...request, prompt: 'SECRET PROMPT' }, { hasClaudeMd: false })).not.toContain('SECRET PROMPT');
  });

  it('gives no Bash at all when the project allows no commands', () => {
    const args = buildClaudeArgs(request, { hasClaudeMd: false });
    expect(valuesOf(args, '--tools')).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(valuesOf(args, '--allowedTools')).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
  });

  it('allows only the listed commands, never bare Bash', () => {
    const args = buildClaudeArgs({ ...request, allowedCommands: ['npm run test', 'npm run lint'] }, { hasClaudeMd: false });
    expect(valuesOf(args, '--tools')).toContain('Bash');
    const allowed = valuesOf(args, '--allowedTools');
    expect(allowed).toEqual(expect.arrayContaining(['Bash(npm run test:*)', 'Bash(npm run lint:*)']));
    expect(allowed).not.toContain('Bash');
  });

  it('denies history-changing git commands (invariant 2)', () => {
    const denied = valuesOf(buildClaudeArgs(request, { hasClaudeMd: false }), '--disallowedTools');
    for (const cmd of ['commit', 'add', 'push', 'reset', 'checkout', 'merge', 'rebase', 'stash']) {
      expect(denied).toContain(`Bash(git ${cmd}:*)`);
    }
  });

  it('keeps .env files away from the agent', () => {
    const denied = valuesOf(buildClaudeArgs(request, { hasClaudeMd: false }), '--disallowedTools');
    expect(denied).toEqual(expect.arrayContaining(['Read(**/.env*)', 'Edit(**/.env*)', 'Write(**/.env*)']));
  });

  it("passes the project's CLAUDE.md, which --restricted would skip", () => {
    expect(valuesOf(buildClaudeArgs(request, { hasClaudeMd: true }), '--append-system-prompt-file')).toEqual([
      '/repos/shop/CLAUDE.md',
    ]);
    expect(buildClaudeArgs(request, { hasClaudeMd: false })).not.toContain('--append-system-prompt-file');
  });

  it('starts a new session under the chosen id', () => {
    const args = buildClaudeArgs(request, { hasClaudeMd: false });
    expect(valuesOf(args, '--session-id')).toEqual(['0b6f3d2e-9c41-4a8e-b1f7-2d5c8e9a4f10']);
    expect(args).not.toContain('--resume');
  });

  it('resumes the session instead when asked', () => {
    const args = buildClaudeArgs({ ...request, resume: true }, { hasClaudeMd: false });
    expect(valuesOf(args, '--resume')).toEqual(['0b6f3d2e-9c41-4a8e-b1f7-2d5c8e9a4f10']);
    expect(args).not.toContain('--session-id');
  });
});
