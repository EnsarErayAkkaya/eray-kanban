import type { SpawnOptions } from 'node:child_process';
import { PosixProcessPlatform } from './posixProcessPlatform';
import { WindowsProcessPlatform } from './windowsProcessPlatform';

export interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Pick<SpawnOptions, 'detached' | 'windowsHide' | 'windowsVerbatimArguments'>;
}

/** How this OS starts a command and stops it together with everything it spawned. */
export interface ProcessPlatform {
  launch(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Launch;
  /** Asks the process tree to stop; kill() follows after the grace period. */
  terminate(pid: number): void;
  /** Synchronous so it can run from a process 'exit' handler. */
  kill(pid: number): boolean;
  /** Stops what an exited process left running. startedAt guards against reused pids. */
  reap(pid: number, startedAt: number, thorough: boolean): Promise<void>;
  commandLine(pid: number): string | null;
}

export function hostProcessPlatform(): ProcessPlatform {
  return process.platform === 'win32' ? new WindowsProcessPlatform() : new PosixProcessPlatform();
}
