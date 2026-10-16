import { describe, expect, it } from 'vitest';
import type { CaptureRequest, CapturedExit } from '../process/processSupervisor';
import { LinuxNotifier } from './linuxNotifier';

describe('LinuxNotifier', () => {
  it('passes title and message as argv after --', async () => {
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
    const title = '--icon=/etc/passwd';
    const message = 'Fix "quotes" & $(rm -rf ~)';
    new LinuxNotifier(supervisor, { info: () => undefined, error: () => undefined }).notify(title, message);
    await Promise.resolve();

    const req = requests[0];
    expect(req?.command).toBe('notify-send');
    expect(req?.args.slice(-3)).toEqual(['--', title, message]);
  });
});
