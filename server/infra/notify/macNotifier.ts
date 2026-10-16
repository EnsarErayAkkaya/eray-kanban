import os from 'node:os';
import type { Logger, Notifier } from '../../services/ports';
import type { ProcessSupervisor } from '../process/processSupervisor';

// The text travels as argv, never inside the script, so a task title cannot inject AppleScript.
const SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];

export class MacNotifier implements Notifier {
  constructor(
    private readonly _supervisor: Pick<ProcessSupervisor, 'capture'>,
    private readonly _log: Logger,
  ) {}

  notify(title: string, message: string): void {
    void this._supervisor
      .capture({
        command: 'osascript',
        args: [...SCRIPT.flatMap((line) => ['-e', line]), title, message],
        cwd: os.tmpdir(),
        env: process.env,
        stdin: '',
        timeoutMs: 5_000,
        maxStdoutBytes: 1_000,
      })
      .then((exit) => {
        if (exit.code !== 0) this._log.error(`Notification failed: ${exit.spawnError ?? exit.stderrTail}`);
      });
  }
}

export class SilentNotifier implements Notifier {
  notify(): void {}
}
