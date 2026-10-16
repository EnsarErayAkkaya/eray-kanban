import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex';

describe('Mutex', () => {
  it('runs jobs one at a time in call order, even after a failure', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const job = (name: string, ms: number, fail = false) => () =>
      new Promise<string>((resolve, reject) =>
        setTimeout(() => {
          order.push(name);
          if (fail) reject(new Error(name));
          else resolve(name);
        }, ms),
      );
    const results = await Promise.allSettled([
      mutex.run(job('slow', 30)),
      mutex.run(job('fails', 1, true)),
      mutex.run(job('fast', 1)),
    ]);
    expect(order).toEqual(['slow', 'fails', 'fast']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
