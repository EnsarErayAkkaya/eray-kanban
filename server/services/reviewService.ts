import type { Task } from '@shared/task';
import { ConflictError, NotFoundError } from '../domain/errors';
import { transition } from '../domain/taskMachine';
import type { BoardEventSink, RunRepo, TaskRepo, WorkScheduler } from './ports';

// Review actions on a task. Accept and cancel with rollback join reject here next.
export class ReviewService {
  constructor(
    private readonly _tasks: TaskRepo,
    private readonly _runs: RunRepo,
    private readonly _scheduler: WorkScheduler,
    private readonly _events: BoardEventSink,
  ) {}

  /** The same session resumes with the feedback, so the agent keeps its context. */
  reject(taskId: number, feedback: string): Task {
    const task = this._tasks.get(taskId);
    if (!task) throw new NotFoundError('task', taskId);
    if (task.status !== 'in_review') throw new ConflictError('Only a task in review can be rejected');
    if (!this._runs.listByTask(taskId).some((r) => r.sessionId !== null)) {
      throw new ConflictError('This task has no agent session to resume');
    }

    const updated = this._tasks.applyStatusChange(transition(task, 'reject'));
    this._events.publish({ type: 'task', task: updated });
    void this._scheduler.resumeWithFeedback(taskId, feedback);
    return updated;
  }
}
