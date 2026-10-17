import type { CheckResult } from '@shared/check';
import type { ProjectStatus } from '@shared/events';
import type { Project } from '@shared/project';
import type { RunKind, RunOutcome } from '@shared/run';
import type { Task } from '@shared/task';
import { StaleStatusError } from '../domain/errors';
import { type TaskEvent, transition } from '../domain/taskMachine';
import type {
  AdapterRegistry,
  AgentEvent,
  AgentExit,
  AgentPort,
  BoardEventSink,
  CheckRepo,
  GitPort,
  Logger,
  NewLogLine,
  Notifier,
  ProjectRepo,
  RunEnd,
  RunRepo,
  ScreenshotRepo,
  Shot,
  SnapshotRepo,
  TaskRepo,
  WorkScheduler,
} from './ports';
import { extractReviewJson } from './reviewJson';
import { pickScreenshotRoutes } from './screenshotRoutes';
import { renderAnswerPrompt, renderCheckFixPrompt, renderFeedbackPrompt, renderTaskPrompt } from './taskPrompt';

export interface SchedulerDeps {
  readonly projects: ProjectRepo;
  readonly tasks: TaskRepo;
  readonly runs: RunRepo;
  readonly snapshots: SnapshotRepo;
  readonly checks: CheckRepo;
  readonly screenshots: ScreenshotRepo;
  readonly agent: AgentPort;
  readonly git: GitPort;
  readonly adapters: AdapterRegistry;
  readonly notifier: Notifier;
  readonly events: BoardEventSink;
  readonly log: Logger;
}

export interface SchedulerOptions {
  readonly taskTemplate: string;
  readonly feedbackTemplate: string;
  readonly answerTemplate: string;
  readonly checkFixTemplate: string;
  readonly runTimeoutMs: number;
  readonly newSessionId: () => string;
}

type ResumeKind = Extract<RunKind, 'feedback' | 'answer'>;

interface Session {
  readonly id: string;
  readonly resume: boolean;
}

interface Step {
  readonly kind: RunKind;
  readonly input: string;
  readonly session: Session;
}

interface RunSummary {
  readonly runId: number;
  readonly outcome: RunOutcome;
  /** submit, or askInput when the agent asked a question. */
  readonly event: TaskEvent;
  readonly sessionId: string;
}

// A stopped, crashed or timed-out run goes to review as it is; checks would only add noise.
const CHECKED_OUTCOMES: ReadonlySet<RunOutcome> = new Set(['completed', 'turn_limit']);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function toRunEnd(exit: AgentExit): RunEnd {
  switch (exit.kind) {
    case 'result': {
      const { subtype, usage } = exit.result;
      if (subtype === 'success') return { outcome: 'completed', usage, error: null };
      if (subtype === 'error_max_turns') return { outcome: 'turn_limit', usage, error: null };
      return { outcome: 'failed', usage, error: `CLI ended with ${subtype}` };
    }
    case 'cancelled':
      return { outcome: 'stopped', usage: null, error: null };
    case 'timeout':
      return { outcome: 'timed_out', usage: null, error: 'Run hit its time limit and was killed' };
    case 'crashed':
      return { outcome: 'failed', usage: null, error: exit.error };
  }
}

// One worker per project, started by board events rather than polling.
export class Scheduler implements WorkScheduler {
  private readonly _workers = new Map<number, Promise<void>>();
  private readonly _controllers = new Map<number, AbortController>();
  private readonly _blocked = new Map<number, string>();

  constructor(
    private readonly _deps: SchedulerDeps,
    private readonly _options: SchedulerOptions,
  ) {}

  /** Starts the project's next Todo task if the project is idle; resolves when that run has ended. */
  kick(projectId: number): Promise<void> {
    return this._exclusive(projectId, () => this._work(projectId));
  }

  async kickAll(): Promise<void> {
    await Promise.all(this._deps.projects.list().map((p) => this.kick(p.id)));
  }

  /** Kill switch: the run ends as stopped and the task goes to review with what it has. */
  stop(taskId: number): boolean {
    const controller = this._controllers.get(taskId);
    controller?.abort();
    return controller !== undefined;
  }

  /** Pause switch: stops the project's running agent, if any; the task goes to review as with stop(). */
  stopProject(projectId: number): boolean {
    const active = this._deps.tasks.activeTask(projectId);
    return active !== undefined && this.stop(active.id);
  }

  async stopAndWait(taskId: number): Promise<void> {
    const task = this._deps.tasks.get(taskId);
    if (!task) return;
    this.stop(taskId);
    await this._workers.get(task.projectId);
  }

  /** Resumes the task's last session with review feedback; the task must already be back in progress. */
  resumeWithFeedback(taskId: number, feedback: string): Promise<void> {
    return this._queueResume(taskId, 'feedback', feedback);
  }

  /** Resumes the task's last session with the answer to its question; the task must already be back in progress. */
  resumeWithAnswer(taskId: number, answer: string): Promise<void> {
    return this._queueResume(taskId, 'answer', answer);
  }

  statuses(): ProjectStatus[] {
    return this._deps.projects.list().map((p) => ({ projectId: p.id, blocked: this._blocked.get(p.id) ?? null }));
  }

  /** After a crash or restart: kill leftover agents and send their tasks to review. */
  recoverInterrupted(): void {
    const { runs, tasks, agent, events, log } = this._deps;
    for (const run of runs.listRunning()) {
      if (run.pid !== null && run.sessionId !== null && agent.killOrphan(run.pid, run.sessionId)) {
        log.info(`Killed leftover agent pid ${run.pid}`);
      }
      events.publish({
        type: 'run',
        run: runs.finish(run.id, { outcome: 'failed', usage: null, error: 'Server stopped during the run' }),
      });
      const task = tasks.get(run.taskId);
      if (task?.status === 'in_progress') this._move(task, 'submit');
    }
  }

  private _exclusive(projectId: number, work: () => Promise<void>): Promise<void> {
    const running = this._workers.get(projectId);
    if (running) return running;
    const worker = work()
      .catch((err: unknown) => this._deps.log.error(`Worker for project ${projectId} failed`, err))
      .finally(() => this._workers.delete(projectId));
    this._workers.set(projectId, worker);
    return worker;
  }

  private async _work(projectId: number): Promise<void> {
    const { projects, tasks, git, snapshots } = this._deps;
    const project = projects.get(projectId);
    if (!project) return;
    const next = project.paused || tasks.activeTask(projectId) ? undefined : tasks.nextTodo(projectId);
    if (!next) {
      this._setBlocked(projectId, null);
      return;
    }

    // Invariant 4: start only from a fully clean tree already on the working branch; never switch branches here.
    let result: Awaited<ReturnType<GitPort['snapshot']>>;
    try {
      result = await git.snapshot(project.repoPath, project.workingBranch);
    } catch (err) {
      this._setBlocked(projectId, `Could not read the repo: ${errorText(err)}`);
      return;
    }
    if (!result.ok) {
      this._setBlocked(projectId, result.detail);
      return;
    }
    this._setBlocked(projectId, null);

    // The task may have been cancelled or moved back, or the project paused, while the repo was being checked.
    const current = tasks.get(next.id);
    if (current?.status !== 'todo' || projects.get(projectId)?.paused) return;
    let task: Task;
    try {
      task = this._move(current, 'start');
    } catch (err) {
      if (err instanceof StaleStatusError) return;
      throw err;
    }
    snapshots.save(task.id, result.snapshot);
    const prompt = renderTaskPrompt(this._options.taskTemplate, task);
    await this._pipeline(project, task, { kind: 'initial', input: prompt, session: { id: this._options.newSessionId(), resume: false } });
  }

  private _queueResume(taskId: number, kind: ResumeKind, text: string): Promise<void> {
    const task = this._deps.tasks.get(taskId);
    if (!task) return Promise.resolve();
    // A kick that found the project occupied ends at once; queue behind it instead of being dropped.
    const running = this._workers.get(task.projectId);
    if (running) return running.then(() => this._queueResume(taskId, kind, text));
    return this._exclusive(task.projectId, () => this._resume(task.id, kind, text));
  }

  private async _resume(taskId: number, kind: ResumeKind, text: string): Promise<void> {
    const { tasks, projects, runs, log } = this._deps;
    const task = tasks.get(taskId);
    const project = task && projects.get(task.projectId);
    if (!task || !project || task.status !== 'in_progress') return;
    if (project.paused) {
      // Paused after the reply was queued: no agent may start, so hand the task back to review.
      log.info(`Project ${project.id} is paused; task ${task.id} goes back to review without resuming`);
      this._move(task, 'submit');
      return;
    }

    const sessionId = runs
      .listByTask(task.id)
      .map((r) => r.sessionId)
      .filter((id) => id !== null)
      .at(-1);
    if (!sessionId) {
      // Nothing to resume into: hand the task back rather than leave it in progress with no agent.
      log.error(`Task ${task.id} has no session to resume`);
      this._move(task, 'submit');
      return;
    }
    const prompt =
      kind === 'answer'
        ? renderAnswerPrompt(this._options.answerTemplate, task, text)
        : renderFeedbackPrompt(this._options.feedbackTemplate, task, text);
    await this._pipeline(project, task, { kind, input: prompt, session: { id: sessionId, resume: true } });
  }

  // run → guard → checks → at most one fix pass per round → review. One signal stops whichever step is running.
  private async _pipeline(project: Project, task: Task, first: Step): Promise<void> {
    const controller = new AbortController();
    this._controllers.set(task.id, controller);
    const { signal } = controller;
    try {
      let step = first;
      for (;;) {
        const run = await this._runAgent(project, task, step, signal);
        await this._guard(project, task.id, run.runId);
        if (run.event !== 'submit' || !CHECKED_OUTCOMES.has(run.outcome) || signal.aborted) {
          return this._settle(project, task.id, run.event);
        }
        const failed = (await this._runChecks(project, task.id, run.runId, signal)).filter((r) => !r.passed);
        const fixPass = failed.length > 0 && project.autoFix && step.kind !== 'check_fix' && run.outcome === 'completed';
        if (!fixPass || signal.aborted) {
          // Screenshots come last so they show the code exactly as it will be reviewed.
          await this._takeScreenshots(project, task.id, run.runId, signal);
          return this._settle(project, task.id, 'submit');
        }

        this._appendLog(task.id, run.runId, { kind: 'system', text: 'Checks failed; resuming once so the agent can fix them' });
        step = {
          kind: 'check_fix',
          input: renderCheckFixPrompt(this._options.checkFixTemplate, task, failed),
          session: { id: run.sessionId, resume: true },
        };
      }
    } finally {
      this._controllers.delete(task.id);
    }
  }

  private async _runAgent(project: Project, task: Task, step: Step, signal: AbortSignal): Promise<RunSummary> {
    const { runs, agent, events } = this._deps;
    const { kind, input, session } = step;
    const run = runs.start({ taskId: task.id, sessionId: session.id, kind, model: task.model, turnLimit: task.turnLimit, input });
    events.publish({ type: 'run', run });

    let exit: AgentExit;
    try {
      exit = await agent.run(
        {
          cwd: project.repoPath,
          prompt: input,
          model: task.model,
          maxTurns: task.turnLimit,
          allowedCommands: project.allowedCommands,
          sessionId: session.id,
          resume: session.resume,
          timeoutMs: this._options.runTimeoutMs,
        },
        (event) => this._onAgentEvent(task.id, run.id, event),
        signal,
      );
    } catch (err) {
      exit = { kind: 'crashed', error: errorText(err) };
    }
    const finished = this._finishRun(task.id, run.id, exit);
    return { ...finished, sessionId: finished.sessionId ?? session.id };
  }

  private _onAgentEvent(taskId: number, runId: number, event: AgentEvent): void {
    try {
      if (event.type === 'spawned') this._deps.runs.setPid(runId, event.pid);
      else if (event.type === 'session') this._deps.runs.setSessionId(runId, event.sessionId);
      else if (event.type === 'log') this._appendLog(taskId, runId, event.line);
    } catch (err) {
      // A bad write must not kill the stream; the run still finishes and reaches review.
      this._deps.log.error(`Could not record agent event for run ${runId}`, err);
    }
  }

  /** Records how the run ended and decides where the task goes; it does not move the task. */
  private _finishRun(taskId: number, runId: number, exit: AgentExit): Omit<RunSummary, 'sessionId'> & { sessionId: string | null } {
    const { runs, events } = this._deps;
    const end = toRunEnd(exit);
    if (end.error) this._appendLog(taskId, runId, { kind: 'error', text: end.error });

    let event: TaskEvent = 'submit';
    if (exit.kind === 'result' && end.outcome === 'completed') {
      const review = extractReviewJson(exit.result.text);
      if (!review.ok) this._appendLog(taskId, runId, { kind: 'error', text: review.error });
      else {
        runs.setReview(runId, review.review);
        if (review.review.outcome === 'needs_input') {
          this._appendLog(taskId, runId, { kind: 'system', text: `Question: ${review.review.question}` });
          event = 'askInput';
        }
      }
    }
    const finished = runs.finish(runId, end);
    events.publish({ type: 'run', run: finished });
    return { runId, outcome: end.outcome, event, sessionId: finished.sessionId };
  }

  private async _runChecks(project: Project, taskId: number, runId: number, signal: AbortSignal): Promise<CheckResult[]> {
    const { adapters, checks, runs, events } = this._deps;
    if (project.checkCommands.length === 0) return [];
    this._appendLog(taskId, runId, { kind: 'system', text: `Running ${project.checkCommands.length} checks` });

    let results: CheckResult[];
    try {
      results = await adapters[project.type].check(project, signal);
    } catch (err) {
      results = [{ command: 'checks', exitCode: null, passed: false, timedOut: false, durationMs: 0, output: errorText(err) }];
    }
    checks.save(runId, results);
    const run = runs.get(runId);
    if (run) events.publish({ type: 'run', run });

    const failed = results.filter((r) => !r.passed).map((r) => r.command);
    const summary = `Checks: ${results.length - failed.length} passed, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`;
    this._appendLog(taskId, runId, { kind: failed.length ? 'error' : 'system', text: summary });
    return results;
  }

  private async _takeScreenshots(project: Project, taskId: number, runId: number, signal: AbortSignal): Promise<void> {
    const { tasks, runs, adapters, screenshots, log } = this._deps;
    const task = tasks.get(taskId);
    if (!task?.visual || signal.aborted) return;
    const picked = pickScreenshotRoutes(task, runs.listByTask(taskId));
    if (picked.dropped.length > 0) {
      this._appendLog(taskId, runId, { kind: 'error', text: `Ignored routes from the agent: ${picked.dropped.join(', ')}` });
    }
    if (picked.source === 'none') {
      this._appendLog(taskId, runId, { kind: 'system', text: 'No screenshots: the task lists no routes and the agent named none' });
      return;
    }
    const { routes } = picked;
    const count = routes.length * project.screenshotSizes.length;
    const from = picked.source === 'agent' ? ` of the pages the agent named (${routes.join(', ')})` : '';
    this._appendLog(taskId, runId, { kind: 'system', text: `Taking ${count} screenshots${from}` });

    let shots: readonly Shot[];
    try {
      shots = await adapters[project.type].screenshots(project, { taskId, runId, routes }, signal);
    } catch (err) {
      // Adapters report problems as shots; a throw here is a bug, so log it and still reach review.
      log.error(`Screenshots for task ${taskId} failed`, err);
      shots = [];
    }
    if (shots.length === 0) {
      this._appendLog(taskId, runId, { kind: 'error', text: 'No screenshots: this project type cannot take them' });
      return;
    }
    screenshots.save(runId, shots);
    const failed = shots.filter((s) => s.file === null);
    const detail = failed.length ? `, ${failed.length} failed: ${failed[0]?.error ?? ''}` : '';
    this._appendLog(taskId, runId, { kind: failed.length ? 'error' : 'system', text: `Screenshots: ${shots.length - failed.length} taken${detail}` });
  }

  // A cancel may have moved the task meanwhile; only an in-progress task moves on from here.
  private _settle(project: Project, taskId: number, event: TaskEvent): void {
    const current = this._deps.tasks.get(taskId);
    if (current?.status !== 'in_progress') return;
    const moved = this._move(current, event);
    const title = moved.status === 'needs_input' ? `Task #${moved.id} needs your answer` : `Task #${moved.id} is ready for review`;
    this._deps.notifier.notify(title, `${moved.title} · ${project.name}`);
  }

  // Invariant 1: agents never write to git. The deny-list is not airtight, so check what actually happened.
  private async _guard(project: Project, taskId: number, runId: number): Promise<void> {
    const { snapshots, git, tasks } = this._deps;
    const snapshot = snapshots.get(taskId);
    if (!snapshot) return;
    let problems: readonly string[];
    try {
      problems = (await git.guardCheck(project.repoPath, snapshot)).problems;
    } catch (err) {
      problems = [`Could not check git after the run: ${errorText(err)}`];
    }
    const task = tasks.get(taskId);
    if (problems.length > 0) {
      for (const problem of problems) this._appendLog(taskId, runId, { kind: 'error', text: `Git guard: ${problem}` });
      tasks.setGitIssue(taskId, { kind: 'guard_tripped', detail: problems.join('; '), pendingPush: null });
    } else if (task?.gitIssue === 'guard_tripped') {
      tasks.setGitIssue(taskId, null);
    }
  }

  private _setBlocked(projectId: number, reason: string | null): void {
    if ((this._blocked.get(projectId) ?? null) === reason) return;
    if (reason === null) this._blocked.delete(projectId);
    else this._blocked.set(projectId, reason);
    this._deps.events.publish({ type: 'projectStatus', projectId, blocked: reason });
  }

  private _appendLog(taskId: number, runId: number, line: NewLogLine): void {
    this._deps.events.publish({ type: 'log', taskId, lines: this._deps.runs.appendLog(runId, [line]) });
  }

  private _move(task: Task, event: TaskEvent): Task {
    const updated = this._deps.tasks.applyStatusChange(transition(task, event));
    this._deps.events.publish({ type: 'task', task: updated });
    return updated;
  }
}
