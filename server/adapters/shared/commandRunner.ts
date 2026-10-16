import type { CheckResult } from '@shared/check';
import type { ProcessSupervisor } from '../../infra/process/processSupervisor';

export interface CommandRunnerOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export const DEFAULT_COMMAND_OPTIONS: CommandRunnerOptions = { timeoutMs: 10 * 60_000, maxOutputBytes: 20_000 };

/** Project commands were validated to plain words, so a whitespace split is the whole parse; no shell is involved. */
export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

// Test runners and linters read these to skip watch mode, prompts and colour codes.
function checkEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export class CommandRunner {
  constructor(
    private readonly _supervisor: ProcessSupervisor,
    private readonly _options: CommandRunnerOptions = DEFAULT_COMMAND_OPTIONS,
    private readonly _env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Runs every command in order, even after a failure, so the review shows all of them. Stops on abort. */
  async runAll(cwd: string, commands: readonly string[], signal: AbortSignal): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const command of commands) {
      if (signal.aborted) break;
      results.push(await this.run(cwd, command, signal));
    }
    return results;
  }

  async run(cwd: string, command: string, signal: AbortSignal): Promise<CheckResult> {
    const [bin, ...args] = splitCommand(command);
    const started = Date.now();
    if (!bin) return { command, exitCode: null, passed: false, timedOut: false, durationMs: 0, output: 'Empty command' };

    const exit = await this._supervisor.tail({
      command: bin,
      args,
      cwd,
      env: checkEnv(this._env),
      stdin: '',
      timeoutMs: this._options.timeoutMs,
      signal,
      maxOutputBytes: this._options.maxOutputBytes,
    });
    const notes = [
      exit.spawnError && `Could not start: ${exit.spawnError}`,
      exit.timedOut && `Killed after ${Math.round(this._options.timeoutMs / 1000)}s`,
      exit.cancelled && 'Stopped',
    ].filter(Boolean);
    return {
      command,
      exitCode: exit.code,
      passed: exit.code === 0 && !exit.timedOut && !exit.cancelled,
      timedOut: exit.timedOut,
      durationMs: Date.now() - started,
      output: [exit.outputTruncated ? '…' : '', exit.output.trimEnd(), ...notes].filter(Boolean).join('\n'),
    };
  }
}
