import type { Project } from '@shared/project';
import type { ProcessExit, ProcessSupervisor } from '../../infra/process/processSupervisor';
import { splitCommand } from '../shared/commandRunner';

export interface DevServerOptions {
  readonly readyTimeoutMs: number;
  /** Invariant 9: even a server we forget to stop dies after this. */
  readonly maxLifetimeMs: number;
  readonly pollMs: number;
}

export const DEFAULT_DEV_SERVER_OPTIONS: DevServerOptions = {
  readyTimeoutMs: 90_000,
  maxLifetimeMs: 15 * 60_000,
  pollMs: 300,
};

export interface RunningServer {
  readonly url: string;
  readonly startedByUs: boolean;
  /** Stops the server only if this manager started it; resolves once its process group is gone. */
  stop(): Promise<void>;
}

export class DevServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevServerError';
  }
}

export type UrlProbe = (url: string) => Promise<boolean>;

/** Any HTTP answer means the server is up; a 404 on / is still a running dev server. */
export const probeUrl: UrlProbe = (url) =>
  fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const OUTPUT_TAIL = 4_000;

export class DevServerManager {
  constructor(
    private readonly _supervisor: ProcessSupervisor,
    private readonly _options: DevServerOptions = DEFAULT_DEV_SERVER_OPTIONS,
    private readonly _probe: UrlProbe = probeUrl,
    private readonly _env: NodeJS.ProcessEnv = process.env,
  ) {}

  async ensure(project: Project, signal: AbortSignal): Promise<RunningServer> {
    const url = project.devUrl;
    if (url === null) throw new DevServerError('Set a dev URL in the project settings to take screenshots');
    // A dev server you already run serves the same working tree, so reuse it and leave it running.
    if (await this._probe(url)) return { url, startedByUs: false, stop: () => Promise.resolve() };
    if (project.devCommand === null) throw new DevServerError(`Nothing answers at ${url}, and no dev command is set`);

    const [bin, ...args] = splitCommand(project.devCommand);
    if (!bin) throw new DevServerError('The dev command is empty');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    let output = '';
    // Set from the exit callback, so a plain let would be narrowed to null by the compiler.
    const state: { exited: ProcessExit | null } = { exited: null };
    const env: NodeJS.ProcessEnv = { ...this._env, BROWSER: 'none', NO_COLOR: '1' };
    delete env.ANTHROPIC_API_KEY;
    const exit = this._supervisor
      .run({
        command: bin,
        args,
        cwd: project.repoPath,
        env,
        stdin: '',
        timeoutMs: this._options.maxLifetimeMs,
        signal: controller.signal,
        onSpawn: () => undefined,
        onStdoutLine: (line) => {
          output = `${output}${line}\n`.slice(-OUTPUT_TAIL);
        },
      })
      .then((e) => {
        state.exited = e;
        signal.removeEventListener('abort', onAbort);
        return e;
      });
    const stop = async () => {
      controller.abort();
      await exit;
    };

    const deadline = Date.now() + this._options.readyTimeoutMs;
    while (state.exited === null && !signal.aborted && Date.now() < deadline) {
      if (await this._probe(url)) return { url, startedByUs: true, stop };
      await sleep(this._options.pollMs);
    }
    const exitedEarly = state.exited !== null;
    await stop();
    const finished = await exit;

    if (signal.aborted) throw new DevServerError('Stopped while the dev server was starting');
    if (exitedEarly && !finished.cancelled && !finished.timedOut) {
      const why = finished.spawnError ?? [output.trim(), finished.stderrTail].filter(Boolean).join('\n');
      throw new DevServerError(`The dev command exited before ${url} answered${why ? `:\n${why}` : ''}`);
    }
    throw new DevServerError(`${url} did not answer within ${Math.round(this._options.readyTimeoutMs / 1000)}s`);
  }
}
