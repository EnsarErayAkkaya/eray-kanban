import os from 'node:os';
import type { AgentEvent, AgentExit, AgentPort, AgentRequest, AgentResult } from '../../services/ports';
import type { ProcessSupervisor } from '../process/processSupervisor';
import { buildClaudeArgs } from './claudeArgs';
import { parseStreamLine } from './streamParser';
import { type SystemPrompt, prepareSystemPrompt } from './systemPrompt';

export interface ClaudeCommand {
  readonly bin: string;
  /** Lets tests run a fake CLI through node. */
  readonly prefixArgs: readonly string[];
}

// CLAUDE.md §4: an API key in the env would switch billing away from the user's login.
function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.ANTHROPIC_API_KEY;
  return copy;
}

export class ClaudeCliAgent implements AgentPort {
  constructor(
    private readonly _supervisor: ProcessSupervisor,
    private readonly _command: ClaudeCommand = { bin: 'claude', prefixArgs: [] },
    private readonly _env: NodeJS.ProcessEnv = process.env,
    private readonly _tmpDir: string = os.tmpdir(),
  ) {}

  async run(req: AgentRequest, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<AgentExit> {
    const seen: { result?: AgentResult } = {};
    let systemPrompt: SystemPrompt;
    try {
      systemPrompt = await prepareSystemPrompt(req.cwd, req.sessionId, this._tmpDir);
    } catch (err) {
      return { kind: 'crashed', error: `Could not read CLAUDE.md or .kanban/: ${err instanceof Error ? err.message : String(err)}` };
    }

    const exit = await this._supervisor
      .run({
        command: this._command.bin,
        args: [...this._command.prefixArgs, ...buildClaudeArgs(req, { systemPromptFile: systemPrompt.file })],
        cwd: req.cwd,
        env: agentEnv(this._env),
        stdin: req.prompt,
        timeoutMs: req.timeoutMs,
        signal,
        onSpawn: (pid) => onEvent({ type: 'spawned', pid }),
        onStdoutLine: (line) => {
          for (const event of parseStreamLine(line, req.cwd)) {
            if (event.type === 'result') seen.result = event.result;
            onEvent(event);
          }
        },
      })
      .finally(() => systemPrompt.dispose());

    // A result event means the work finished, even if the process was killed while lingering after it.
    if (seen.result) return { kind: 'result', result: seen.result };
    if (exit.cancelled) return { kind: 'cancelled' };
    if (exit.timedOut) return { kind: 'timeout' };
    const reason = exit.spawnError ?? (exit.stderrTail || `claude exited with code ${exit.code ?? exit.signal}`);
    return { kind: 'crashed', error: reason };
  }

  killOrphan(pid: number, sessionId: string): boolean {
    return this._supervisor.killStale(pid, sessionId);
  }
}
