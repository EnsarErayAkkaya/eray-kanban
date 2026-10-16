import { useEffect, useMemo, useReducer } from 'react';
import type { TaskEvent } from '@shared/taskStatus';
import { type ProjectDraft, type TaskDraft, api, openBoardStream } from './apiClient';
import { type BoardState, boardReducer, initialBoardState } from './boardState';

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface BoardActions {
  createProject(draft: ProjectDraft): Promise<ActionResult>;
  createTask(draft: TaskDraft): Promise<ActionResult>;
  sendEvent(taskId: number, event: TaskEvent): Promise<ActionResult>;
  stop(taskId: number): Promise<ActionResult>;
  loadHistory(taskId: number): Promise<ActionResult>;
  checkProject(projectId: number): Promise<ActionResult>;
  dismissError(): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function useBoard(): { state: BoardState; actions: BoardActions } {
  const [state, dispatch] = useReducer(boardReducer, initialBoardState);

  useEffect(() => {
    let wasConnected = false;
    const load = () =>
      Promise.all([api.projects(), api.tasks(), api.projectStatuses()])
        .then(([projects, tasks, statuses]) => dispatch({ type: 'loaded', projects, tasks, statuses }))
        .catch((err: unknown) => dispatch({ type: 'error', message: `Could not load the board: ${message(err)}` }));

    void load();
    const stream = openBoardStream(
      (event) => dispatch({ type: 'event', event }),
      (connected) => {
        // Events sent while the stream was down are gone; reload to catch up.
        if (connected && wasConnected) void load();
        if (connected) wasConnected = true;
        dispatch({ type: 'connection', connected });
      },
    );
    return () => stream.close();
  }, []);

  const actions = useMemo<BoardActions>(() => {
    // Board-level failures go to the banner; forms also get the message back to show inline.
    const attempt = async (work: () => Promise<void>, banner: boolean): Promise<ActionResult> => {
      try {
        await work();
        return { ok: true };
      } catch (err) {
        if (banner) dispatch({ type: 'error', message: message(err) });
        return { ok: false, error: message(err) };
      }
    };

    return {
      createProject: (draft) =>
        attempt(async () => dispatch({ type: 'projectSaved', project: await api.createProject(draft) }), false),
      createTask: (draft) =>
        attempt(async () => dispatch({ type: 'event', event: { type: 'task', task: await api.createTask(draft) } }), false),
      sendEvent: (taskId, event) =>
        attempt(async () => dispatch({ type: 'event', event: { type: 'task', task: await api.sendEvent(taskId, event) } }), true),
      stop: (taskId) => attempt(async () => void (await api.stop(taskId)), true),
      loadHistory: (taskId) =>
        attempt(async () => {
          const runs = await api.runs(taskId);
          dispatch({ type: 'runsLoaded', taskId, runs });
          const logs = await Promise.all(runs.map((r) => api.log(r.id)));
          dispatch({ type: 'logLoaded', taskId, lines: logs.flat() });
        }, true),
      checkProject: (projectId) => attempt(async () => void (await api.checkProject(projectId)), true),
      dismissError: () => dispatch({ type: 'error', message: null }),
    };
  }, []);

  return { state, actions };
}
