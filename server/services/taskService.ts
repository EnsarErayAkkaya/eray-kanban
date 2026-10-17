import type { Run, RunLogLine } from '@shared/run';
import type { CreateTask, Task, TaskPatch } from '@shared/task';
import type { TaskEvent } from '@shared/taskStatus';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { transition } from '../domain/taskMachine';
import type { BoardEventSink, ProjectRepo, RunRepo, SnapshotRepo, TaskRepo, WorkScheduler } from './ports';

// The drag moves. Accept, reject and cancel go through ReviewService; the rest come from the scheduler.
const BOARD_EVENTS: ReadonlySet<TaskEvent> = new Set(['promote', 'demote']);
const EDITABLE: ReadonlySet<Task['status']> = new Set(['backlog', 'todo']);
// No agent work is attached: a cancel already rolled the repo back.
const DELETABLE: ReadonlySet<Task['status']> = new Set(['backlog', 'cancelled']);

export class TaskService {
  constructor(
    private readonly _projects: ProjectRepo,
    private readonly _tasks: TaskRepo,
    private readonly _runs: RunRepo,
    private readonly _snapshots: SnapshotRepo,
    private readonly _scheduler: WorkScheduler,
    private readonly _events: BoardEventSink,
  ) {}

  list(projectId?: number): Task[] {
    return this._tasks.list(projectId === undefined ? {} : { projectId });
  }

  create(input: CreateTask): Task {
    const project = this._projects.get(input.projectId);
    if (!project) throw new NotFoundError('project', input.projectId);
    this._checkDependency(input.projectId, input.dependsOn ?? null);

    const task = this._tasks.create({
      ...input,
      model: input.model ?? project.defaultModel,
      turnLimit: input.turnLimit ?? project.defaultTurnLimit,
    });
    this._events.publish({ type: 'task', task });
    return task;
  }

  update(id: number, patch: TaskPatch): Task {
    const task = this._require(id);
    if (!EDITABLE.has(task.status)) throw new ConflictError('Only Backlog and Todo tasks can be edited');
    if (patch.dependsOn !== undefined) this._checkDependency(task.projectId, patch.dependsOn, id);

    const updated = this._tasks.update(id, patch);
    this._events.publish({ type: 'task', task: updated });
    return updated;
  }

  /** Back to Backlog with your edits; the next pickup takes a fresh snapshot (invariant 4). */
  reopen(id: number, patch: TaskPatch): Task {
    const task = this._require(id);
    if (patch.dependsOn !== undefined) this._checkDependency(task.projectId, patch.dependsOn, id);
    const reopened = this._tasks.applyStatusChange(transition(task, 'reopen'));
    this._snapshots.delete(id);
    const updated = Object.keys(patch).length > 0 ? this._tasks.update(id, patch) : reopened;
    this._events.publish({ type: 'task', task: updated });
    return updated;
  }

  delete(id: number): void {
    const task = this._require(id);
    if (!DELETABLE.has(task.status)) throw new ConflictError('Only Backlog and Cancelled tasks can be deleted');
    const freed = this._tasks.delete(id);
    this._events.publish({ type: 'taskDeleted', taskId: id });
    for (const dependent of freed) this._events.publish({ type: 'task', task: dependent });
    if (freed.some((t) => t.status === 'todo')) void this._scheduler.kick(task.projectId);
  }

  applyBoardEvent(id: number, event: TaskEvent): Task {
    if (!BOARD_EVENTS.has(event)) throw new ConflictError(`${event} is not a board action`);
    const updated = this._tasks.applyStatusChange(transition(this._require(id), event));
    this._events.publish({ type: 'task', task: updated });
    if (event === 'promote') void this._scheduler.kick(updated.projectId);
    // kick() may already have started the task, so answer with what is stored now.
    return this._tasks.get(id) ?? updated;
  }

  stop(id: number): void {
    this._require(id);
    if (!this._scheduler.stop(id)) throw new ConflictError('This task has no running agent');
  }

  runs(taskId: number): Run[] {
    this._require(taskId);
    return this._runs.listByTask(taskId);
  }

  log(runId: number, afterSeq: number): RunLogLine[] {
    if (!this._runs.get(runId)) throw new NotFoundError('run', runId);
    return this._runs.logAfter(runId, afterSeq);
  }

  private _require(id: number): Task {
    const task = this._tasks.get(id);
    if (!task) throw new NotFoundError('task', id);
    return task;
  }

  private _checkDependency(projectId: number, dependsOn: number | null, selfId?: number): void {
    if (dependsOn === null) return;
    if (dependsOn === selfId) throw new ValidationError('A task cannot depend on itself');
    const dep = this._tasks.get(dependsOn);
    if (!dep || dep.projectId !== projectId) throw new ValidationError('Dependency must be a task in the same project');
  }
}
