import { describe, expect, it } from 'vitest';
import { findLeftovers, parseRows } from './windowsProcessPlatform';

describe('findLeftovers', () => {
  const started = 1_000;

  it('finds every descendant of the exited process', () => {
    const rows = [
      { pid: 20, ppid: 10, createdMs: 1_100 },
      { pid: 30, ppid: 20, createdMs: 1_200 },
      { pid: 40, ppid: 99, createdMs: 1_300 },
    ];
    expect(findLeftovers(rows, 10, started)).toEqual([20, 30]);
  });

  it('ignores a process older than its supposed parent, since its parent pid was reused', () => {
    const rows = [
      { pid: 20, ppid: 10, createdMs: 500 },
      { pid: 30, ppid: 21, createdMs: 1_100 },
      { pid: 21, ppid: 10, createdMs: 1_200 },
    ];
    expect(findLeftovers(rows, 10, started)).toEqual([21]);
  });

  it('skips the children of an unrelated process that now holds the root pid', () => {
    const rows = [
      { pid: 20, ppid: 10, createdMs: 1_100 },
      { pid: 10, ppid: 1, createdMs: 1_500 },
      { pid: 30, ppid: 10, createdMs: 1_600 },
    ];
    expect(findLeftovers(rows, 10, started)).toEqual([20]);
  });
});

describe('parseRows', () => {
  it('reads pid, parent pid and creation time, skipping noise', () => {
    expect(parseRows('4 0 1700000000000\r\n\r\n12 4 1700000000500\r\nWARNING: x\r\n')).toEqual([
      { pid: 4, ppid: 0, createdMs: 1_700_000_000_000 },
      { pid: 12, ppid: 4, createdMs: 1_700_000_000_500 },
    ]);
  });
});
