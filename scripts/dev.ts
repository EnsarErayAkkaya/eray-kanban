import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hostProcessPlatform } from '../server/infra/process/processPlatform';

// `npm run dev`: the API watcher and Vite in one terminal. Stopping either stops both (invariant 9).
const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = (...parts: string[]) => path.join(repo, 'node_modules', ...parts);
const platform = hostProcessPlatform();
const GRACE_MS = 5_000;

const PROCESSES = [
  { name: 'api', args: [bin('tsx', 'dist', 'cli.mjs'), 'watch', '--tsconfig', 'tsconfig.server.json', 'server/main.ts'] },
  { name: 'ui ', args: [bin('vite', 'bin', 'vite.js')] },
] as const;

const live = new Map<number, ChildProcess>();
let stopping = false;
let exitCode = 0;

for (const { name, args } of PROCESSES) {
  const launch = platform.launch(process.execPath, args, process.env, repo);
  const child = spawn(launch.file, [...launch.args], {
    ...launch.options,
    cwd: repo,
    // Piped output turns colour off; keep it, unless you asked for none.
    env: process.env.NO_COLOR ? process.env : { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid === undefined) {
    console.error(`[${name}] could not start`);
    exitCode = 1;
    stopAll();
    break;
  }
  live.set(pid, child);
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) readline.createInterface({ input: stream }).on('line', (line) => console.log(`[${name}] ${line}`));
  }
  child.on('exit', (code) => {
    live.delete(pid);
    if (!stopping) {
      console.log(`[${name}] stopped (exit ${code ?? 'signal'}); stopping the rest`);
      exitCode = code ?? 1;
      stopAll();
    }
    if (live.size === 0) process.exit(exitCode);
  });
}

function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const pid of live.keys()) platform.terminate(pid);
  setTimeout(() => {
    for (const pid of live.keys()) platform.kill(pid);
  }, GRACE_MS).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stopAll);
