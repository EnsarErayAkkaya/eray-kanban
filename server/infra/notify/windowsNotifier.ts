import os from 'node:os';
import type { Logger, Notifier } from '../../services/ports';
import type { ProcessSupervisor } from '../process/processSupervisor';

// The text travels in environment variables and becomes XML text nodes, so a task title cannot inject PowerShell or XML.
// Windows PowerShell 5.1, not pwsh: only it can load the WinRT toast types.
const SCRIPT = [
  '$type = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$xml = $type::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$texts = $xml.GetElementsByTagName('text')",
  '$null = $texts.Item(0).AppendChild($xml.CreateTextNode($env:KANBAN_NOTIFY_TITLE))',
  '$null = $texts.Item(1).AppendChild($xml.CreateTextNode($env:KANBAN_NOTIFY_MESSAGE))',
  // Toasts need a registered app id; PowerShell's own is always present.
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '$type::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('; ');

export class WindowsNotifier implements Notifier {
  constructor(
    private readonly _supervisor: Pick<ProcessSupervisor, 'capture'>,
    private readonly _log: Logger,
  ) {}

  notify(title: string, message: string): void {
    void this._supervisor
      .capture({
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
        cwd: os.tmpdir(),
        env: { ...process.env, KANBAN_NOTIFY_TITLE: title, KANBAN_NOTIFY_MESSAGE: message },
        stdin: '',
        timeoutMs: 10_000,
        maxStdoutBytes: 1_000,
      })
      .then((exit) => {
        if (exit.code !== 0) this._log.error(`Notification failed: ${exit.spawnError ?? exit.stderrTail}`);
      });
  }
}
