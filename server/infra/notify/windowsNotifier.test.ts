import { describe, expect, it } from 'vitest';
import type { CaptureRequest, CapturedExit } from '../process/processSupervisor';
import { WindowsNotifier } from './windowsNotifier';

describe('WindowsNotifier', () => {
  it('passes title and message in the environment, outside the PowerShell source', async () => {
    const requests: CaptureRequest[] = [];
    const supervisor = {
      capture: (req: CaptureRequest): Promise<CapturedExit> => {
        requests.push(req);
        return Promise.resolve({
          code: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          spawnError: null,
          stderrTail: '',
          stdout: Buffer.alloc(0),
          stdoutTruncated: false,
        });
      },
    };
    const title = 'Task #3 is ready for review';
    const message = "Fix 'quotes' & <xml/>; Remove-Item -Recurse ~ · web";
    new WindowsNotifier(supervisor, { info: () => undefined, error: () => undefined }).notify(title, message);
    await Promise.resolve();

    const req = requests[0];
    expect(req?.command).toBe('powershell.exe');
    expect(req?.env).toMatchObject({ KANBAN_NOTIFY_TITLE: title, KANBAN_NOTIFY_MESSAGE: message });
    expect(req?.args.join(' ')).not.toContain('Remove-Item');
    expect(req?.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});
