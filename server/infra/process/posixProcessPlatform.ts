import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Launch, ProcessPlatform } from './processPlatform';

// macOS and Linux: each child leads its own process group, so one signal reaches whatever it spawned.
export class PosixProcessPlatform implements ProcessPlatform {
  launch(command: string, args: readonly string[]): Launch {
    return { file: command, args, options: { detached: true } };
  }

  terminate(pid: number): void {
    signalGroup(pid, 'SIGTERM');
  }

  kill(pid: number): boolean {
    return signalGroup(pid, 'SIGKILL');
  }

  reap(pid: number): Promise<void> {
    // The group outlives its leader, so leftovers (a backgrounded dev server, say) are still reachable.
    signalGroup(pid, 'SIGKILL');
    return Promise.resolve();
  }

  commandLine(pid: number): string | null {
    return procCmdline(pid) ?? psCommand(pid);
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

// Linux has /proc even where a minimal ps lacks `-o command`.
function procCmdline(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
  } catch {
    return null;
  }
}

function psCommand(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return null;
  }
}
