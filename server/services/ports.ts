import type { Model } from '@shared/common';
import type { BoardEvent } from '@shared/events';
import type { NewProject, Project, ProjectPatch } from '@shared/project';
import type { LogKind, Run, RunKind, RunLogLine, RunOutcome } from '@shared/run';
import type { Task, TaskPatch } from '@shared/task';
import type { StatusChange } from '../domain/taskMachine';

export type Clock = () => string;

export interface ProjectRepo {
  create(project: NewProject): Project;
  get(id: number): Project | undefined;
  list(): Project[];
  update(id: number, patch: ProjectPatch): Project;
}

export interface NewTask {
  readonly projectId: number;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly priority: Task['priority'];
  readonly visual: boolean;
  readonly routes: readonly string[];
  readonly model: Model;
  readonly turnLimit: number;
  readonly dependsOn: number | null;
}

export interface TaskRepo {
  /** New tasks start in backlog at the end of the order. */
  create(task: NewTask): Task;
  get(id: number): Task | undefined;
  list(filter?: { projectId?: number }): Task[];
  update(id: number, patch: TaskPatch): Task;
  /** Fails with StaleStatusError if the task left change.from, ProjectBusyError on invariant 3. */
  applyStatusChange(change: StatusChange): Task;
  /** Highest priority, then lowest position; skips tasks whose dependency is not done. */
  nextTodo(projectId: number): Task | undefined;
  activeTask(projectId: number): Task | undefined;
}

export interface NewRun {
  readonly taskId: number;
  readonly sessionId: string;
  readonly kind: RunKind;
  readonly model: Model;
  readonly turnLimit: number;
  readonly input: string;
}

export interface RunUsage {
  readonly numTurns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
}

export interface RunEnd {
  readonly outcome: Exclude<RunOutcome, 'running'>;
  readonly usage: RunUsage | null;
  readonly error: string | null;
}

export interface NewLogLine {
  readonly kind: LogKind;
  readonly text: string;
}

export interface RunRepo {
  start(run: NewRun): Run;
  setSessionId(runId: number, sessionId: string): void;
  setPid(runId: number, pid: number): void;
  listRunning(): Run[];
  /** Only a running run can finish; a second finish fails with ConflictError. */
  finish(runId: number, end: RunEnd): Run;
  get(id: number): Run | undefined;
  listByTask(taskId: number): Run[];
  appendLog(runId: number, lines: readonly NewLogLine[]): RunLogLine[];
  logAfter(runId: number, afterSeq: number): RunLogLine[];
}

export interface AgentRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: Model;
  readonly maxTurns: number;
  readonly allowedCommands: readonly string[];
  /** Chosen before spawn so it can be stored first and later identify the process. */
  readonly sessionId: string;
  readonly resume: boolean;
  readonly timeoutMs: number;
}

export interface AgentResult {
  readonly subtype: string;
  readonly isError: boolean;
  readonly sessionId: string;
  readonly text: string;
  readonly usage: RunUsage;
}

export type AgentEvent =
  | { readonly type: 'spawned'; readonly pid: number }
  | { readonly type: 'session'; readonly sessionId: string }
  | { readonly type: 'log'; readonly line: NewLogLine }
  | { readonly type: 'result'; readonly result: AgentResult };

export type AgentExit =
  | { readonly kind: 'result'; readonly result: AgentResult }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'crashed'; readonly error: string };

export interface AgentPort {
  /** Resolves once the process and everything it spawned are gone. */
  run(request: AgentRequest, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<AgentExit>;
  /** Kills a process left by a crashed server, only if that pid still runs the given session. */
  killOrphan(pid: number, sessionId: string): boolean;
}

export interface BoardEventSink {
  publish(event: BoardEvent): void;
}

export interface Logger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
}
