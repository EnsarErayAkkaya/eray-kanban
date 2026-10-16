import type { RunChecks } from '@shared/check';
import type { Project } from '@shared/project';
import type { AcceptOptions, ReviewChanges } from '@shared/review';
import type { Task } from '@shared/task';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { type TaskEvent, occupiesProject, transition } from '../domain/taskMachine';
import { commitMessage } from './commitMessage';
import type {
  BoardEventSink,
  CheckRepo,
  GitPort,
  ProjectRepo,
  RunRepo,
  SnapshotRepo,
  TaskGitIssue,
  TaskRepo,
  WorkScheduler,
} from './ports';

export interface ReviewDeps {
  readonly projects: ProjectRepo;
  readonly tasks: TaskRepo;
  readonly runs: RunRepo;
  readonly checks: CheckRepo;
  readonly snapshots: SnapshotRepo;
  readonly git: GitPort;
  readonly scheduler: WorkScheduler;
  readonly events: BoardEventSink;
}

// Invariant 1: the only place history-changing git runs, and only from your actions in review.
export class ReviewService {
  private readonly _busy = new Set<number>();

  constructor(private readonly _deps: ReviewDeps) {}

  /** Touched files and diffs against the task's snapshot, read now; only while the task holds its project. */
  async changes(taskId: number): Promise<ReviewChanges> {
    const task = this._require(taskId);
    const none = (reason: string): ReviewChanges => ({ available: false, reason, baseHead: null, files: [] });
    if (!occupiesProject(task.status)) {
      return none(task.commitSha ? `Committed as ${task.commitSha.slice(0, 8)}` : 'This task is not active, so there is nothing to compare');
    }
    const snapshot = this._deps.snapshots.get(taskId);
    if (!snapshot) return none('This task has no snapshot to compare against');

    const repo = this._projectOf(task).repoPath;
    const files = await this._deps.git.diff(repo, snapshot, await this._deps.git.touchedFiles(repo, snapshot));
    return { available: true, reason: null, baseHead: snapshot.head, files };
  }

  checks(taskId: number): RunChecks[] {
    this._require(taskId);
    return this._deps.checks.listByTask(taskId);
  }

  /** The same session resumes with the feedback, so the agent keeps its context. */
  reject(taskId: number, feedback: string): Task {
    if (this._busy.has(taskId)) throw new ConflictError('Another action is already running for this task');
    const task = this._require(taskId);
    if (task.status !== 'in_review') throw new ConflictError('Only a task in review can be rejected');
    if (!this._deps.runs.listByTask(taskId).some((r) => r.sessionId !== null)) {
      throw new ConflictError('This task has no agent session to resume');
    }
    const updated = this._move(task, 'reject');
    void this._deps.scheduler.resumeWithFeedback(taskId, feedback);
    return updated;
  }

  /** Commit (invariant 6), then Done, then the follow-up; a failed follow-up leaves a badge, not a stuck task. */
  accept(taskId: number, options: AcceptOptions): Promise<Task> {
    return this._exclusive(taskId, async () => {
      const { tasks, snapshots, git, scheduler } = this._deps;
      const task = this._require(taskId);
      if (task.status !== 'in_review') throw new ConflictError('Only a task in review can be accepted');
      const project = this._projectOf(task);
      const commit = options.commit ?? project.acceptCommit;
      const followup = options.followup ?? project.acceptFollowup;
      const pushAfterMerge = options.pushAfterMerge ?? project.pushAfterMerge;

      if (!commit && followup !== 'none') throw new ValidationError('Push and merge need a commit');
      if (followup === 'merge') await this._requireMergeTarget(project);

      if (commit) {
        const snapshot = snapshots.get(taskId);
        if (!snapshot) throw new ConflictError('This task has no snapshot to commit against; accept it without a commit');
        const message = commitMessage(project.commitMessageFormat, task, this._summary(taskId));
        const result = await git.commitTouched(project.repoPath, snapshot, message);
        // The commit is the one step that may fail with the task still in review, untouched.
        if (!result.ok) throw new ConflictError(`Commit failed: ${result.error}`);
        if (result.sha !== null) tasks.setCommitSha(taskId, result.sha);
      }
      // Accepting means you saw what the agent did to git; the warning has served its purpose.
      if (task.gitIssue === 'guard_tripped') tasks.setGitIssue(taskId, null);

      let done = this._move(this._require(taskId), 'accept');
      if (commit) done = await this._followUp(project, done, followup, pushAfterMerge);
      void scheduler.kick(project.id);
      return done;
    });
  }

  /** Stops a running agent first, then restores the snapshot exactly (invariant 5) and cancels. */
  cancel(taskId: number): Promise<Task> {
    return this._exclusive(taskId, async () => {
      const { snapshots, git, tasks, scheduler } = this._deps;
      let task = this._require(taskId);
      if (task.status === 'backlog' || task.status === 'todo') return this._move(task, 'cancel');
      if (task.status === 'in_progress') {
        await scheduler.stopAndWait(taskId);
        task = this._require(taskId);
        if (task.status === 'in_progress') throw new ConflictError('The agent did not stop; try again');
      }
      // Done and Cancelled fall through to the state machine, which refuses them.
      if (task.status === 'done' || task.status === 'cancelled') return this._move(task, 'cancel');

      const project = this._projectOf(task);
      const snapshot = snapshots.get(taskId);
      if (!snapshot) throw new ConflictError('This task has no snapshot, so it cannot be rolled back automatically');
      const { problems } = await git.rollback(project.repoPath, snapshot);
      if (problems.length > 0) throw new ConflictError(`Rollback did not fully restore the repo: ${problems.join('; ')}`);

      if (task.gitIssue !== null) tasks.setGitIssue(taskId, null);
      const cancelled = this._move(this._require(taskId), 'cancel');
      void scheduler.kick(project.id);
      return cancelled;
    });
  }

  retryPush(taskId: number): Promise<Task> {
    return this._exclusive(taskId, async () => {
      const task = this._require(taskId);
      if (task.gitIssue !== 'push_failed' || task.pendingPush === null) throw new ConflictError('Nothing is waiting to be pushed');
      const branch = task.pendingPush;
      const pushed = await this._deps.git.push(this._projectOf(task).repoPath, branch);
      return this._flag(taskId, pushed.ok ? null : { kind: 'push_failed', detail: pushed.error, pendingPush: branch });
    });
  }

  /** For a merge conflict or push you sorted out yourself. */
  resolveIssue(taskId: number): Task {
    if (this._busy.has(taskId)) throw new ConflictError('Another action is already running for this task');
    const task = this._require(taskId);
    if (task.status !== 'done' || task.gitIssue === null) throw new ConflictError('This task has no git issue to resolve');
    return this._flag(taskId, null);
  }

  private async _followUp(project: Project, task: Task, followup: string, pushAfterMerge: boolean): Promise<Task> {
    const { git } = this._deps;
    if (followup === 'push') {
      const pushed = await git.push(project.repoPath, project.workingBranch);
      return pushed.ok ? task : this._flag(task.id, { kind: 'push_failed', detail: pushed.error, pendingPush: project.workingBranch });
    }
    if (followup !== 'merge' || project.mergeTarget === null) return task;

    const target = project.mergeTarget;
    const merged = await git.mergeInto(project.repoPath, project.workingBranch, target, { push: pushAfterMerge });
    if (!merged.ok) {
      // Invariant 7: the merge was aborted and the commit stays on the working branch for you to merge.
      const detail = merged.conflict ? `Conflicts in ${merged.files.join(', ')}` : `Merge failed: ${merged.error}`;
      return this._flag(task.id, { kind: 'merge_conflict', detail, pendingPush: null });
    }
    if (merged.pushError !== null) {
      const detail = `Merged into ${target}, but the push failed: ${merged.pushError}`;
      return this._flag(task.id, { kind: 'push_failed', detail, pendingPush: target });
    }
    return task;
  }

  private async _requireMergeTarget(project: Project): Promise<void> {
    if (project.mergeTarget === null) throw new ValidationError('Set a merge target in the project settings first');
    if (!(await this._deps.git.branchExists(project.repoPath, project.mergeTarget))) {
      throw new ValidationError(`There is no local branch ${project.mergeTarget}`);
    }
  }

  private _summary(taskId: number): string | null {
    const reviews = this._deps.runs.listByTask(taskId).map((r) => r.review);
    return reviews.filter((r) => r !== null && r.summary.trim() !== '').at(-1)?.summary ?? null;
  }

  private async _exclusive(taskId: number, work: () => Promise<Task>): Promise<Task> {
    if (this._busy.has(taskId)) throw new ConflictError('Another action is already running for this task');
    this._busy.add(taskId);
    try {
      return await work();
    } finally {
      this._busy.delete(taskId);
    }
  }

  private _flag(taskId: number, issue: TaskGitIssue | null): Task {
    const task = this._deps.tasks.setGitIssue(taskId, issue);
    this._deps.events.publish({ type: 'task', task });
    return task;
  }

  private _move(task: Task, event: TaskEvent): Task {
    const updated = this._deps.tasks.applyStatusChange(transition(task, event));
    this._deps.events.publish({ type: 'task', task: updated });
    return updated;
  }

  private _require(id: number): Task {
    const task = this._deps.tasks.get(id);
    if (!task) throw new NotFoundError('task', id);
    return task;
  }

  private _projectOf(task: Task): Project {
    const project = this._deps.projects.get(task.projectId);
    if (!project) throw new NotFoundError('project', task.projectId);
    return project;
  }
}
