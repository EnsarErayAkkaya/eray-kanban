import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

interface BaseRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onSpawn: (pid: number) => void;
}

export interface SpawnRequest extends BaseRequest {
  readonly onStdoutLine: (line: string) => void;
}

export interface CaptureRequest extends Omit<BaseRequest, 'signal' | 'onSpawn'> {
  readonly maxStdoutBytes: number;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError: string | null;
  readonly stderrTail: string;
}

export interface CapturedExit extends ProcessExit {
  readonly stdout: Buffer;
  readonly stdoutTruncated: boolean;
}

const STDERR_TAIL_BYTES = 4_000;

// Invariant 9: every process runs in its own process group so a kill reaches whatever it spawned.
export class ProcessSupervisor {
  private readonly _live = new Set<number>();

  constructor(private readonly _killGraceMs = 5_000) {}

  run(req: SpawnRequest): Promise<ProcessExit> {
    return this._spawn(req, (stdout) => readline.createInterface({ input: stdout }).on('line', req.onStdoutLine));
  }

  /** For short commands whose whole output is needed, such as git. */
  async capture(req: CaptureRequest): Promise<CapturedExit> {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const exit = await this._spawn(
      { ...req, signal: new AbortController().signal, onSpawn: () => undefined },
      (stdout) =>
        stdout.on('data', (chunk: Buffer) => {
          // Keep draining past the cap so the child never blocks on a full pipe.
          if (size + chunk.length > req.maxStdoutBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, req.maxStdoutBytes - size)));
            size = req.maxStdoutBytes;
          } else if (!truncated) {
            chunks.push(chunk);
            size += chunk.length;
          }
        }),
    );
    return { ...exit, stdout: Buffer.concat(chunks), stdoutTruncated: truncated };
  }

  private _spawn(req: BaseRequest, attachStdout: (stdout: Readable) => void): Promise<ProcessExit> {
    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let stderr = '';
      let child: ChildProcess;

      try {
        child = spawn(req.command, [...req.args], {
          cwd: req.cwd,
          env: req.env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve(failedSpawn(err));
        return;
      }

      const pid = child.pid;
      const kill = (why: 'timeout' | 'cancel') => {
        if (why === 'timeout') timedOut = true;
        else cancelled = true;
        if (pid !== undefined) this._killGroup(pid);
      };
      const timer = setTimeout(() => kill('timeout'), req.timeoutMs);
      const onAbort = () => kill('cancel');

      child.once('error', (err) => {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        if (pid === undefined) resolve(failedSpawn(err));
      });
      if (pid === undefined) return;
      const { stdin, stdout, stderr: errStream } = child;
      if (!stdin || !stdout || !errStream) throw new Error('spawn with stdio pipe gave no streams');

      this._live.add(pid);
      req.onSpawn(pid);
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });

      attachStdout(stdout);
      errStream.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
      });
      // The child may exit before reading stdin; EPIPE here is not our failure.
      stdin.on('error', () => undefined);
      stdin.end(req.stdin);

      child.once('close', (code, signal) => {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        this._live.delete(pid);
        // Leftovers in the group (a backgrounded dev server, say) die with the run.
        signalGroup(pid, 'SIGKILL');
        resolve({ code, signal, timedOut, cancelled, spawnError: null, stderrTail: stderr.trim() });
      });
    });
  }

  /** Synchronous so it can run from a process 'exit' handler. */
  killAll(): void {
    for (const pid of this._live) signalGroup(pid, 'SIGKILL');
    this._live.clear();
  }

  killStale(pid: number, commandMustContain: string): boolean {
    let command: string;
    try {
      command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    } catch {
      return false;
    }
    // The pid may have been reused by an unrelated process since the crash.
    if (!command.includes(commandMustContain)) return false;
    return signalGroup(pid, 'SIGKILL');
  }

  private _killGroup(pid: number): void {
    signalGroup(pid, 'SIGTERM');
    setTimeout(() => {
      if (this._live.has(pid)) signalGroup(pid, 'SIGKILL');
    }, this._killGraceMs).unref();
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function failedSpawn(err: unknown): ProcessExit {
  const message = err instanceof Error ? err.message : String(err);
  return { code: null, signal: null, timedOut: false, cancelled: false, spawnError: message, stderrTail: '' };
}
