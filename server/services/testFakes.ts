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
  resumeWithFeedback(taskId: number, feedback: string): Promise<void> {
    this.resumed.push([taskId, feedback]);
    return Promise.resolve();
  }
  statuses(): ProjectStatus[] {
    return [];
  }
}

export const SNAPSHOT: RepoSnapshot = { branch: 'develop', head: 'abc123', untracked: [], emptyDirs: [] };

// Answers the scheduler's git questions; set the fields to steer a test.
export class FakeGit implements GitPort {
  snapshotResult: SnapshotResult = { ok: true, snapshot: SNAPSHOT };
  snapshotError: Error | null = null;
  guardProblems: string[] = [];
  readonly snapshotCalls: Array<[string, string]> = [];

  inspect(): Promise<RepoStatus> {
    return Promise.resolve({ branch: 'develop', head: 'abc123', changed: [], untracked: [] });
  }
  snapshot(repo: string, workingBranch: string): Promise<SnapshotResult> {
    this.snapshotCalls.push([repo, workingBranch]);
    return this.snapshotError ? Promise.reject(this.snapshotError) : Promise.resolve(this.snapshotResult);
  }
  touchedFiles(): Promise<TouchedFile[]> {
    return Promise.resolve([]);
  }
  diff(): Promise<FileDiff[]> {
    return Promise.resolve([]);
  }
  guardCheck(): Promise<GuardResult> {
    return Promise.resolve({ problems: this.guardProblems });
  }
  rollback(): Promise<RollbackResult> {
    return Promise.resolve({ problems: [] });
  }
  commitTouched(): Promise<CommitResult> {
    return Promise.resolve({ ok: true, sha: null, files: [] });
  }
  push(): Promise<PushResult> {
    return Promise.resolve({ ok: true });
  }
  mergeInto(): Promise<MergeResult> {
    return Promise.resolve({ ok: true, sha: 'def456', pushed: false, pushError: null });
  }
}
