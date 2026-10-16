import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@shared/events';
import type { Project } from '@shared/project';
import { CreateTaskInput, type Task } from '@shared/task';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { IllegalTransitionError, transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, seedProject } from '../infra/sqlite/testDb';
import type { WorkScheduler } from './ports';
import { TaskService } from './taskService';

class FakeScheduler implements WorkScheduler {
  readonly kicked: number[] = [];
  readonly stopped: number[] = [];
  running = false;
  kick(projectId: number): Promise<void> {
    this.kicked.push(projectId);
    return Promise.resolve();
  }
  stop(taskId: number): boolean {
    this.stopped.push(taskId);
    return this.running;
  }
}

describe('TaskService', () => {
  let tasks: SqliteTaskRepo;
  let runs: SqliteRunRepo;
  let project: Project;
  let other: Project;
  let scheduler: FakeScheduler;
  let events: BoardEvent[];
  let service: TaskService;

  const create = (input: Record<string, unknown> = {}, projectId = project.id) =>
    service.create(CreateTaskInput.parse({ projectId, title: 'Add settings page', ...input }));
  const force = (task: Task, ...steps: Parameters<typeof transition>[1][]) =>
    steps.reduce((t, e) => tasks.applyStatusChange(transition(t, e)), task);

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    const projects = new SqliteProjectRepo(db, clock);
    tasks = new SqliteTaskRepo(db, clock);
    runs = new SqliteRunRepo(db, clock);
    project = projects.update(seedProject(db, clock).id, { defaultModel: 'opus', defaultTurnLimit: 12 });
    other = seedProject(db, clock, 'api');
    scheduler = new FakeScheduler();
    events = [];
    service = new TaskService(projects, tasks, runs, scheduler, { publish: (e) => events.push(e) });
  });

  describe('create', () => {
    it('fills model and turn limit from the project and publishes the task', () => {
      const task = create();
      expect(task).toMatchObject({ status: 'backlog', model: 'opus', turnLimit: 12 });
      expect(events).toEqual([{ type: 'task', task }]);
    });

    it('keeps an explicit model and turn limit', () => {
      expect(create({ model: 'haiku', turnLimit: 5 })).toMatchObject({ model: 'haiku', turnLimit: 5 });
    });

    it('rejects an unknown project', () => {
      expect(() => create({}, 999)).toThrow(NotFoundError);
    });

    it('requires a dependency in the same project', () => {
      const foreign = create({}, other.id);
      expect(() => create({ dependsOn: foreign.id })).toThrow(ValidationError);
      expect(create({ dependsOn: create().id }).dependsOn).not.toBeNull();
    });
  });

  describe('update', () => {
    it('edits a backlog task', () => {
      const task = create();
      expect(service.update(task.id, { title: 'Renamed' }).title).toBe('Renamed');
    });

    it('refuses to edit a started task', () => {
      const task = force(create(), 'promote', 'start');
      expect(() => service.update(task.id, { title: 'x' })).toThrow(ConflictError);
    });

    it('refuses a self dependency', () => {
      const task = create();
      expect(() => service.update(task.id, { dependsOn: task.id })).toThrow(ValidationError);
    });
  });

  describe('applyBoardEvent', () => {
    it('promotes to Todo and wakes the project worker', () => {
      const task = create();
      expect(service.applyBoardEvent(task.id, 'promote').status).toBe('todo');
      expect(scheduler.kicked).toEqual([project.id]);
    });

    it('answers with the state after the worker started the task', () => {
      const task = create();
      scheduler.kick = (projectId) => {
        const next = tasks.nextTodo(projectId);
        if (next) tasks.applyStatusChange(transition(next, 'start'));
        return Promise.resolve();
      };
      expect(service.applyBoardEvent(task.id, 'promote').status).toBe('in_progress');
    });

    it('demotes back to Backlog without waking anything', () => {
      const task = force(create(), 'promote');
      expect(service.applyBoardEvent(task.id, 'demote').status).toBe('backlog');
      expect(scheduler.kicked).toEqual([]);
    });

    it('cancels a task that has not started', () => {
      expect(service.applyBoardEvent(create().id, 'cancel').status).toBe('cancelled');
    });

    it('refuses to cancel a started task until rollback exists', () => {
      const task = force(create(), 'promote', 'start', 'submit');
      expect(() => service.applyBoardEvent(task.id, 'cancel')).toThrow(ConflictError);
    });

    it('accepts a reviewed task and wakes the project', () => {
      const task = force(create(), 'promote', 'start', 'submit');
      expect(service.applyBoardEvent(task.id, 'accept').status).toBe('done');
      expect(scheduler.kicked).toEqual([project.id]);
    });

    it.each(['start', 'submit', 'reject', 'askInput', 'answer'] as const)('refuses %s from the board', (event) => {
      expect(() => service.applyBoardEvent(create().id, event)).toThrow(ConflictError);
    });

    it('lets the state machine reject an illegal move', () => {
      expect(() => service.applyBoardEvent(create().id, 'accept')).toThrow(IllegalTransitionError);
    });
  });

  describe('stop', () => {
    it('asks the scheduler to stop the run', () => {
      scheduler.running = true;
      const task = create();
      service.stop(task.id);
      expect(scheduler.stopped).toEqual([task.id]);
    });

    it('fails when nothing is running', () => {
      expect(() => service.stop(create().id)).toThrow(ConflictError);
    });
  });

  it('returns runs and log lines', () => {
    const task = create();
    const run = runs.start({ taskId: task.id, sessionId: 's', kind: 'initial', model: 'opus', turnLimit: 12, input: 'x' });
    runs.appendLog(run.id, [{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'world' }]);
    expect(service.runs(task.id).map((r) => r.id)).toEqual([run.id]);
    expect(service.log(run.id, 1).map((l) => l.text)).toEqual(['world']);
    expect(() => service.log(999, 0)).toThrow(NotFoundError);
  });
});
