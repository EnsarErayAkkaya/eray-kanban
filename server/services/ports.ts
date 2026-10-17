import type { CheckResult, RunChecks } from '@shared/check';
import type { Model } from '@shared/common';
import type { BoardEvent, ProjectStatus } from '@shared/events';
import type { NewProject, PROJECT_TYPES, Project, ProjectPatch, ScreenshotSize } from '@shared/project';
import type { Screenshot } from '@shared/screenshot';
import type { LogKind, ProjectUsage, Run, RunKind, RunLogLine, RunOutcome } from '@shared/run';
import type { ReviewJson } from '@shared/review';
import type { GitIssue, Task, TaskPatch } from '@shared/task';
import type { NewTemplate, TaskTemplate, TemplatePatch } from '@shared/template';
import type { StatusChange } from '../domain/taskMachine';

export type Clock = () => string;

type ProjectType = (typeof PROJECT_TYPES)[number];

export interface ProjectRepo {
  create(project: NewProject): Project;
  get(id: number): Project | undefined;
  list(): Project[];
  update(id: number, patch: ProjectPatch): Project;
}

export interface TemplateRepo {
  create(projectId: number, template: NewTemplate): TaskTemplate;
  get(id: number): TaskTemplate | undefined;
  listByProject(projectId: number): TaskTemplate[];
  update(id: number, patch: TemplatePatch): TaskTemplate;
  delete(id: number): void;
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
  /** null clears the badge. */
  setGitIssue(id: number, issue: TaskGitIssue | null): Task;
  setCommitSha(id: number, sha: string): Task;
}

export interface TaskGitIssue {
  readonly kind: GitIssue;
  readonly detail: string;
  /** Branch that still needs pushing, for Retry push. */
  readonly pendingPush: string | null;
}

export interface CheckRepo {
  /** Stores a run's check results and the pass and fail counts on the run itself. */
  save(runId: number, results: readonly CheckResult[]): void;
  listByTask(taskId: number): RunChecks[];
}

export interface SnapshotRepo {
  /** One per task; a second save for the same task fails with ConflictError. */
  save(taskId: number, snapshot: RepoSnapshot): void;
  get(taskId: number): RepoSnapshot | undefined;
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
  setReview(runId: number, review: ReviewJson): void;
  listRunning(): Run[];
  /** Only a running run can finish; a second finish fails with ConflictError. */
  finish(runId: number, end: RunEnd): Run;
  get(id: number): Run | undefined;
  listByTask(taskId: number): Run[];
  appendLog(runId: number, lines: readonly NewLogLine[]): RunLogLine[];
  logAfter(runId: number, afterSeq: number): RunLogLine[];
  usageByProject(): ProjectUsage[];
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

export interface RepoStatus {
  /** null when HEAD is detached. */
  readonly branch: string | null;
  /** null before the first commit. */
  readonly head: string | null;
  /** Tracked files with staged or unstaged changes. */
  readonly changed: readonly string[];
  /** Untracked files, ignored ones excluded. */
  readonly untracked: readonly string[];
}

export interface RepoSnapshot {
  readonly branch: string;
  readonly head: string;
  readonly untracked: readonly string[];
  /** Empty directories git does not see, so rollback leaves them in place. */
  readonly emptyDirs: readonly string[];
}

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: RepoSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'dirty' | 'wrong_branch' | 'detached' | 'no_commits';
      readonly detail: string;
    };

export type FileChange = 'added' | 'modified' | 'deleted';

export interface TouchedFile {
  readonly path: string;
  readonly change: FileChange;
}

export interface FileDiff extends TouchedFile {
  readonly patch: string;
  readonly binary: boolean;
  /** Cut off at the size limit, or left out once the total limit was reached. */
  readonly truncated: boolean;
}

export interface GuardResult {
  /** Empty when the agent left HEAD, the branch and the index alone. */
  readonly problems: readonly string[];
}

export interface RollbackResult {
  /** Empty when the tree matches the snapshot again. */
  readonly problems: readonly string[];
}

export type CommitResult =
  | { readonly ok: true; readonly sha: string | null; readonly files: readonly string[] }
  | { readonly ok: false; readonly error: string };

export type PushResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type MergeResult =
  | { readonly ok: true; readonly sha: string; readonly pushed: boolean; readonly pushError: string | null }
  | { readonly ok: false; readonly conflict: boolean; readonly files: readonly string[]; readonly error: string };

// Invariant 1: the only code that changes git history, and only the orchestrator calls it.
export interface GitPort {
  inspect(repo: string): Promise<RepoStatus>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  snapshot(repo: string, workingBranch: string): Promise<SnapshotResult>;
  touchedFiles(repo: string, snapshot: RepoSnapshot): Promise<TouchedFile[]>;
  diff(repo: string, snapshot: RepoSnapshot, files: readonly TouchedFile[]): Promise<FileDiff[]>;
  guardCheck(repo: string, snapshot: RepoSnapshot): Promise<GuardResult>;
  rollback(repo: string, snapshot: RepoSnapshot): Promise<RollbackResult>;
  /** sha is null when there was nothing left to commit. */
  commitTouched(repo: string, snapshot: RepoSnapshot, message: string): Promise<CommitResult>;
  push(repo: string, branch: string): Promise<PushResult>;
  mergeInto(repo: string, source: string, target: string, opts: { readonly push: boolean }): Promise<MergeResult>;
  /** Tracked plus new files, minus ignored ones, sorted; names only, for @-references in tasks. */
  listFiles(repo: string): Promise<string[]>;
}

export interface ShotTarget {
  readonly taskId: number;
  readonly runId: number;
  readonly routes: readonly string[];
}

export interface Shot {
  readonly route: string;
  readonly size: ScreenshotSize;
  readonly width: number;
  readonly height: number;
  /** Relative to the screenshots folder; null when nothing could be captured. */
  readonly file: string | null;
  readonly error: string | null;
}

// How the orchestrator checks and screenshots one kind of project.
export interface ProjectAdapter {
  /** Runs the project's check commands in its repo; an empty list when it has none. */
  check(project: Project, signal: AbortSignal): Promise<CheckResult[]>;
  /** One shot per route and size; problems come back as shots with an error, never as a throw. */
  screenshots(project: Project, target: ShotTarget, signal: AbortSignal): Promise<Shot[]>;
}

export interface ScreenshotRepo {
  save(runId: number, shots: readonly Shot[]): Screenshot[];
  listByTask(taskId: number): Screenshot[];
  /** The stored file for one screenshot, relative to the screenshots folder. */
  fileOf(id: number): string | null | undefined;
}

export interface ScreenshotFiles {
  /** null when the file is missing or would resolve outside the screenshots folder. */
  read(file: string): Buffer | null;
}

export interface Notifier {
  notify(title: string, message: string): void;
}

// A new project type is one new entry here, never a branch on project.type.
export type AdapterRegistry = Readonly<Record<ProjectType, ProjectAdapter>>;

export interface WorkScheduler {
  kick(projectId: number): Promise<void>;
  stop(taskId: number): boolean;
  /** Stops the run, if any, and resolves once its worker has finished and moved the task on. */
  stopAndWait(taskId: number): Promise<void>;
  resumeWithFeedback(taskId: number, feedback: string): Promise<void>;
  resumeWithAnswer(taskId: number, answer: string): Promise<void>;
  statuses(): ProjectStatus[];
}

export interface RepoProbe {
  isGitRepo(path: string): boolean;
}

export interface BoardEventSink {
  publish(event: BoardEvent): void;
}

export interface Logger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
}
