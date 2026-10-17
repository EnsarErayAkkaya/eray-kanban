import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/task';
import { ConflictError, NotFoundError, ProjectBusyError, StaleStatusError } from '../../domain/errors';
import { type TaskEvent, transition } from '../../domain/taskMachine';
import { SqliteTaskRepo } from './sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from './testDb';

describe('SqliteTaskRepo', () => {
  let db: Database;
  let repo: SqliteTaskRepo;
  let projectId: number;

  const move = (task: Task, ...events: TaskEvent[]): Task =>
    events.reduce((t, e) => repo.applyStatusChange(transition(t, e)), task);

  beforeEach(() => {
    const clock = fakeClock();
    db = memoryDb();
    repo = new SqliteTaskRepo(db, clock);
    projectId = seedProject(db, clock).id;
  });

  it('creates tasks in backlog, each after the last', () => {
    const a = repo.create(newTask(projectId, { title: 'A', routes: ['/settings'] }));
    const b = repo.create(newTask(projectId, { title: 'B' }));
    expect(a).toMatchObject({ projectId, title: 'A', status: 'backlog', routes: ['/settings'], dependsOn: null });
    expect(b.position).toBeGreaterThan(a.position);
    expect(repo.list({ projectId }).map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('filters the list by project', () => {
    const otherId = seedProject(db, fakeClock(), 'api').id;
    repo.create(newTask(projectId, { title: 'mine' }));
    repo.create(newTask(otherId, { title: 'theirs' }));
    expect(repo.list({ projectId: otherId }).map((t) => t.title)).toEqual(['theirs']);
    expect(repo.list()).toHaveLength(2);
  });

  it('rejects an unknown project or dependency', () => {
    expect(() => repo.create(newTask(999))).toThrow(ConflictError);
    expect(() => repo.create(newTask(projectId, { dependsOn: 999 }))).toThrow(ConflictError);
  });

  it('updates only patched fields and never the status', () => {
    const task = repo.create(newTask(projectId));
    const updated = repo.update(task.id, { title: 'Renamed', visual: true });
    expect(updated).toMatchObject({ title: 'Renamed', visual: true, status: 'backlog', model: 'sonnet' });
  });

  it('rejects a task depending on itself', () => {
    const task = repo.create(newTask(projectId));
    expect(() => repo.update(task.id, { dependsOn: task.id })).toThrow(ConflictError);
  });

  describe('applyStatusChange', () => {
    it('stores the status the machine decided', () => {
      const task = move(repo.create(newTask(projectId)), 'promote', 'start');
      expect(task.status).toBe('in_progress');
      expect(repo.get(task.id)?.status).toBe('in_progress');
    });

    it('fails if the task moved on since the change was planned', () => {
      const task = move(repo.create(newTask(projectId)), 'promote');
      const start = transition(task, 'start');
      repo.applyStatusChange(transition(task, 'cancel'));
      expect(() => repo.applyStatusChange(start)).toThrow(StaleStatusError);
      expect(repo.get(task.id)?.status).toBe('cancelled');
    });

    it('enforces one active task per project (invariant 3)', () => {
      move(repo.create(newTask(projectId)), 'promote', 'start', 'submit');
      const second = move(repo.create(newTask(projectId)), 'promote');
      expect(() => repo.applyStatusChange(transition(second, 'start'))).toThrow(ProjectBusyError);
      expect(repo.get(second.id)?.status).toBe('todo');
    });

    it('lets different projects run at the same time', () => {
      const otherId = seedProject(db, fakeClock(), 'api').id;
      move(repo.create(newTask(projectId)), 'promote', 'start');
      expect(move(repo.create(newTask(otherId)), 'promote', 'start').status).toBe('in_progress');
    });

    it('fails for a missing task', () => {
      expect(() => repo.applyStatusChange({ taskId: 999, event: 'promote', from: 'backlog', to: 'todo' })).toThrow(
        NotFoundError,
      );
    });
  });

  describe('nextTodo', () => {
    it('picks by priority, then position, and ignores backlog', () => {
      repo.create(newTask(projectId, { title: 'backlog high', priority: 'high' }));
      move(repo.create(newTask(projectId, { title: 'low', priority: 'low' })), 'promote');
      move(repo.create(newTask(projectId, { title: 'normal 1' })), 'promote');
      move(repo.create(newTask(projectId, { title: 'normal 2' })), 'promote');
      expect(repo.nextTodo(projectId)?.title).toBe('normal 1');
    });

    it('waits until a dependency is done', () => {
      const dep = repo.create(newTask(projectId, { title: 'dep' }));
      move(repo.create(newTask(projectId, { title: 'after dep', priority: 'high', dependsOn: dep.id })), 'promote');
      expect(repo.nextTodo(projectId)).toBeUndefined();

      move(dep, 'promote', 'start', 'submit', 'accept');
      expect(repo.nextTodo(projectId)?.title).toBe('after dep');
    });

    it('returns nothing for an empty project', () => {
      expect(repo.nextTodo(projectId)).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('hides the task from get, list and nextTodo but keeps the row', () => {
      const task = repo.create(newTask(projectId));
      repo.delete(task.id);
      expect(repo.get(task.id)).toBeUndefined();
      expect(repo.list()).toEqual([]);
      expect(repo.nextTodo(projectId)).toBeUndefined();
      expect(db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(task.id)).toEqual({ deleted_at: expect.any(String) });
    });

    it('clears the dependency of the tasks that waited for it and returns them', () => {
      const dep = repo.create(newTask(projectId, { title: 'dep' }));
      const waiting = move(repo.create(newTask(projectId, { title: 'waiting', dependsOn: dep.id })), 'promote');
      const freed = repo.delete(dep.id);
      expect(freed.map((t) => [t.id, t.dependsOn])).toEqual([[waiting.id, null]]);
      expect(repo.nextTodo(projectId)?.id).toBe(waiting.id);
    });

    it('fails for a missing or already deleted task', () => {
      const task = repo.create(newTask(projectId));
      repo.delete(task.id);
      expect(() => repo.delete(task.id)).toThrow(NotFoundError);
      expect(() => repo.delete(999)).toThrow(NotFoundError);
    });
  });

  it('sets and clears a git issue without touching the status', () => {
    const task = repo.create(newTask(projectId));
    expect(task).toMatchObject({ gitIssue: null, gitIssueDetail: null, pendingPush: null, commitSha: null });
    expect(repo.setGitIssue(task.id, { kind: 'push_failed', detail: 'rejected', pendingPush: 'develop' })).toMatchObject({
      status: 'backlog',
      gitIssue: 'push_failed',
      gitIssueDetail: 'rejected',
      pendingPush: 'develop',
    });
    expect(repo.setGitIssue(task.id, null)).toMatchObject({ gitIssue: null, gitIssueDetail: null, pendingPush: null });
    expect(() => repo.setGitIssue(999, null)).toThrow(NotFoundError);
  });

  it('records the commit sha', () => {
    const task = repo.create(newTask(projectId));
    expect(repo.setCommitSha(task.id, 'abc123').commitSha).toBe('abc123');
    expect(() => repo.setCommitSha(999, 'x')).toThrow(NotFoundError);
  });

  it('reports the active task of a project', () => {
    expect(repo.activeTask(projectId)).toBeUndefined();
    const task = move(repo.create(newTask(projectId)), 'promote', 'start', 'askInput');
    expect(repo.activeTask(projectId)?.id).toBe(task.id);
    move(task, 'cancel');
    expect(repo.activeTask(projectId)).toBeUndefined();
  });
});
