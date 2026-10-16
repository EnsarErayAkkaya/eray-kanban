import { useEffect, useState } from 'react';
import type { ReviewChanges } from '@shared/review';
import { api } from './apiClient';

export interface ChangesState {
  readonly changes: ReviewChanges | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Re-reads the working tree whenever version changes, e.g. when a run ends or the task moves. */
export function useReviewChanges(taskId: number, version: string): ChangesState {
  const [state, setState] = useState<ChangesState>({ changes: null, loading: true, error: null });

  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    api
      .changes(taskId)
      .then((changes) => current && setState({ changes, loading: false, error: null }))
      .catch((err: unknown) => current && setState({ changes: null, loading: false, error: String(err instanceof Error ? err.message : err) }));
    return () => {
      current = false;
    };
  }, [taskId, version]);

  return state;
}
