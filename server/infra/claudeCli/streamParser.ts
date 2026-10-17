import { z } from 'zod';
import type { AgentEvent, NewLogLine } from '../../services/ports';

const TEXT_LIMIT = 2_000;
const TOOL_LIMIT = 300;
const RESULT_LIMIT = 200;

const ContentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const MessageEvent = z.looseObject({
  type: z.enum(['assistant', 'user']),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]) }),
});

const InitEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string().optional(),
});

const ResultEvent = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  session_id: z.string(),
  num_turns: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  result: z.string().default(''),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().default(0),
    cache_read_input_tokens: z.number().int().nonnegative().default(0),
  }),
});

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function relative(text: string, cwd: string): string {
  return text.split(`${cwd}/`).join('');
}

function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
  const detail = ['command', 'file_path', 'pattern', 'path'].map((k) => input[k]).find((v) => typeof v === 'string');
  return clip(relative(`${name} ${typeof detail === 'string' ? detail : ''}`.trim(), cwd), TOOL_LIMIT);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => (typeof c === 'object' && c !== null && 'text' in c && typeof c.text === 'string' ? c.text : ''))
      .join(' ');
  }
  return '';
}

function messageLines(event: z.infer<typeof MessageEvent>, cwd: string): NewLogLine[] {
  const { content } = event.message;
  if (typeof content === 'string') return event.type === 'assistant' ? [{ kind: 'text', text: clip(content, TEXT_LIMIT) }] : [];

  return content.flatMap((block): NewLogLine[] => {
    if (block.type === 'text' && block.text?.trim()) return [{ kind: 'text', text: clip(block.text.trim(), TEXT_LIMIT) }];
    if (block.type === 'tool_use' && block.name) {
      return [{ kind: 'tool_use', text: describeToolUse(block.name, block.input ?? {}, cwd) }];
    }
    if (block.type === 'tool_result') {
      const firstLine = relative(toolResultText(block.content), cwd).split('\n')[0] ?? '';
      return [{ kind: block.is_error ? 'error' : 'tool_result', text: clip(firstLine, RESULT_LIMIT) }];
    }
    return [];
  });
}

// One stdout line of `claude -p --output-format stream-json` in, zero or more agent events out.
export function parseStreamLine(line: string, cwd: string): AgentEvent[] {
  if (!line.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return [{ type: 'log', line: { kind: 'error', text: clip(`Unreadable CLI output: ${line}`, TOOL_LIMIT) } }];
  }

  const message = MessageEvent.safeParse(raw);
  if (message.success) return messageLines(message.data, cwd).map((l) => ({ type: 'log', line: l }));

  const init = InitEvent.safeParse(raw);
  if (init.success) {
    return [
      { type: 'session', sessionId: init.data.session_id },
      { type: 'log', line: { kind: 'system', text: `Session started (${init.data.model ?? 'unknown model'}, ${init.data.session_id.slice(0, 8)})` } },
    ];
  }

  const result = ResultEvent.safeParse(raw);
  if (result.success) {
    const r = result.data;
    return [
      {
        type: 'result',
        result: {
          subtype: r.subtype,
          isError: r.is_error,
          sessionId: r.session_id,
          text: r.result,
          usage: {
            numTurns: r.num_turns,
            inputTokens: r.usage.input_tokens,
            outputTokens: r.usage.output_tokens,
            cacheCreationTokens: r.usage.cache_creation_input_tokens,
            cacheReadTokens: r.usage.cache_read_input_tokens,
            costUsd: r.total_cost_usd,
          },
        },
      },
      {
        type: 'log',
        line: {
          kind: 'system',
          text: `Finished: ${r.subtype}, ${r.num_turns} turns, $${r.total_cost_usd.toFixed(4)} (cache write ${r.usage.cache_creation_input_tokens}, read ${r.usage.cache_read_input_tokens})`,
        },
      },
    ];
  }
  return [];
}
