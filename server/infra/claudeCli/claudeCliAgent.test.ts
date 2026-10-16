import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRequest } from '../../services/ports';
import { ProcessSupervisor } from '../process/processSupervisor';
import { ClaudeCliAgent } from './claudeCliAgent';

// Runs fixtures/fakeClaude.mjs through node instead of the real CLI.
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-agent-'));

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

function agent(env: Record<string, string>) {
  return new ClaudeCliAgent(
    new ProcessSupervisor(200),
    { bin: process.execPath, prefixArgs: [path.join(fixtures, 'fakeClaude.mjs')] },
    { ...process.env, ANTHROPIC_API_KEY: 'sk-should-be-dropped', ...env },
  );
}

const request: AgentRequest = {
  cwd: repo,
  prompt: 'Add the settings page',
  model: 'sonnet',
  maxTurns: 5,
  allowedCommands: [],
  sessionId: '0b6f3d2e-9c41-4a8e-b1f7-2d5c8e9a4f10',
  resume: false,
  timeoutMs: 5_000,
};

async function runAgent(env: Record<string, string>, overrides: Partial<AgentRequest> = {}, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  const exit = await agent(env).run({ ...request, ...overrides }, (e) => events.push(e), signal ?? new AbortController().signal);
  const texts = events.flatMap((e) => (e.type === 'log' ? [e.line.text] : []));
  return { exit, events, texts };
}

describe('ClaudeCliAgent', () => {
  it('sends the prompt on stdin, drops the API key and returns the result', async () => {
    const { exit, events, texts } = await runAgent({ FAKE_CLAUDE_FIXTURE: path.join(fixtures, 'resumeRun.ndjson') });
    expect(texts).toContain('PROMPT:Add the settings page');
    expect(texts).toContain('API_KEY:unset');
    expect(events[0]).toMatchObject({ type: 'spawned' });
    expect(events.some((e) => e.type === 'session')).toBe(true);
    expect(exit).toMatchObject({ kind: 'result', result: { subtype: 'success', text: 'DONE' } });
  });

  it("appends the repo's CLAUDE.md when it has one", async () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# rules');
    const { texts } = await runAgent({});
    fs.rmSync(path.join(repo, 'CLAUDE.md'));
    expect(texts.find((t) => t.startsWith('ARGS:'))).toContain(`--append-system-prompt-file ${repo}/CLAUDE.md`);
  });

  it('reports a crash with the stderr tail when no result came', async () => {
    const { exit } = await runAgent({ FAKE_CLAUDE_EXIT: '1', FAKE_CLAUDE_STDERR: 'Not logged in' });
    expect(exit).toEqual({ kind: 'crashed', error: 'Not logged in' });
  });

  it('reports a timeout', async () => {
    const { exit } = await runAgent({ FAKE_CLAUDE_HANG: '1' }, { timeoutMs: 300 });
    expect(exit).toEqual({ kind: 'timeout' });
  });

  it('reports a cancel', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const { exit } = await runAgent({ FAKE_CLAUDE_HANG: '1' }, {}, controller.signal);
    expect(exit).toEqual({ kind: 'cancelled' });
  });

  it('keeps the result when the process lingers after it and times out', async () => {
    const { exit } = await runAgent(
      { FAKE_CLAUDE_FIXTURE: path.join(fixtures, 'resumeRun.ndjson'), FAKE_CLAUDE_HANG: '1' },
      { timeoutMs: 500 },
    );
    expect(exit).toMatchObject({ kind: 'result' });
  });
});
