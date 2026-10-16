import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_HEADER, CONTROL_TOKEN_FILE } from '../shared/control';
import { dataDir, isServerUp } from './launchers';

// `npm run stop`: asks the running server to stop its agents and exit, as Ctrl+C would.
const repo = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.KANBAN_PORT ?? 4317);

if (!(await isServerUp(port))) {
  console.log('Agent Kanban is not running.');
  process.exit(0);
}

let token: string;
try {
  token = fs.readFileSync(path.join(dataDir(repo), CONTROL_TOKEN_FILE), 'utf8').trim();
} catch {
  console.error('Agent Kanban is running but left no control token; stop it from its own window or the tray.');
  process.exit(1);
}

const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { [CONTROL_HEADER]: token } });
if (res.status !== 202) {
  console.error(`The server refused to stop (${res.status}).`);
  process.exit(1);
}

const end = Date.now() + 15_000;
while (Date.now() < end && (await isServerUp(port))) await new Promise((r) => setTimeout(r, 300));
if (await isServerUp(port)) {
  console.error('Agent Kanban is still running after 15 seconds.');
  process.exit(1);
}
console.log('Agent Kanban stopped.');
