import { type ChildProcess, spawn } from 'node:child_process';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { hostProcessPlatform, type ProcessPlatform } from './processPlatform';

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

export interface TailRequest extends Omit<BaseRequest, 'onSpawn'> {
  readonly maxOutputBytes: number;
}

export interface TailExit extends ProcessExit {
  /** The last maxOutputBytes of stdout and stderr, interleaved as they arrived. */
  readonly output: string;
  readonly outputTruncated: boolean;
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

// Invariant 9: a kill reaches the whole process tree, and whatever a process leaves running dies with it.
export class ProcessSupervisor {
  private readonly _live = new Set<number>();

  constructor(
    private readonly _killGraceMs = 5_000,
    private readonly _platform: ProcessPlatform = hostProcessPlatform(),
  ) {}

  run(req: SpawnRequest): Promise<ProcessExit> {
    return this._spawn(req, true, (stdout) => readline.createInterface({ input: stdout }).on('line', req.onStdoutLine));
  }

  /** For short commands whose whole output is needed, such as git. */
  async capture(req: CaptureRequest): Promise<CapturedExit> {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    // Short commands such as git leave nothing behind, and a thorough reap is slow on Windows.
    const exit = await this._spawn(
      { ...req, signal: new AbortController().signal, onSpawn: () => undefined },
      false,
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

  /** For checks: failures are printed last, on either stream, so keep the end of both. */
  async tail(req: TailRequest): Promise<TailExit> {
    let output = '';
    let truncated = false;
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > req.maxOutputBytes) {
        truncated = true;
        output = output.slice(-req.maxOutputBytes);
      }
    };
    const exit = await this._spawn({ ...req, onSpawn: () => undefined }, true, (stdout, stderr) => {
      stdout.on('data', keep);
      stderr.on('data', keep);
    });
    return { ...exit, output, outputTruncated: truncated };
  }

  private _spawn(
    req: BaseRequest,
    thoroughReap: boolean,
    attachStdout: (stdout: Readable, stderr: Readable) => void,
  ): Promise<ProcessExit> {
    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let stderr = '';
      let child: ChildProcess;
      const startedAt = Date.now();

      try {
        const launch = this._platform.launch(req.command, req.args, req.env, req.cwd);
        child = spawn(launch.file, [...launch.args], {
          ...launch.options,
          cwd: req.cwd,
          env: req.env,
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

      attachStdout(stdout, errStream);
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
        void this._platform
          .reap(pid, startedAt, thoroughReap)
          .then(() => resolve({ code, signal, timedOut, cancelled, spawnError: null, stderrTail: stderr.trim() }));
      });
    });
  }

  /** Synchronous so it can run from a process 'exit' handler. */
  killAll(): void {
    for (const pid of this._live) this._platform.kill(pid);
    this._live.clear();
  }

  killStale(pid: number, commandMustContain: string): boolean {
    // The pid may have been reused by an unrelated process since the crash.
    if (!this._platform.commandLine(pid)?.includes(commandMustContain)) return false;
    return this._platform.kill(pid);
  }

  private _killGroup(pid: number): void {
    this._platform.terminate(pid);
    setTimeout(() => {
      if (this._live.has(pid)) this._platform.kill(pid);
    }, this._killGraceMs).unref();
  }
}

function failedSpawn(err: unknown): ProcessExit {
  const message = err instanceof Error ? err.message : String(err);
  return { code: null, signal: null, timedOut: false, cancelled: false, spawnError: message, stderrTail: '' };
}
