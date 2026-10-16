import { describe, expect, it } from 'vitest';
import type { CaptureRequest, CapturedExit } from '../process/processSupervisor';
import { MacNotifier } from './macNotifier';

describe('MacNotifier', () => {
  it('passes title and message as argv, outside the AppleScript source', async () => {
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
    const message = 'Fix "quotes" & then do shell script "rm -rf ~" · web';
    new MacNotifier(supervisor, { info: () => undefined, error: () => undefined }).notify(title, message);
    await Promise.resolve();

    const req = requests[0];
    expect(req?.command).toBe('osascript');
    expect(req?.args.slice(-2)).toEqual([title, message]);
    const scriptLines = req?.args.filter((_, i, all) => all[i - 1] === '-e') ?? [];
    expect(scriptLines.join('\n')).not.toContain('rm -rf');
    expect(req?.timeoutMs).toBeLessThanOrEqual(5_000);
  });
});
