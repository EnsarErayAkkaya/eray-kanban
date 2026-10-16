import type { ProjectStatus } from '@shared/events';
import type { Project } from '@shared/project';
import type { RunKind } from '@shared/run';
import type { Task } from '@shared/task';
import { StaleStatusError } from '../domain/errors';
import { type TaskEvent, transition } from '../domain/taskMachine';
import type {
  AgentEvent,
  AgentExit,
  AgentPort,
  BoardEventSink,
  GitPort,
  Logger,
  NewLogLine,
  ProjectRepo,
  RunEnd,
  RunRepo,
  SnapshotRepo,
  TaskRepo,
  WorkScheduler,
} from './ports';
import { extractReviewJson } from './reviewJson';
import { renderFeedbackPrompt, renderTaskPrompt } from './taskPrompt';

export interface SchedulerDeps {
  readonly projects: ProjectRepo;
  readonly tasks: TaskRepo;
  readonly runs: RunRepo;
  readonly snapshots: SnapshotRepo;
  readonly agent: AgentPort;
  readonly git: GitPort;
  readonly events: BoardEventSink;
  readonly log: Logger;
}

export interface SchedulerOptions {
  readonly taskTemplate: string;
  readonly feedbackTemplate: string;
  readonly runTimeoutMs: number;
  readonly newSessionId: () => string;
}

interface Session {
  readonly id: string;
  readonly resume: boolean;
}

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

  async stopAndWait(taskId: number): Promise<void> {
    const task = this._deps.tasks.get(taskId);
    if (!task) return;
    this.stop(taskId);
    await this._workers.get(task.projectId);
  }

  /** Resumes the task's last session with review feedback; the task must already be back in progress. */
  resumeWithFeedback(taskId: number, feedback: string): Promise<void> {
    const task = this._deps.tasks.get(taskId);
    if (!task) return Promise.resolve();
    // A kick that found the project occupied ends at once; queue behind it instead of being dropped.
    const running = this._workers.get(task.projectId);
    if (running) return running.then(() => this.resumeWithFeedback(taskId, feedback));
    return this._exclusive(task.projectId, () => this._resume(task.id, feedback));
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
    const next = tasks.activeTask(projectId) ? undefined : tasks.nextTodo(projectId);
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

    // The task may have been cancelled or moved back while the repo was being checked.
    const current = tasks.get(next.id);
    if (current?.status !== 'todo') return;
    let task: Task;
    try {
      task = this._move(current, 'start');
    } catch (err) {
      if (err instanceof StaleStatusError) return;
      throw err;
    }
    snapshots.save(task.id, result.snapshot);
    const prompt = renderTaskPrompt(this._options.taskTemplate, task);
    await this._runAgent(project, task, 'initial', prompt, { id: this._options.newSessionId(), resume: false });
  }

  private async _resume(taskId: number, feedback: string): Promise<void> {
    const { tasks, projects, runs, log } = this._deps;
    const task = tasks.get(taskId);
    const project = task && projects.get(task.projectId);
    if (!task || !project || task.status !== 'in_progress') return;

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
    const prompt = renderFeedbackPrompt(this._options.feedbackTemplate, task, feedback);
    await this._runAgent(project, task, 'feedback', prompt, { id: sessionId, resume: true });
  }

  private async _runAgent(project: Project, task: Task, kind: RunKind, input: string, session: Session): Promise<void> {
    const { runs, agent, events } = this._deps;
    const run = runs.start({ taskId: task.id, sessionId: session.id, kind, model: task.model, turnLimit: task.turnLimit, input });
    events.publish({ type: 'run', run });

    const controller = new AbortController();
    this._controllers.set(task.id, controller);
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
        controller.signal,
      );
    } catch (err) {
      exit = { kind: 'crashed', error: errorText(err) };
    } finally {
      this._controllers.delete(task.id);
    }
    await this._finishRun(project, task.id, run.id, exit);
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

  private async _finishRun(project: Project, taskId: number, runId: number, exit: AgentExit): Promise<void> {
    const { runs, tasks, events } = this._deps;
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
    events.publish({ type: 'run', run: runs.finish(runId, end) });

    await this._guard(project, taskId, runId);
    // A cancel may have moved the task while the agent ran; only an in-progress task moves on from here.
    const current = tasks.get(taskId);
    if (current?.status === 'in_progress') this._move(current, event);
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
