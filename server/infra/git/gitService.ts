import fs from 'node:fs';
import path from 'node:path';
import { GitError } from '../../domain/errors';
import type {
  CommitResult,
  FileChange,
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
} from '../../services/ports';
import type { ProcessSupervisor } from '../process/processSupervisor';

export interface GitServiceOptions {
  readonly timeoutMs: number;
  /** Push, and commit (hooks may run linters). */
  readonly slowTimeoutMs: number;
  readonly maxFileDiffBytes: number;
  readonly maxTotalDiffBytes: number;
}

export const DEFAULT_GIT_OPTIONS: GitServiceOptions = {
  timeoutMs: 30_000,
  slowTimeoutMs: 120_000,
  maxFileDiffBytes: 200_000,
  maxTotalDiffBytes: 2_000_000,
};

const MAX_OUTPUT_BYTES = 20_000_000;
const PATHS_PER_CALL = 200;

interface GitRun {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface GitCall {
  readonly okCodes?: readonly number[];
  readonly stdin?: string;
  readonly slow?: boolean;
  readonly maxBytes?: number;
}

const splitZ = (out: Buffer): string[] => out.toString('utf8').split('\0').filter(Boolean);
const text = (run: GitRun): string => [run.stderr, run.stdout.toString('utf8')].join('\n').trim();

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const STATUS_CHANGE: Readonly<Record<string, FileChange>> = { A: 'added', D: 'deleted' };
const REDIRECTING_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']);

export class GitService implements GitPort {
  private readonly _env: NodeJS.ProcessEnv;

  constructor(
    private readonly _supervisor: ProcessSupervisor,
    private readonly _options: GitServiceOptions = DEFAULT_GIT_OPTIONS,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ) {
    // Anything that points git at another repo or index would make every result wrong.
    const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !REDIRECTING_ENV.has(key)));
    this._env = {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      // File names from git go back into git as exact names, never as globs.
      GIT_LITERAL_PATHSPECS: '1',
      GIT_EDITOR: 'true',
      LC_ALL: 'C',
    };
  }

  async inspect(repo: string): Promise<RepoStatus> {
    const [branch, head, status, untracked] = await Promise.all([
      this._git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] }),
      this._git(repo, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { okCodes: [0, 1] }),
      this._git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames']),
      this._untracked(repo),
    ]);
    return {
      branch: branch.code === 0 ? branch.stdout.toString().trim() : null,
      head: head.code === 0 ? head.stdout.toString().trim() : null,
      changed: splitZ(status.stdout).map((entry) => entry.slice(3)),
      untracked,
    };
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    const run = await this._git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { okCodes: [0, 1] });
    return run.code === 0;
  }

  async snapshot(repo: string, workingBranch: string): Promise<SnapshotResult> {
    const s = await this.inspect(repo);
    if (s.head === null) return { ok: false, reason: 'no_commits', detail: 'The repo has no commits yet' };
    if (s.branch === null) return { ok: false, reason: 'detached', detail: `HEAD is detached; check out ${workingBranch}` };
    if (s.branch !== workingBranch) {
      return { ok: false, reason: 'wrong_branch', detail: `Repo is on ${s.branch}, expected ${workingBranch}` };
    }
    const dirty = [...s.changed, ...s.untracked];
    if (dirty.length > 0) {
      const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : '';
      return { ok: false, reason: 'dirty', detail: `Uncommitted changes: ${dirty.slice(0, 5).join(', ')}${more}` };
    }
    return {
      ok: true,
      snapshot: { branch: s.branch, head: s.head, untracked: s.untracked, emptyDirs: await this._emptyDirs(repo) },
    };
  }

  async touchedFiles(repo: string, snapshot: RepoSnapshot): Promise<TouchedFile[]> {
    const [tracked, untracked] = await Promise.all([
      this._git(repo, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', snapshot.head, '--']),
      this._untracked(repo),
    ]);
    const files = new Map<string, FileChange>();
    const fields = splitZ(tracked.stdout);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i] ?? '';
      const file = fields[i + 1] ?? '';
      files.set(file, STATUS_CHANGE[status] ?? 'modified');
    }
    const before = new Set(snapshot.untracked);
    const now = new Set(untracked);
    for (const file of untracked) if (!before.has(file)) files.set(file, 'added');
    for (const file of snapshot.untracked) if (!now.has(file) && !files.has(file)) files.set(file, 'deleted');

    return [...files].map(([p, change]) => ({ path: p, change })).sort((a, b) => a.path.localeCompare(b.path));
  }

  async diff(repo: string, snapshot: RepoSnapshot, files: readonly TouchedFile[]): Promise<FileDiff[]> {
    const untracked = new Set(await this._untracked(repo));
    const out: FileDiff[] = [];
    let total = 0;

    for (const file of files) {
      const budget = Math.min(this._options.maxFileDiffBytes, this._options.maxTotalDiffBytes - total);
      if (budget <= 0) {
        out.push({ ...file, patch: '', binary: false, truncated: true });
        continue;
      }
      const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
      // A new file git does not track yet only shows up against /dev/null.
      const run = untracked.has(file.path)
        ? await this._git(repo, ['diff', '--no-index', ...flags, '--', '/dev/null', file.path], { okCodes: [0, 1], maxBytes: budget })
        : await this._git(repo, ['diff', ...flags, '--no-renames', snapshot.head, '--', file.path], { maxBytes: budget });
      const patch = run.stdout.toString('utf8');
      total += run.stdout.length;
      out.push({ ...file, patch, binary: /^Binary files .* differ$/m.test(patch), truncated: run.truncated });
    }
    return out;
  }

  async guardCheck(repo: string, snapshot: RepoSnapshot): Promise<GuardResult> {
    const [status, staged, merge] = await Promise.all([
      this.inspect(repo),
      this._git(repo, ['diff', '--cached', '--quiet', '--no-ext-diff'], { okCodes: [0, 1] }),
      this._git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { okCodes: [0, 1] }),
    ]);
    const problems: string[] = [];
    if (status.branch !== snapshot.branch) {
      problems.push(`Branch changed from ${snapshot.branch} to ${status.branch ?? 'a detached HEAD'}`);
    }
    if (status.head !== snapshot.head) problems.push(`HEAD moved from ${short(snapshot.head)} to ${short(status.head)}`);
    if (staged.code === 1) problems.push('Changes were staged in the index');
    if (merge.code === 0) problems.push('A merge was left in progress');
    return { problems };
  }

  async rollback(repo: string, snapshot: RepoSnapshot): Promise<RollbackResult> {
    const before = await this.inspect(repo);
    if (before.branch !== snapshot.branch) {
      await this._requireBranch(repo, snapshot.branch);
      await this._git(repo, ['checkout', '-q', '-f', snapshot.branch]);
    }
    // Resets tracked files and the index; untracked and ignored files are left alone.
    await this._git(repo, ['reset', '-q', '--hard', snapshot.head]);

    const known = new Set(snapshot.untracked);
    const created = (await this._untracked(repo)).filter((f) => !known.has(f));
    for (const batch of chunked(created, PATHS_PER_CALL)) await this._git(repo, ['clean', '-f', '-q', '--', ...batch]);
    removeEmptyParents(repo, created, new Set(snapshot.emptyDirs));

    return { problems: await this._differencesFrom(repo, snapshot) };
  }

  async commitTouched(repo: string, snapshot: RepoSnapshot, message: string): Promise<CommitResult> {
    const touched = await this.touchedFiles(repo, snapshot);
    const known = new Set(snapshot.untracked);
    // An untracked file that disappeared has nothing for git to stage.
    const paths = touched.filter((f) => !(f.change === 'deleted' && known.has(f.path))).map((f) => f.path);
    if (paths.length === 0) return { ok: true, sha: null, files: [] };

    // Invariant 6: name every file; `git add -- <deleted file>` stages its removal too.
    for (const batch of chunked(paths, PATHS_PER_CALL)) await this._git(repo, ['add', '--', ...batch]);
    const staged = splitZ((await this._git(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames'])).stdout);
    if (staged.length === 0) return { ok: true, sha: null, files: [] };

    const allowed = new Set(paths);
    const outside = staged.filter((f) => !allowed.has(f));
    if (outside.length > 0) {
      await this._unstage(repo, staged);
      return { ok: false, error: `The index held changes outside this task: ${outside.slice(0, 5).join(', ')}` };
    }
    try {
      await this._git(repo, ['commit', '-q', '-F', '-'], { stdin: message, slow: true });
    } catch (err) {
      await this._unstage(repo, staged);
      return { ok: false, error: err instanceof GitError ? err.detail : String(err) };
    }
    const sha = (await this._git(repo, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    return { ok: true, sha, files: staged };
  }

  async push(repo: string, branch: string): Promise<PushResult> {
    const run = await this._git(repo, ['push', '--porcelain', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
      okCodes: [0, 1, 128],
      slow: true,
    });
    if (run.code === 0) return { ok: true };
    // Porcelain mode reports a rejected ref on stdout and the summary on stderr.
    const rejected = run.stdout.toString('utf8').split('\n').filter((l) => l.startsWith('!'));
    return { ok: false, error: [run.stderr, ...rejected].filter(Boolean).join('\n') || `push exited with ${run.code}` };
  }

  async mergeInto(repo: string, source: string, target: string, opts: { readonly push: boolean }): Promise<MergeResult> {
    const fail = (error: string): MergeResult => ({ ok: false, conflict: false, files: [], error });
    const status = await this.inspect(repo);
    if (status.branch !== source) return fail(`Expected to be on ${source}, found ${status.branch ?? 'a detached HEAD'}`);
    if (status.changed.length > 0 || status.untracked.length > 0) return fail('The working tree must be clean to merge');
    if (!(await this.branchExists(repo, target))) return fail(`There is no local branch ${target}`);

    try {
      await this._git(repo, ['checkout', '-q', target]);
      const merge = await this._git(repo, ['merge', '--no-ff', '--no-edit', '-q', source], { okCodes: [0, 1, 128] });
      if (merge.code !== 0) {
        const files = splitZ((await this._git(repo, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout);
        // Invariant 7: never resolve; put the target back exactly as it was.
        const inMerge = await this._git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { okCodes: [0, 1] });
        if (inMerge.code === 0) await this._git(repo, ['merge', '--abort']);
        return { ok: false, conflict: files.length > 0, files, error: text(merge) || 'Merge failed' };
      }
      const sha = (await this._git(repo, ['rev-parse', 'HEAD'])).stdout.toString().trim();
      if (!opts.push) return { ok: true, sha, pushed: false, pushError: null };
      const pushed = await this.push(repo, target);
      return { ok: true, sha, pushed: pushed.ok, pushError: pushed.ok ? null : pushed.error };
    } finally {
      await this._git(repo, ['checkout', '-q', source]);
    }
  }

  private async _differencesFrom(repo: string, snapshot: RepoSnapshot): Promise<string[]> {
    const after = await this.inspect(repo);
    const problems: string[] = [];
    if (after.branch !== snapshot.branch) problems.push(`Still on ${after.branch ?? 'a detached HEAD'}, not ${snapshot.branch}`);
    if (after.head !== snapshot.head) problems.push(`HEAD is ${short(after.head)}, not ${short(snapshot.head)}`);
    if (after.changed.length > 0) problems.push(`Tracked files still differ: ${after.changed.slice(0, 5).join(', ')}`);
    const now = new Set(after.untracked);
    const missing = snapshot.untracked.filter((f) => !now.has(f));
    const extra = after.untracked.filter((f) => !snapshot.untracked.includes(f));
    if (missing.length > 0) problems.push(`Untracked files git cannot restore: ${missing.slice(0, 5).join(', ')}`);
    if (extra.length > 0) problems.push(`Files left behind: ${extra.slice(0, 5).join(', ')}`);
    return problems;
  }

  async listFiles(repo: string): Promise<string[]> {
    const run = await this._git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    return [...new Set(splitZ(run.stdout))].sort();
  }

  private async _untracked(repo: string): Promise<string[]> {
    return splitZ((await this._git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout);
  }

  // git lists a tree of empty folders only by its top folder, so every folder inside is recorded too.
  private async _emptyDirs(repo: string): Promise<string[]> {
    const entries = splitZ((await this._git(repo, ['ls-files', '--others', '--exclude-standard', '--directory', '-z'])).stdout);
    return entries.filter((e) => e.endsWith('/')).flatMap((e) => fileLessTree(repo, e.slice(0, -1)) ?? []);
  }

  private async _requireBranch(repo: string, branch: string): Promise<void> {
    if (!(await this.branchExists(repo, branch))) throw new GitError('rev-parse', `Branch ${branch} no longer exists`);
  }

  private async _unstage(repo: string, files: readonly string[]): Promise<void> {
    // Index only: the working tree keeps every change for the next attempt.
    for (const batch of chunked(files, PATHS_PER_CALL)) await this._git(repo, ['reset', '-q', '--', ...batch]);
  }

  private async _git(repo: string, args: readonly string[], call: GitCall = {}): Promise<GitRun> {
    const command = args[0] ?? 'git';
    const exit = await this._supervisor.capture({
      command: 'git',
      args: ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      cwd: repo,
      env: this._env,
      stdin: call.stdin ?? '',
      timeoutMs: call.slow ? this._options.slowTimeoutMs : this._options.timeoutMs,
      maxStdoutBytes: call.maxBytes ?? MAX_OUTPUT_BYTES,
    });
    if (exit.spawnError) throw new GitError(command, exit.spawnError);
    if (exit.timedOut) throw new GitError(command, 'timed out and was killed');
    const run = { code: exit.code ?? -1, stdout: exit.stdout, stderr: exit.stderrTail, truncated: exit.stdoutTruncated };
    if (!(call.okCodes ?? [0]).includes(run.code)) throw new GitError(command, text(run) || `exit code ${run.code}`);
    return run;
  }
}

const short = (sha: string | null) => (sha === null ? 'nothing' : sha.slice(0, 8));

/** The folder and every folder below it, or null if any file lives in there. */
function fileLessTree(repo: string, dir: string): string[] | null {
  const found = [dir];
  for (const entry of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) return null;
    const inner = fileLessTree(repo, `${dir}/${entry.name}`);
    if (inner === null) return null;
    found.push(...inner);
  }
  return found;
}

// Removes folders that only the deleted files needed; folders that were empty before stay.
function removeEmptyParents(repo: string, files: readonly string[], keep: ReadonlySet<string>): void {
  const root = path.resolve(repo);
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = path.dirname(file); dir !== '.' && dir !== ''; dir = path.dirname(dir)) dirs.add(dir);
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of deepestFirst) {
    const abs = path.resolve(root, dir);
    if (keep.has(dir) || !abs.startsWith(root + path.sep)) continue;
    try {
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      // Already gone, or not a folder we can read: nothing to undo.
    }
  }
}
