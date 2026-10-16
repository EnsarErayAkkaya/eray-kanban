import os from 'node:os';
import type { Logger, Notifier } from '../../services/ports';
import type { ProcessSupervisor } from '../process/processSupervisor';

// notify-send (libnotify) takes the text as argv; `--` keeps a title that starts with a dash from reading as an option.
export class LinuxNotifier implements Notifier {
  constructor(
    private readonly _supervisor: Pick<ProcessSupervisor, 'capture'>,
    private readonly _log: Logger,
  ) {}

  notify(title: string, message: string): void {
    void this._supervisor
      .capture({
        command: 'notify-send',
        args: ['--app-name=Agent Kanban', '--', title, message],
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
