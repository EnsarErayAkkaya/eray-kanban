import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Launch, ProcessPlatform } from './processPlatform';
import { windowsLaunch } from './windowsCommand';

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly createdMs: number;
}

// One line per process: pid, parent pid, creation time in epoch ms. The script has no inputs.
const LIST_PROCESSES =
  "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];
const TOOL_TIMEOUT_MS = 15_000;

// Windows has no process groups and console programs have no SIGTERM, so stopping means taskkill /T /F.
export class WindowsProcessPlatform implements ProcessPlatform {
  constructor(private readonly _isFile: (file: string) => boolean = isFile) {}

  launch(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Launch {
    const l = windowsLaunch(command, args, env, cwd, this._isFile);
    // Not detached: on Windows that would open a console window per child.
    return { file: l.file, args: l.args, options: { windowsHide: true, windowsVerbatimArguments: l.verbatim } };
  }

  terminate(pid: number): void {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: TOOL_TIMEOUT_MS }, () => undefined);
  }

  kill(pid: number): boolean {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: TOOL_TIMEOUT_MS });
    return result.status === 0;
  }

  // Orphans keep their dead parent's pid, so they can still be found; listing every process takes about a second.
  async reap(pid: number, startedAt: number, thorough: boolean): Promise<void> {
    if (!thorough) return;
    const rows = await listProcesses();
    for (const leftover of findLeftovers(rows, pid, startedAt)) {
      try {
        process.kill(leftover);
      } catch {
        // Already gone.
      }
    }
  }

  commandLine(pid: number): string | null {
    const result = spawnSync(
      'powershell.exe',
      [...POWERSHELL_ARGS, `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: TOOL_TIMEOUT_MS },
    );
    const line = result.status === 0 ? result.stdout.trim() : '';
    return line === '' ? null : line;
  }
}

/** Descendants of a process that has exited. Each must be younger than its parent, so a reused pid breaks the chain. */
export function findLeftovers(rows: readonly ProcessRow[], rootPid: number, startedAt: number): number[] {
  const reusedRoot = rows.find((r) => r.pid === rootPid);
  const found: number[] = [];
  const queue: { pid: number; createdMs: number; before: number }[] = [
    { pid: rootPid, createdMs: startedAt, before: reusedRoot?.createdMs ?? Infinity },
  ];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const parent = next;
    for (const row of rows) {
      if (row.ppid !== parent.pid || row.pid === rootPid || found.includes(row.pid)) continue;
      if (row.createdMs < parent.createdMs || row.createdMs >= parent.before) continue;
      found.push(row.pid);
      queue.push({ pid: row.pid, createdMs: row.createdMs, before: Infinity });
    }
  }
  return found;
}

function listProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [...POWERSHELL_ARGS, LIST_PROCESSES],
      { windowsHide: true, timeout: TOOL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parseRows(stdout)),
    );
  });
}

export function parseRows(stdout: string): ProcessRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const [pid, ppid, createdMs] = line.trim().split(' ').map(Number);
    return pid && ppid !== undefined && createdMs ? [{ pid, ppid, createdMs }] : [];
  });
}

function isFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}
