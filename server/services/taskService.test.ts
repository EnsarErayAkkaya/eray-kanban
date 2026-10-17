import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@shared/events';
import type { Project } from '@shared/project';
import { CreateTaskInput, type Task } from '@shared/task';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { IllegalTransitionError, transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteSnapshotRepo } from '../infra/sqlite/sqliteSnapshotRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, seedProject } from '../infra/sqlite/testDb';
import { TaskService } from './taskService';
import { FakeScheduler, SNAPSHOT } from './testFakes';

describe('TaskService', () => {
  let tasks: SqliteTaskRepo;
  let runs: SqliteRunRepo;
  let snapshots: SqliteSnapshotRepo;
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
    snapshots = new SqliteSnapshotRepo(db, clock);
    service = new TaskService(projects, tasks, runs, snapshots, scheduler, { publish: (e) => events.push(e) });
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

    it.each(['start', 'submit', 'reject', 'askInput', 'answer', 'accept', 'cancel', 'reopen'] as const)(
      'refuses %s, which has its own path',
      (event) => {
        expect(() => service.applyBoardEvent(create().id, event)).toThrow(ConflictError);
      },
    );

    it('lets the state machine reject an illegal move', () => {
      expect(() => service.applyBoardEvent(create().id, 'demote')).toThrow(IllegalTransitionError);
    });
  });

  describe('reopen', () => {
    it('moves a cancelled task back to Backlog with its edits and publishes it', () => {
      const task = force(create(), 'cancel');
      const reopened = service.reopen(task.id, { title: 'Second try', priority: 'high' });
      expect(reopened).toMatchObject({ status: 'backlog', title: 'Second try', priority: 'high' });
      expect(events.at(-1)).toEqual({ type: 'task', task: reopened });
    });

    it('drops the snapshot of the cancelled attempt so the next pickup takes a fresh one', () => {
      const task = force(create(), 'promote', 'start');
      snapshots.save(task.id, SNAPSHOT);
      force(task, 'cancel');
      service.reopen(task.id, {});
      expect(snapshots.get(task.id)).toBeUndefined();
      expect(() => snapshots.save(task.id, { ...SNAPSHOT, head: 'def456' })).not.toThrow();
    });

    it('keeps the runs of the cancelled attempt', () => {
      const task = create();
      runs.start({ taskId: task.id, sessionId: 's', kind: 'initial', model: 'opus', turnLimit: 12, input: 'x' });
      service.reopen(force(task, 'cancel').id, {});
      expect(service.runs(task.id)).toHaveLength(1);
    });

    it.each(['backlog', 'todo', 'in_progress', 'done'] as const)('refuses a task in %s', (status) => {
      const steps = { backlog: [], todo: ['promote'], in_progress: ['promote', 'start'], done: ['promote', 'start', 'submit', 'accept'] } as const;
      const task = force(create(), ...steps[status]);
      expect(() => service.reopen(task.id, {})).toThrow(IllegalTransitionError);
    });

    it('checks the new dependency before moving anything', () => {
      const task = force(create(), 'cancel');
      expect(() => service.reopen(task.id, { dependsOn: task.id })).toThrow(ValidationError);
      expect(tasks.get(task.id)?.status).toBe('cancelled');
    });
  });

  describe('delete', () => {
    it.each([
      ['backlog', []],
      ['cancelled', ['cancel']],
    ] as const)('deletes a %s task and publishes the removal', (_status, steps) => {
      const task = force(create(), ...steps);
      service.delete(task.id);
      expect(tasks.get(task.id)).toBeUndefined();
      expect(service.list()).toEqual([]);
      expect(events.at(-1)).toEqual({ type: 'taskDeleted', taskId: task.id });
    });

    it.each([
      ['todo', ['promote']],
      ['in_progress', ['promote', 'start']],
      ['in_review', ['promote', 'start', 'submit']],
      ['done', ['promote', 'start', 'submit', 'accept']],
    ] as const)('refuses a task in %s', (_status, steps) => {
      const task = force(create(), ...steps);
      expect(() => service.delete(task.id)).toThrow(ConflictError);
      expect(tasks.get(task.id)).toBeDefined();
    });

    it('frees its dependents and wakes the project when one is waiting in Todo', () => {
      const dep = create();
      const waiting = force(create({ dependsOn: dep.id }), 'promote');
      service.delete(dep.id);
      expect(tasks.get(waiting.id)?.dependsOn).toBeNull();
      expect(events).toContainEqual({ type: 'task', task: tasks.get(waiting.id) });
      expect(scheduler.kicked).toEqual([project.id]);
    });

    it('keeps the runs so the cost totals still count them', () => {
      const task = create();
      const run = runs.start({ taskId: task.id, sessionId: 's', kind: 'initial', model: 'opus', turnLimit: 12, input: 'x' });
      service.delete(force(task, 'cancel').id);
      expect(runs.get(run.id)).toBeDefined();
      expect(runs.usageByProject()).toEqual([expect.objectContaining({ projectId: project.id, runs: 1 })]);
    });

    it('refuses an unknown or already deleted task', () => {
      const task = create();
      service.delete(task.id);
      expect(() => service.delete(task.id)).toThrow(NotFoundError);
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
