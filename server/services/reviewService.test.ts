import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@shared/events';
import type { Project } from '@shared/project';
import type { Task } from '@shared/task';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { IllegalTransitionError, type TaskEvent, transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteSnapshotRepo } from '../infra/sqlite/sqliteSnapshotRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from '../infra/sqlite/testDb';
import { ReviewService } from './reviewService';
import { FakeGit, FakeScheduler, SNAPSHOT } from './testFakes';

// Repos run on in-memory SQLite; git and the scheduler are fakes that record what was asked of them.
describe('ReviewService', () => {
  let projects: SqliteProjectRepo;
  let tasks: SqliteTaskRepo;
  let runs: SqliteRunRepo;
  let snapshots: SqliteSnapshotRepo;
  let git: FakeGit;
  let scheduler: FakeScheduler;
  let events: BoardEvent[];
  let service: ReviewService;
  let project: Project;

  const move = (task: Task, ...steps: TaskEvent[]) =>
    steps.reduce((t, e) => tasks.applyStatusChange(transition(t, e)), task);

  /** A task that ran once from a snapshot and now waits in review. */
  const inReview = (summary = 'Added /settings'): Task => {
    const task = move(tasks.create(newTask(project.id, { title: 'Add settings page' })), 'promote', 'start');
    snapshots.save(task.id, SNAPSHOT);
    const run = runs.start({ taskId: task.id, sessionId: 'sess-1', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' });
    runs.setReview(run.id, { outcome: 'done', summary, notes: [], concerns: [] });
    return move(task, 'submit');
  };

  beforeEach(() => {
    const clock = fakeClock();
    const db = memoryDb();
    projects = new SqliteProjectRepo(db, clock);
    tasks = new SqliteTaskRepo(db, clock);
    runs = new SqliteRunRepo(db, clock);
    snapshots = new SqliteSnapshotRepo(db, clock);
    project = seedProject(db, clock);
    git = new FakeGit();
    scheduler = new FakeScheduler();
    events = [];
    service = new ReviewService({ projects, tasks, runs, snapshots, git, scheduler, events: { publish: (e) => events.push(e) } });
  });

  describe('reject', () => {
    it('moves the task back to In Progress and resumes with the feedback', () => {
      const task = inReview();
      expect(service.reject(task.id, 'Use a toggle').status).toBe('in_progress');
      expect(scheduler.resumed).toEqual([[task.id, 'Use a toggle']]);
    });

    it('refuses a task that is not in review, or one with no session', () => {
      expect(() => service.reject(tasks.create(newTask(project.id)).id, 'x')).toThrow(ConflictError);
      expect(() => service.reject(999, 'x')).toThrow(NotFoundError);
      const noSession = move(tasks.create(newTask(project.id)), 'promote', 'start', 'submit');
      expect(() => service.reject(noSession.id, 'x')).toThrow('This task has no agent session to resume');
      expect(tasks.get(noSession.id)?.status).toBe('in_review');
    });
  });

  describe('accept', () => {
    it('commits with the project format and the agent summary, then moves to Done', async () => {
      const task = inReview();
      const done = await service.accept(task.id, { commit: true, followup: 'none' });

      expect(git.calls).toEqual([`commit feat(#${task.id}): Add settings page\n\nAdded /settings\n`]);
      expect(done).toMatchObject({ status: 'done', commitSha: 'c0ffee', gitIssue: null });
      expect(scheduler.kicked).toEqual([project.id]);
    });

    it('uses the project defaults for anything not given', async () => {
      projects.update(project.id, { acceptCommit: true, acceptFollowup: 'push' });
      await service.accept(inReview().id, {});
      expect(git.calls.slice(1)).toEqual(['push develop']);
    });

    it('accepts without a commit and leaves git alone', async () => {
      const done = await service.accept(inReview().id, { commit: false });
      expect(git.calls).toEqual([]);
      expect(done).toMatchObject({ status: 'done', commitSha: null });
    });

    it('records no sha when there was nothing left to commit', async () => {
      git.commitResult = { ok: true, sha: null, files: [] };
      expect((await service.accept(inReview().id, { commit: true })).commitSha).toBeNull();
    });

    it('keeps the task in review when the commit fails', async () => {
      git.commitResult = { ok: false, error: 'lint failed' };
      const task = inReview();
      await expect(service.accept(task.id, { commit: true, followup: 'push' })).rejects.toThrow('Commit failed: lint failed');
      expect(tasks.get(task.id)?.status).toBe('in_review');
      expect(git.calls.some((c) => c.startsWith('push'))).toBe(false);
    });

    it('leaves a Retry push badge when the push fails', async () => {
      git.pushResult = { ok: false, error: '! [rejected] develop (fetch first)' };
      const done = await service.accept(inReview().id, { commit: true, followup: 'push' });
      expect(done).toMatchObject({
        status: 'done',
        gitIssue: 'push_failed',
        gitIssueDetail: '! [rejected] develop (fetch first)',
        pendingPush: 'develop',
      });
    });

    it('merges into the target and pushes it when asked', async () => {
      projects.update(project.id, { mergeTarget: 'main' });
      const done = await service.accept(inReview().id, { commit: true, followup: 'merge', pushAfterMerge: true });
      expect(git.calls.slice(1)).toEqual(['merge develop into main and push']);
      expect(done.gitIssue).toBeNull();
    });

    it('flags a merge conflict and keeps the task Done (invariant 7)', async () => {
      projects.update(project.id, { mergeTarget: 'main' });
      git.mergeResult = { ok: false, conflict: true, files: ['src/app.ts'], error: 'CONFLICT' };
      const done = await service.accept(inReview().id, { commit: true, followup: 'merge' });
      expect(done).toMatchObject({ status: 'done', gitIssue: 'merge_conflict', gitIssueDetail: 'Conflicts in src/app.ts' });
    });

    it('flags a failed push of the merge target for retry', async () => {
      projects.update(project.id, { mergeTarget: 'main' });
      git.mergeResult = { ok: true, sha: 'm1', pushed: false, pushError: 'auth failed' };
      const done = await service.accept(inReview().id, { commit: true, followup: 'merge', pushAfterMerge: true });
      expect(done).toMatchObject({ gitIssue: 'push_failed', pendingPush: 'main' });
    });

    it('checks the merge target before committing anything', async () => {
      const task = inReview();
      await expect(service.accept(task.id, { commit: true, followup: 'merge' })).rejects.toThrow(
        'Set a merge target in the project settings first',
      );
      projects.update(project.id, { mergeTarget: 'release' });
      await expect(service.accept(task.id, { commit: true, followup: 'merge' })).rejects.toThrow(
        'There is no local branch release',
      );
      expect(git.calls).toEqual([]);
      expect(tasks.get(task.id)?.status).toBe('in_review');
    });

    it('refuses a follow-up without a commit', async () => {
      await expect(service.accept(inReview().id, { commit: false, followup: 'push' })).rejects.toThrow(ValidationError);
    });

    it('allows accepting a guard-tripped task and clears the warning', async () => {
      const task = inReview();
      tasks.setGitIssue(task.id, { kind: 'guard_tripped', detail: 'HEAD moved', pendingPush: null });
      expect(await service.accept(task.id, { commit: true })).toMatchObject({ status: 'done', gitIssue: null });
    });

    it('refuses a task not in review, and a second action while one runs', async () => {
      await expect(service.accept(tasks.create(newTask(project.id)).id, {})).rejects.toThrow(ConflictError);
      const task = inReview();
      const first = service.accept(task.id, { commit: true });
      // The lock is taken synchronously, before the first git call.
      expect(() => service.reject(task.id, 'x')).toThrow('Another action is already running');
      await expect(service.accept(task.id, { commit: true })).rejects.toThrow('Another action is already running');
      await first;
    });
  });

  describe('cancel', () => {
    it('rolls back to the snapshot and cancels a reviewed task', async () => {
      const task = inReview();
      expect((await service.cancel(task.id)).status).toBe('cancelled');
      expect(git.calls).toEqual(['rollback']);
      expect(scheduler.kicked).toEqual([project.id]);
    });

    it('stops a running agent before rolling back', async () => {
      const task = move(tasks.create(newTask(project.id)), 'promote', 'start');
      snapshots.save(task.id, SNAPSHOT);
      // The real worker moves the task to review once its stopped run ends.
      scheduler.onStop = (id) => move(tasks.get(id) ?? task, 'submit');

      expect((await service.cancel(task.id)).status).toBe('cancelled');
      expect(scheduler.stopped).toEqual([task.id]);
      expect(git.calls).toEqual(['rollback']);
    });

    it('cancels a task that never started without touching git', async () => {
      const task = move(tasks.create(newTask(project.id)), 'promote');
      expect((await service.cancel(task.id)).status).toBe('cancelled');
      expect(git.calls).toEqual([]);
    });

    it('keeps the task in review when the rollback cannot verify the tree', async () => {
      git.rollbackResult = { problems: ['Files left behind: x.txt'] };
      const task = inReview();
      await expect(service.cancel(task.id)).rejects.toThrow('Rollback did not fully restore the repo: Files left behind: x.txt');
      expect(tasks.get(task.id)?.status).toBe('in_review');
    });

    it('refuses finished tasks, and a task with no snapshot', async () => {
      const done = move(inReview(), 'accept');
      await expect(service.cancel(done.id)).rejects.toThrow(IllegalTransitionError);
      const noSnapshot = move(tasks.create(newTask(project.id)), 'promote', 'start', 'submit');
      await expect(service.cancel(noSnapshot.id)).rejects.toThrow('cannot be rolled back automatically');
    });
  });

  describe('retryPush and resolveIssue', () => {
    it('retries the pending branch and clears the badge on success', async () => {
      git.pushResult = { ok: false, error: 'offline' };
      const task = await service.accept(inReview().id, { commit: true, followup: 'push' });
      git.pushResult = { ok: true };
      expect(await service.retryPush(task.id)).toMatchObject({ gitIssue: null, pendingPush: null });
      expect(git.calls.filter((c) => c.startsWith('push'))).toEqual(['push develop', 'push develop']);
    });

    it('keeps the badge with the new error when the retry fails', async () => {
      git.pushResult = { ok: false, error: 'offline' };
      const task = await service.accept(inReview().id, { commit: true, followup: 'push' });
      git.pushResult = { ok: false, error: 'still offline' };
      expect(await service.retryPush(task.id)).toMatchObject({ gitIssue: 'push_failed', gitIssueDetail: 'still offline' });
    });

    it('marks a merge conflict resolved', async () => {
      projects.update(project.id, { mergeTarget: 'main' });
      git.mergeResult = { ok: false, conflict: true, files: ['a'], error: '' };
      const task = await service.accept(inReview().id, { commit: true, followup: 'merge' });
      await expect(service.retryPush(task.id)).rejects.toThrow('Nothing is waiting to be pushed');
      expect(service.resolveIssue(task.id).gitIssue).toBeNull();
      expect(() => service.resolveIssue(task.id)).toThrow(ConflictError);
    });
  });
});
