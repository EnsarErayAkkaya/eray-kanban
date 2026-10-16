import { type StdioOptions, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, isServerUp, openBrowser, rotateLog, uiIsStale, waitForServer } from './launchers';

// `npm start` and the launchers: one server on one port, serving the built UI too.
//   --log         output goes to data/server.log instead of this terminal (the Windows tray uses this)
//   --background  like --log, and this process exits once the server is up, leaving it running
const repo = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.KANBAN_PORT ?? 4317);
const url = `http://127.0.0.1:${port}/`;
const open = process.env.KANBAN_OPEN !== '0';
const background = process.argv.includes('--background');
const toLog = background || process.argv.includes('--log');
const bin = (...parts: string[]) => path.join(repo, 'node_modules', ...parts);

// A second server would run a second scheduler on the same database, so reuse the running one.
if (await isServerUp(port)) {
  console.log(`Agent Kanban is already running at ${url}`);
  if (open) openBrowser(url);
  process.exit(0);
}

// Only now: rotating earlier would move a running server's log aside.
const logFile = toLog ? rotateLog(dataDir(repo)) : null;
const logFd = logFile ? fs.openSync(logFile, 'a') : null;
const stdio: StdioOptions = logFd === null ? 'inherit' : ['ignore', logFd, logFd];
const say = (message: string) => (logFd === null ? console.log(message) : fs.writeSync(logFd, `${message}\n`));

if (uiIsStale(repo)) {
  say('Building the UI…');
  const build = spawnSync(process.execPath, [bin('vite', 'bin', 'vite.js'), 'build'], { cwd: repo, stdio });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, [bin('tsx', 'dist', 'cli.mjs'), '--tsconfig', 'tsconfig.server.json', 'server/main.ts'], {
  cwd: repo,
  stdio,
  // In the background the server must outlive this process and the terminal that started it.
  detached: background,
  windowsHide: true,
});
server.on('exit', (code) => process.exit(code ?? 1));

// Ctrl+C and a closed window reach the server directly, which shuts its agents down; this process only waits.
process.on('SIGINT', () => undefined);
process.on('SIGHUP', () => undefined);
process.on('SIGTERM', () => server.kill('SIGTERM'));

if (await waitForServer(port, 60_000)) {
  say(`Agent Kanban is running at ${url}`);
  if (!toLog) console.log('Close this window or press Ctrl+C to stop it.\n');
  if (open) openBrowser(url);
  if (background) {
    console.log(`Agent Kanban is running at ${url}. Stop it with \`npm run stop\`; its log is ${logFile}.`);
    server.unref();
    process.exit(0);
  }
} else if (background) {
  console.error(`Agent Kanban did not start; see ${logFile}`);
  process.exit(1);
}
