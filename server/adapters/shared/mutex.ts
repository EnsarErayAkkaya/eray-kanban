// Runs one job at a time, in call order; a failing job does not block the next.
export class Mutex {
  private _tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this._tail.then(job, job);
    this._tail = result.catch(() => undefined);
    return result;
  }
}
