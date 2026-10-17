import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../services/ports';
import { parseStreamLine } from './streamParser';

const CWD = '/tmp/spike-repo';
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parseAll = (text: string): AgentEvent[] => text.split('\n').flatMap((l) => parseStreamLine(l, CWD));
const logs = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'log' ? [`${e.line.kind}: ${e.line.text}`] : []));

describe('parseStreamLine on recorded CLI output', () => {
  const events = parseAll(fixture('runWithDenials.ndjson'));

  it('reports the session once, from init', () => {
    expect(events.filter((e) => e.type === 'session')).toEqual([
      { type: 'session', sessionId: 'ff3c019d-7d55-4808-89d1-f9f65be639cc' },
    ]);
  });

  it('turns tool calls into short log lines with repo-relative paths', () => {
    const lines = logs(events);
    expect(lines).toContain('tool_use: Write bye.txt');
    expect(lines).toContain('tool_use: Bash git add bye.txt');
    expect(lines).toContain('error: Permission to use Bash with command git add bye.txt has been denied.');
    expect(lines.some((l) => l.includes('/tmp/spike-repo'))).toBe(false);
  });

  it('reads tokens, turns and cost from the result event', () => {
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({
      result: {
        subtype: 'success',
        isError: false,
        sessionId: 'ff3c019d-7d55-4808-89d1-f9f65be639cc',
        usage: { numTurns: 7, outputTokens: 1069, cacheCreationTokens: 3344, cacheReadTokens: 26380, costUsd: 0.02672 },
      },
    });
    expect(logs(events).at(-1)).toBe('system: Finished: success, 7 turns, $0.0267 (cache write 3344, read 26380)');
  });

  it('still finds the result when other events follow it', () => {
    const resume = parseAll(fixture('resumeRun.ndjson'));
    expect(resume.find((e) => e.type === 'result')).toMatchObject({ result: { text: 'DONE', usage: { numTurns: 2 } } });
  });
});

describe('parseStreamLine edge cases', () => {
  it('ignores blank lines and unknown event types', () => {
    expect(parseStreamLine('', CWD)).toEqual([]);
    expect(parseStreamLine('{"type":"rate_limit_event"}', CWD)).toEqual([]);
    expect(parseStreamLine('{"type":"system","subtype":"hook_started"}', CWD)).toEqual([]);
  });

  it('logs a line that is not JSON instead of throwing', () => {
    expect(parseStreamLine('Warning: something', CWD)).toEqual([
      { type: 'log', line: { kind: 'error', text: 'Unreadable CLI output: Warning: something' } },
    ]);
  });

  it('reads an error result without result text', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: 's1',
      num_turns: 30,
      total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(parseStreamLine(line, CWD)[0]).toMatchObject({
      type: 'result',
      result: { subtype: 'error_max_turns', text: '', usage: { numTurns: 30, cacheReadTokens: 0 } },
    });
  });

  it('clips long assistant text', () => {
    const text = 'x'.repeat(5_000);
    const [event] = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }), CWD);
    expect(event?.type === 'log' && event.line.text.length).toBe(2_000);
  });

  it('reads tool results given as text blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'line one\nline two' }] }] },
    });
    expect(parseStreamLine(line, CWD)).toEqual([{ type: 'log', line: { kind: 'tool_result', text: 'line one' } }]);
  });
});
