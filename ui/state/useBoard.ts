import { useEffect, useMemo, useReducer } from 'react';
import type { AcceptOptions } from '@shared/review';
import type { Task } from '@shared/task';
import type { TaskEvent } from '@shared/taskStatus';
import { type ProjectDraft, type ProjectPatchDraft, type TaskDraft, api, openBoardStream } from './apiClient';
import { type BoardState, boardReducer, initialBoardState } from './boardState';

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type ReviewAction =
  | { readonly kind: 'accept'; readonly options: AcceptOptions }
  | { readonly kind: 'reject'; readonly feedback: string }
  | { readonly kind: 'answer'; readonly answer: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'retryPush' }
  | { readonly kind: 'resolveIssue' };

function runReviewAction(taskId: number, action: ReviewAction): Promise<Task> {
  switch (action.kind) {
    case 'accept':
      return api.accept(taskId, action.options);
    case 'reject':
      return api.reject(taskId, action.feedback);
    case 'answer':
      return api.answer(taskId, action.answer);
    case 'cancel':
      return api.cancel(taskId);
    case 'retryPush':
      return api.retryPush(taskId);
    case 'resolveIssue':
      return api.resolveIssue(taskId);
  }
}

export interface BoardActions {
  createProject(draft: ProjectDraft): Promise<ActionResult>;
  updateProject(projectId: number, patch: ProjectPatchDraft): Promise<ActionResult>;
  createTask(draft: TaskDraft): Promise<ActionResult>;
  sendEvent(taskId: number, event: TaskEvent): Promise<ActionResult>;
  stop(taskId: number): Promise<ActionResult>;
  /** inline: the caller shows the error itself instead of the board banner. */
  review(taskId: number, action: ReviewAction, inline?: boolean): Promise<ActionResult>;
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

    // Totals are cheap to recount, so refetch whenever a run ends rather than summing on the client.
    const loadUsage = () =>
      api
        .projectUsage()
        .then((usage) => dispatch({ type: 'usageLoaded', usage }))
        .catch((err: unknown) => dispatch({ type: 'error', message: `Could not load cost totals: ${message(err)}` }));

    void load();
    void loadUsage();
    const stream = openBoardStream(
      (event) => {
        dispatch({ type: 'event', event });
        if (event.type === 'run' && event.run.outcome !== 'running') void loadUsage();
      },
      (connected) => {
        // Events sent while the stream was down are gone; reload to catch up.
        if (connected && wasConnected) {
          void load();
          void loadUsage();
        }
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
      updateProject: (projectId, patch) =>
        attempt(async () => dispatch({ type: 'projectSaved', project: await api.updateProject(projectId, patch) }), false),
      createTask: (draft) =>
        attempt(async () => dispatch({ type: 'event', event: { type: 'task', task: await api.createTask(draft) } }), false),
      sendEvent: (taskId, event) =>
        attempt(async () => dispatch({ type: 'event', event: { type: 'task', task: await api.sendEvent(taskId, event) } }), true),
      stop: (taskId) => attempt(async () => void (await api.stop(taskId)), true),
      review: (taskId, action, inline = false) =>
        attempt(
          async () => dispatch({ type: 'event', event: { type: 'task', task: await runReviewAction(taskId, action) } }),
          !inline,
        ),
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
