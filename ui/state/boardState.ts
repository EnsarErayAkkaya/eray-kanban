import type { BoardEvent, ProjectStatus } from '@shared/events';
import type { Project } from '@shared/project';
import type { ProjectUsage, Run, RunLogLine } from '@shared/run';
import type { Task } from '@shared/task';

const MAX_LOG_LINES = 1_000;

export interface BoardState {
  readonly loaded: boolean;
  readonly connected: boolean;
  readonly error: string | null;
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  /** By task id. */
  readonly runs: Readonly<Record<number, readonly Run[]>>;
  /** By task id, every run's lines in order. */
  readonly logs: Readonly<Record<number, readonly RunLogLine[]>>;
  /** By project id: why its next task cannot start. */
  readonly blocked: Readonly<Record<number, string>>;
  readonly usage: readonly ProjectUsage[];
}

export type BoardAction =
  | {
      readonly type: 'loaded';
      readonly projects: readonly Project[];
      readonly tasks: readonly Task[];
      readonly statuses: readonly ProjectStatus[];
    }
  | { readonly type: 'projectSaved'; readonly project: Project }
  | { readonly type: 'event'; readonly event: BoardEvent }
  | { readonly type: 'runsLoaded'; readonly taskId: number; readonly runs: readonly Run[] }
  | { readonly type: 'logLoaded'; readonly taskId: number; readonly lines: readonly RunLogLine[] }
  | { readonly type: 'usageLoaded'; readonly usage: readonly ProjectUsage[] }
  | { readonly type: 'connection'; readonly connected: boolean }
  | { readonly type: 'error'; readonly message: string | null };

export const initialBoardState: BoardState = {
  loaded: false,
  connected: false,
  error: null,
  projects: [],
  tasks: [],
  runs: {},
  logs: {},
  blocked: {},
  usage: [],
};

export type UsageTotals = Omit<ProjectUsage, 'projectId'>;

/** One project's totals, or every project's when projectId is null. */
export function usageTotals(usage: readonly ProjectUsage[], projectId: number | null): UsageTotals {
  const zero: UsageTotals = {
    runs: 0,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  return usage
    .filter((u) => projectId === null || u.projectId === projectId)
    .reduce(
      (sum, u) => ({
        runs: sum.runs + u.runs,
        numTurns: sum.numTurns + u.numTurns,
        inputTokens: sum.inputTokens + u.inputTokens,
        outputTokens: sum.outputTokens + u.outputTokens,
        cacheCreationTokens: sum.cacheCreationTokens + u.cacheCreationTokens,
        cacheReadTokens: sum.cacheReadTokens + u.cacheReadTokens,
        costUsd: sum.costUsd + u.costUsd,
      }),
      zero,
    );
}

function setBlocked(blocked: Readonly<Record<number, string>>, status: ProjectStatus): Record<number, string> {
  const others = Object.fromEntries(Object.entries(blocked).filter(([id]) => Number(id) !== status.projectId));
  return status.blocked === null ? others : { ...others, [status.projectId]: status.blocked };
}

function upsert<T extends { readonly id: number }>(items: readonly T[], item: T): T[] {
  const index = items.findIndex((i) => i.id === item.id);
  return index === -1 ? [...items, item] : items.map((i, n) => (n === index ? item : i));
}

// SSE lines and a fetched log overlap; (runId, seq) identifies a line.
function mergeLog(existing: readonly RunLogLine[], incoming: readonly RunLogLine[]): RunLogLine[] {
  const byKey = new Map(existing.map((l) => [`${l.runId}:${l.seq}`, l]));
  for (const line of incoming) byKey.set(`${line.runId}:${line.seq}`, line);
  return [...byKey.values()].sort((a, b) => a.runId - b.runId || a.seq - b.seq).slice(-MAX_LOG_LINES);
}

// An HTTP reply can arrive after an SSE event that already reported a later state.
function isStale(tasks: readonly Task[], incoming: Task): boolean {
  const known = tasks.find((t) => t.id === incoming.id);
  return known !== undefined && incoming.updatedAt < known.updatedAt;
}

function applyEvent(state: BoardState, event: BoardEvent): BoardState {
  switch (event.type) {
    case 'task':
      return isStale(state.tasks, event.task) ? state : { ...state, tasks: upsert(state.tasks, event.task) };
    case 'taskDeleted':
      return { ...state, tasks: state.tasks.filter((t) => t.id !== event.taskId) };
    case 'run':
      return { ...state, runs: { ...state.runs, [event.run.taskId]: upsert(state.runs[event.run.taskId] ?? [], event.run) } };
    case 'log':
      return { ...state, logs: { ...state.logs, [event.taskId]: mergeLog(state.logs[event.taskId] ?? [], event.lines) } };
    case 'projectStatus':
      return { ...state, blocked: setBlocked(state.blocked, event) };
  }
}

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        loaded: true,
        projects: action.projects,
        tasks: action.tasks,
        blocked: action.statuses.reduce<Record<number, string>>((acc, s) => setBlocked(acc, s), {}),
      };
    case 'projectSaved':
      return { ...state, projects: upsert(state.projects, action.project) };
    case 'event':
      return applyEvent(state, action.event);
    case 'runsLoaded':
      return { ...state, runs: { ...state.runs, [action.taskId]: action.runs } };
    case 'logLoaded':
      return { ...state, logs: { ...state.logs, [action.taskId]: mergeLog(state.logs[action.taskId] ?? [], action.lines) } };
    case 'usageLoaded':
      return { ...state, usage: action.usage };
    case 'connection':
      return { ...state, connected: action.connected };
    case 'error':
      return { ...state, error: action.message };
  }
}
