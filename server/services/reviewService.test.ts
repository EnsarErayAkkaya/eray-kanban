import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@shared/events';
import type { Task } from '@shared/task';
import { ConflictError, NotFoundError } from '../domain/errors';
import { transition } from '../domain/taskMachine';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from '../infra/sqlite/testDb';
import { ReviewService } from './reviewService';
import { FakeScheduler } from './testFakes';

describe('ReviewService.reject', () => {
  let tasks: SqliteTaskRepo;
  let runs: SqliteRunRepo;
  let scheduler: FakeScheduler;
  let events: BoardEvent[];
  let service: ReviewService;
  let projectId: number;

  const inReview = (): Task => {
    let task = tasks.create(newTask(projectId));
    for (const e of ['promote', 'start'] as const) task = tasks.applyStatusChange(transition(task, e));
    runs.start({ taskId: task.id, sessionId: 'sess-1', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' });
    return tasks.applyStatusChange(transition(task, 'submit'));
  };

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    tasks = new SqliteTaskRepo(db, clock);
    runs = new SqliteRunRepo(db, clock);
    projectId = seedProject(db, clock).id;
    scheduler = new FakeScheduler();
    events = [];
    service = new ReviewService(tasks, runs, scheduler, { publish: (e) => events.push(e) });
  });

  it('moves the task back to In Progress and resumes with the feedback', () => {
    const task = inReview();
    expect(service.reject(task.id, 'Use a toggle').status).toBe('in_progress');
    expect(scheduler.resumed).toEqual([[task.id, 'Use a toggle']]);
    expect(events).toEqual([{ type: 'task', task: tasks.get(task.id) }]);
  });

  it('refuses a task that is not in review', () => {
    const task = tasks.create(newTask(projectId));
    expect(() => service.reject(task.id, 'x')).toThrow(ConflictError);
    expect(() => service.reject(999, 'x')).toThrow(NotFoundError);
    expect(scheduler.resumed).toEqual([]);
  });

  it('refuses a task with no session to resume, before moving it', () => {
    let task = tasks.create(newTask(projectId));
    for (const e of ['promote', 'start', 'submit'] as const) task = tasks.applyStatusChange(transition(task, e));
    expect(() => service.reject(task.id, 'x')).toThrow('This task has no agent session to resume');
    expect(tasks.get(task.id)?.status).toBe('in_review');
  });
});
