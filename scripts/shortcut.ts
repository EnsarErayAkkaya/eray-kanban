import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_SHORTCUT_SCRIPT, dataDir, desktopEntry, posixLauncher } from './launchers';

// `npm run shortcut`: a double-clickable launcher for Agent Kanban in this repo. Safe to run again.
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function powershell(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', env, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `PowerShell failed (${result.status})`);
  return result.stdout;
}

// Windows: a shortcut to the tray app, which runs the server with no window.
function windows(): string[] {
  const tray = path.join(repo, 'scripts', 'windows', 'tray.ps1');
  const data = dataDir(repo);
  fs.mkdirSync(data, { recursive: true });
  const icon = path.join(data, 'agent-kanban.ico');
  powershell(['-ExecutionPolicy', 'Bypass', '-File', tray, '-WriteIcon', icon]);
  const out = powershell(['-Command', WINDOWS_SHORTCUT_SCRIPT], { ...process.env, KANBAN_REPO: repo, KANBAN_TRAY: tray, KANBAN_ICON: icon });
  return out.split(/\r?\n/).filter(Boolean);
}

function writeExecutable(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

// macOS: a .command file, which Finder runs in Terminal.
function mac(): string[] {
  return [writeExecutable(path.join(os.homedir(), 'Desktop', 'Agent Kanban.command'), posixLauncher(repo, 'terminal'))];
}

function linuxDesktopDir(): string {
  try {
    return execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim();
  } catch {
    return path.join(os.homedir(), 'Desktop');
  }
}

// Linux: an app-menu and desktop entry that starts the server in the background.
function linux(): string[] {
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  const launcher = writeExecutable(path.join(data, 'agent-kanban', 'start.sh'), posixLauncher(repo, 'background'));
  const entry = desktopEntry(launcher);
  const written = [writeExecutable(path.join(data, 'applications', 'agent-kanban.desktop'), entry)];
  const desktop = linuxDesktopDir();
  if (fs.existsSync(desktop)) {
    const file = writeExecutable(path.join(desktop, 'agent-kanban.desktop'), entry);
    // GNOME only launches desktop files it trusts; elsewhere this fails harmlessly.
    spawnSync('gio', ['set', file, 'metadata::trusted', 'true'], { stdio: 'ignore' });
    written.push(file);
  }
  return written;
}

const CREATORS: Partial<Record<NodeJS.Platform, () => string[]>> = { win32: windows, darwin: mac, linux };

const create = CREATORS[process.platform];
if (!create) {
  console.error(`No launcher for ${process.platform}; run \`npm start\` in ${repo} instead.`);
  process.exit(1);
}
for (const file of create()) console.log(`Created ${file}`);
console.log('Double-click it to start Agent Kanban. Run `npm run shortcut` again if you move this folder; `npm run stop` stops it.');
