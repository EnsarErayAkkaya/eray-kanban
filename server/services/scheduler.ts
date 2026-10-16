import type { Project } from '@shared/project';
import type { RunKind } from '@shared/run';
import type { Task } from '@shared/task';
import { type TaskEvent, transition } from '../domain/taskMachine';
import type {
  AgentEvent,
  AgentExit,
  AgentPort,
  BoardEventSink,
  Logger,
  NewLogLine,
  ProjectRepo,
  RunEnd,
  RunRepo,
  TaskRepo,
} from './ports';
import { extractReviewJson } from './reviewJson';
import { renderTaskPrompt } from './taskPrompt';

export interface SchedulerOptions {
  readonly promptTemplate: string;
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
export class Scheduler {
  private readonly _workers = new Map<number, Promise<void>>();
  private readonly _controllers = new Map<number, AbortController>();

  constructor(
    private readonly _projects: ProjectRepo,
    private readonly _tasks: TaskRepo,
    private readonly _runs: RunRepo,
    private readonly _agent: AgentPort,
    private readonly _events: BoardEventSink,
    private readonly _log: Logger,
    private readonly _options: SchedulerOptions,
  ) {}

  /** Starts the project's next Todo task if the project is idle; resolves when that run has ended. */
  kick(projectId: number): Promise<void> {
    const running = this._workers.get(projectId);
    if (running) return running;
    const worker = this._work(projectId)
      .catch((err: unknown) => this._log.error(`Worker for project ${projectId} failed`, err))
      .finally(() => this._workers.delete(projectId));
    this._workers.set(projectId, worker);
    return worker;
  }

  async kickAll(): Promise<void> {
    await Promise.all(this._projects.list().map((p) => this.kick(p.id)));
  }

  /** Kill switch: the run ends as stopped and the task goes to review with what it has. */
  stop(taskId: number): boolean {
    const controller = this._controllers.get(taskId);
    controller?.abort();
    return controller !== undefined;
  }

  /** After a crash or restart: kill leftover agents and send their tasks to review. */
  recoverInterrupted(): void {
    for (const run of this._runs.listRunning()) {
      if (run.pid !== null && run.sessionId !== null && this._agent.killOrphan(run.pid, run.sessionId)) {
        this._log.info(`Killed leftover agent pid ${run.pid}`);
      }
      this._events.publish({
        type: 'run',
        run: this._runs.finish(run.id, { outcome: 'failed', usage: null, error: 'Server stopped during the run' }),
      });
      const task = this._tasks.get(run.taskId);
      if (task?.status === 'in_progress') this._move(task, 'submit');
    }
  }

  private async _work(projectId: number): Promise<void> {
    const project = this._projects.get(projectId);
    if (!project || this._tasks.activeTask(projectId)) return;
    const next = this._tasks.nextTodo(projectId);
    if (!next) return;

    const task = this._move(next, 'start');
    const prompt = renderTaskPrompt(this._options.promptTemplate, task);
    await this._runAgent(project, task, 'initial', prompt, { id: this._options.newSessionId(), resume: false });
  }

  private async _runAgent(project: Project, task: Task, kind: RunKind, input: string, session: Session): Promise<void> {
    const run = this._runs.start({
      taskId: task.id,
      sessionId: session.id,
      kind,
      model: task.model,
      turnLimit: task.turnLimit,
      input,
    });
    this._events.publish({ type: 'run', run });

    const controller = new AbortController();
    this._controllers.set(task.id, controller);
    let exit: AgentExit;
    try {
      exit = await this._agent.run(
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
    this._finishRun(task.id, run.id, exit);
  }

  private _onAgentEvent(taskId: number, runId: number, event: AgentEvent): void {
    try {
      if (event.type === 'spawned') this._runs.setPid(runId, event.pid);
      else if (event.type === 'session') this._runs.setSessionId(runId, event.sessionId);
      else if (event.type === 'log') this._appendLog(taskId, runId, event.line);
    } catch (err) {
      // A bad write must not kill the stream; the run still finishes and reaches review.
      this._log.error(`Could not record agent event for run ${runId}`, err);
    }
  }

  private _finishRun(taskId: number, runId: number, exit: AgentExit): void {
    const end = toRunEnd(exit);
    if (end.error) this._appendLog(taskId, runId, { kind: 'error', text: end.error });
    this._events.publish({ type: 'run', run: this._runs.finish(runId, end) });

    let event: TaskEvent = 'submit';
    if (exit.kind === 'result' && end.outcome === 'completed') {
      const review = extractReviewJson(exit.result.text);
      if (!review.ok) this._appendLog(taskId, runId, { kind: 'error', text: review.error });
      else if (review.review.outcome === 'needs_input') {
        this._appendLog(taskId, runId, { kind: 'system', text: `Question: ${review.review.question}` });
        event = 'askInput';
      }
    }
    // A cancel may have moved the task while the agent ran; only an in-progress task moves on from here.
    const current = this._tasks.get(taskId);
    if (current?.status === 'in_progress') this._move(current, event);
  }

  private _appendLog(taskId: number, runId: number, line: NewLogLine): void {
    this._events.publish({ type: 'log', taskId, lines: this._runs.appendLog(runId, [line]) });
  }

  private _move(task: Task, event: TaskEvent): Task {
    const updated = this._tasks.applyStatusChange(transition(task, event));
    this._events.publish({ type: 'task', task: updated });
    return updated;
  }
}
