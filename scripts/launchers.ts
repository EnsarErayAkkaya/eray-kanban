import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const UI_SOURCES = ['ui', 'shared', 'vite.config.ts', 'tsconfig.ui.json', 'package-lock.json'] as const;

/** True when any UI source is newer than the last build, or there is no build yet. */
export function uiIsStale(repo: string): boolean {
  const built = fs.statSync(path.join(repo, 'dist', 'ui', 'index.html'), { throwIfNoEntry: false });
  if (!built) return true;
  return UI_SOURCES.some((source) => newestMtime(path.join(repo, source)) > built.mtimeMs);
}

function newestMtime(entry: string): number {
  const stat = fs.statSync(entry, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs
    .readdirSync(entry, { withFileTypes: true })
    .reduce((newest, child) => Math.max(newest, newestMtime(path.join(entry, child.name))), stat.mtimeMs);
}

export function dataDir(repo: string): string {
  return process.env.KANBAN_DATA_DIR ?? path.join(repo, 'data');
}

/** Starts a fresh server.log, keeping the previous run's as server.old.log. */
export function rotateLog(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'server.log');
  if (fs.existsSync(log)) fs.renameSync(log, path.join(dir, 'server.old.log'));
  return log;
}

export async function isServerUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isServerUp(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const OPENERS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['explorer.exe'],
  darwin: ['open'],
  linux: ['xdg-open'],
};

export function openBrowser(url: string): void {
  const [command, ...args] = OPENERS[process.platform] ?? ['xdg-open'];
  if (!command) return;
  // The browser outlives this process; a missing opener just means you open the URL yourself.
  const child = spawn(command, [...args, url], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The macOS .command file (in a terminal), and the script a Linux desktop entry runs (in the background). */
export function posixLauncher(repo: string, mode: 'terminal' | 'background'): string {
  const run =
    mode === 'background'
      ? "npm start -- --background || notify-send 'Agent Kanban did not start' 'See data/server.log in the repo.'"
      : "npm start || read -rp 'Agent Kanban stopped with an error. Press Enter to close. '";
  return [
    '#!/bin/bash',
    '# Created by `npm run shortcut`; run that again if you move the repo.',
    `cd ${shQuote(repo)} || exit 1`,
    '# Launchers skip your shell profile, so load nvm if you use it.',
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"',
    run,
    '',
  ].join('\n');
}

// Desktop entries quote Exec arguments with ", escaping \ " ` and $ inside.
const execQuote = (s: string) => `"${s.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;

export function desktopEntry(launcherPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Kanban',
    'Comment=Start the board in the background and open it in the browser',
    `Exec=${execQuote(launcherPath)}`,
    'Terminal=false',
    'Icon=utilities-terminal',
    'Categories=Development;',
    '',
  ].join('\n');
}

// Paths arrive in environment variables, so nothing here is spliced into PowerShell source.
// The shortcut starts the tray app hidden; ExecutionPolicy Bypass applies to that one process only.
export const WINDOWS_SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$shell = New-Object -ComObject WScript.Shell',
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
  "  $file = Join-Path $dir 'Agent Kanban.lnk'",
  '  $link = $shell.CreateShortcut($file)',
  "  $link.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:KANBAN_TRAY`""',
  '  $link.WorkingDirectory = $env:KANBAN_REPO',
  '  $link.WindowStyle = 7',
  '  $link.IconLocation = "$env:KANBAN_ICON,0"',
  "  $link.Description = 'Start Agent Kanban in the tray and open the board'",
  '  $link.Save()',
  '  Write-Output $file',
  '}',
].join('\n');
