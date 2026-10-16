import type { ProjectStatus } from '@shared/events';
import type {
  CommitResult,
  FileDiff,
  GitPort,
  GuardResult,
  MergeResult,
  PushResult,
  RepoSnapshot,
  RepoStatus,
  RollbackResult,
  SnapshotResult,
  TouchedFile,
  WorkScheduler,
} from './ports';

export class FakeScheduler implements WorkScheduler {
  readonly kicked: number[] = [];
  readonly stopped: number[] = [];
  readonly resumed: Array<[number, string]> = [];
  running = false;
  kick(projectId: number): Promise<void> {
    this.kicked.push(projectId);
    return Promise.resolve();
  }
  stop(taskId: number): boolean {
    this.stopped.push(taskId);
    return this.running;
  }
  /** Lets a test play the worker finishing after a stop, as the real scheduler would. */
  onStop: (taskId: number) => void = () => undefined;
  stopAndWait(taskId: number): Promise<void> {
    this.stopped.push(taskId);
    this.onStop(taskId);
    return Promise.resolve();
  }
  resumeWithFeedback(taskId: number, feedback: string): Promise<void> {
    this.resumed.push([taskId, feedback]);
    return Promise.resolve();
  }
  statuses(): ProjectStatus[] {
    return [];
  }
}

export const SNAPSHOT: RepoSnapshot = { branch: 'develop', head: 'abc123', untracked: [], emptyDirs: [] };

// Answers git questions from the services; set the fields to steer a test, read calls to check what was asked.
export class FakeGit implements GitPort {
  snapshotResult: SnapshotResult = { ok: true, snapshot: SNAPSHOT };
  snapshotError: Error | null = null;
  guardProblems: string[] = [];
  branches = new Set(['develop', 'main']);
  rollbackResult: RollbackResult = { problems: [] };
  commitResult: CommitResult = { ok: true, sha: 'c0ffee', files: ['src/app.ts'] };
  pushResult: PushResult = { ok: true };
  mergeResult: MergeResult = { ok: true, sha: 'def456', pushed: false, pushError: null };
  readonly snapshotCalls: Array<[string, string]> = [];
  readonly calls: string[] = [];

  inspect(): Promise<RepoStatus> {
    return Promise.resolve({ branch: 'develop', head: 'abc123', changed: [], untracked: [] });
  }
  branchExists(_repo: string, branch: string): Promise<boolean> {
    return Promise.resolve(this.branches.has(branch));
  }
  snapshot(repo: string, workingBranch: string): Promise<SnapshotResult> {
    this.snapshotCalls.push([repo, workingBranch]);
    return this.snapshotError ? Promise.reject(this.snapshotError) : Promise.resolve(this.snapshotResult);
  }
  touched: TouchedFile[] = [];
  touchedFiles(): Promise<TouchedFile[]> {
    return Promise.resolve(this.touched);
  }
  diff(_repo: string, _snapshot: RepoSnapshot, files: readonly TouchedFile[]): Promise<FileDiff[]> {
    return Promise.resolve(files.map((f) => ({ ...f, patch: `diff for ${f.path}`, binary: false, truncated: false })));
  }
  guardCheck(): Promise<GuardResult> {
    return Promise.resolve({ problems: this.guardProblems });
  }
  rollback(): Promise<RollbackResult> {
    this.calls.push('rollback');
    return Promise.resolve(this.rollbackResult);
  }
  commitTouched(_repo: string, _snapshot: RepoSnapshot, message: string): Promise<CommitResult> {
    this.calls.push(`commit ${message}`);
    return Promise.resolve(this.commitResult);
  }
  push(_repo: string, branch: string): Promise<PushResult> {
    this.calls.push(`push ${branch}`);
    return Promise.resolve(this.pushResult);
  }
  mergeInto(_repo: string, source: string, target: string, opts: { readonly push: boolean }): Promise<MergeResult> {
    this.calls.push(`merge ${source} into ${target}${opts.push ? ' and push' : ''}`);
    return Promise.resolve(this.mergeResult);
  }
}
