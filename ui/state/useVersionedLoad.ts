import { useEffect, useState } from 'react';

export interface LoadState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Loads again whenever version changes, e.g. when a run ends or the task moves; the last answer wins. */
export function useVersionedLoad<T>(load: () => Promise<T>, version: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => current && setState({ data, loading: false, error: null }))
      .catch((err: unknown) => current && setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      current = false;
    };
    // load is recreated on every render; version is what says the answer may have changed.
  }, [version]);

  return state;
}
