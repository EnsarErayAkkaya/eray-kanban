import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepoSnapshot } from '../../services/ports';
import { ProcessSupervisor } from '../process/processSupervisor';
import { DEFAULT_GIT_OPTIONS, GitService } from './gitService';
import { HERMETIC_GIT_ENV, type TestRepo, cleanupRepos, makeRepo } from './testRepo';

// Integration tests against real temp repos (CLAUDE.md §5). The repo helper plays the agent and the user.
const git = new GitService(new ProcessSupervisor(200), DEFAULT_GIT_OPTIONS, HERMETIC_GIT_ENV);

afterEach(cleanupRepos);

const without = (files: Record<string, string>, ...names: string[]) =>
  Object.fromEntries(Object.entries(files).filter(([name]) => !names.includes(name)));

async function snap(repo: TestRepo): Promise<RepoSnapshot> {
  const result = await git.snapshot(repo.dir, 'develop');
  if (!result.ok) throw new Error(`snapshot failed: ${result.detail}`);
  return result.snapshot;
}

describe('GitService', () => {
  describe('inspect', () => {
    it('reports branch, HEAD and a clean tree, ignoring ignored files', async () => {
      const repo = makeRepo();
      const status = await git.inspect(repo.dir);
      expect(status).toEqual({ branch: 'develop', head: repo.git('rev-parse', 'HEAD').trim(), changed: [], untracked: [] });
    });

    it('lists changed and untracked files', async () => {
      const repo = makeRepo();
      repo.write('src/app.ts', 'changed\n');
      repo.write('new file.txt', 'x');
      expect(await git.inspect(repo.dir)).toMatchObject({ changed: ['src/app.ts'], untracked: ['new file.txt'] });
    });
  });

  describe('snapshot (invariant 4)', () => {
    it('records branch and HEAD of a clean repo', async () => {
      const repo = makeRepo();
      expect(await git.snapshot(repo.dir, 'develop')).toEqual({
        ok: true,
        snapshot: { branch: 'develop', head: repo.git('rev-parse', 'HEAD').trim(), untracked: [], emptyDirs: [] },
      });
    });

    it('refuses a tree with changes or untracked files', async () => {
      const modified = makeRepo();
      modified.write('README.md', 'edited\n');
      expect(await git.snapshot(modified.dir, 'develop')).toMatchObject({ ok: false, reason: 'dirty' });

      const untracked = makeRepo();
      untracked.write('notes.txt', 'x');
      expect(await git.snapshot(untracked.dir, 'develop')).toMatchObject({
        ok: false,
        reason: 'dirty',
        detail: 'Uncommitted changes: notes.txt',
      });
    });

    it('refuses the wrong branch or a detached HEAD, and never switches itself', async () => {
      const repo = makeRepo();
      repo.git('checkout', '-q', 'main');
      expect(await git.snapshot(repo.dir, 'develop')).toEqual({
        ok: false,
        reason: 'wrong_branch',
        detail: 'Repo is on main, expected develop',
      });
      expect(repo.git('branch', '--show-current').trim()).toBe('main');

      repo.git('checkout', '-q', '--detach');
      expect(await git.snapshot(repo.dir, 'develop')).toMatchObject({ ok: false, reason: 'detached' });
    });

    it('refuses a repo with no commits', async () => {
      const repo = makeRepo();
      fs.rmSync(path.join(repo.dir, '.git'), { recursive: true });
      repo.git('init', '-q', '-b', 'develop');
      expect(await git.snapshot(repo.dir, 'develop')).toMatchObject({ ok: false, reason: 'no_commits' });
    });

    it('records empty folders, which git does not see', async () => {
      const repo = makeRepo();
      fs.mkdirSync(path.join(repo.dir, 'empty/inner'), { recursive: true });
      fs.mkdirSync(path.join(repo.dir, 'src/blank'));
      expect([...(await snap(repo)).emptyDirs].sort()).toEqual(['empty', 'empty/inner', 'src/blank']);
    });
  });

  describe('touchedFiles', () => {
    it('lists added, modified and deleted files, odd names included', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('src/app.ts', 'export const app = 2;\n');
      repo.remove('docs/guide.md');
      repo.write('src/new/deep file.ts', 'x');
      repo.write('-rf', 'not an option');
      repo.write('star*.txt', 'literal');
      repo.write('ünïcode.md', 'x');
      repo.write('debug2.log', 'ignored');

      expect(await git.touchedFiles(repo.dir, snapshot)).toEqual([
        { path: '-rf', change: 'added' },
        { path: 'docs/guide.md', change: 'deleted' },
        { path: 'src/app.ts', change: 'modified' },
        { path: 'src/new/deep file.ts', change: 'added' },
        { path: 'star*.txt', change: 'added' },
        { path: 'ünïcode.md', change: 'added' },
      ]);
    });

    it('counts a staged new file once', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('staged.ts', 'x');
      repo.git('add', 'staged.ts');
      expect(await git.touchedFiles(repo.dir, snapshot)).toEqual([{ path: 'staged.ts', change: 'added' }]);
    });

    it('includes changes the agent already committed', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('src/util.ts', 'committed by agent\n');
      repo.git('commit', '-q', '-am', 'sneaky');
      expect(await git.touchedFiles(repo.dir, snapshot)).toEqual([{ path: 'src/util.ts', change: 'modified' }]);
    });
  });

  describe('diff', () => {
    it('gives a patch per file, new untracked files included', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('src/app.ts', 'export const app = 2;\n');
      repo.write('added.ts', 'hello\n');
      repo.remove('README.md');
      const diffs = await git.diff(repo.dir, snapshot, await git.touchedFiles(repo.dir, snapshot));

      const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));
      expect(byPath['src/app.ts']?.patch).toContain('-export const app = 1;\n+export const app = 2;');
      expect(byPath['added.ts']?.patch).toContain('+hello');
      expect(byPath['README.md']?.patch).toContain('-# Demo');
      expect(diffs.every((d) => !d.binary && !d.truncated)).toBe(true);
    });

    it('marks binary files and cuts large patches', async () => {
      const repo = makeRepo();
      const small = new GitService(new ProcessSupervisor(200), { ...DEFAULT_GIT_OPTIONS, maxFileDiffBytes: 500 }, HERMETIC_GIT_ENV);
      const snapshot = await snap(repo);
      repo.write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
      repo.write('big.txt', 'line\n'.repeat(1_000));
      const diffs = await small.diff(repo.dir, snapshot, await small.touchedFiles(repo.dir, snapshot));

      expect(diffs.find((d) => d.path === 'image.png')).toMatchObject({ binary: true });
      const big = diffs.find((d) => d.path === 'big.txt');
      expect(big?.truncated).toBe(true);
      expect(big?.patch.length).toBe(500);
    });

    it('stops adding patches once the total limit is reached', async () => {
      const repo = makeRepo();
      const small = new GitService(new ProcessSupervisor(200), { ...DEFAULT_GIT_OPTIONS, maxTotalDiffBytes: 300 }, HERMETIC_GIT_ENV);
      const snapshot = await snap(repo);
      for (const name of ['a.txt', 'b.txt', 'c.txt']) repo.write(name, 'content line\n'.repeat(20));
      const diffs = await small.diff(repo.dir, snapshot, await small.touchedFiles(repo.dir, snapshot));
      expect(diffs.at(-1)).toMatchObject({ path: 'c.txt', patch: '', truncated: true });
    });
  });

  describe('guardCheck (post-run check)', () => {
    it('passes when the agent only edited files', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('src/app.ts', 'edit\n');
      repo.write('new.ts', 'x');
      expect(await git.guardCheck(repo.dir, snapshot)).toEqual({ problems: [] });
    });

    it('catches a commit, staged changes and a branch switch', async () => {
      const committed = makeRepo();
      const s1 = await snap(committed);
      committed.write('src/app.ts', 'edit\n');
      committed.git('commit', '-q', '-am', 'agent commit');
      expect((await git.guardCheck(committed.dir, s1)).problems).toEqual([expect.stringMatching(/^HEAD moved from /)]);

      const staged = makeRepo();
      const s2 = await snap(staged);
      staged.write('src/app.ts', 'edit\n');
      staged.git('add', 'src/app.ts');
      expect((await git.guardCheck(staged.dir, s2)).problems).toEqual(['Changes were staged in the index']);

      const switched = makeRepo();
      const s3 = await snap(switched);
      switched.git('checkout', '-q', 'main');
      expect((await git.guardCheck(switched.dir, s3)).problems).toEqual(['Branch changed from develop to main']);
    });
  });

  describe('rollback (invariant 5)', () => {
    it('restores new, modified and deleted files exactly and leaves ignored files alone', async () => {
      const repo = makeRepo();
      fs.mkdirSync(path.join(repo.dir, 'keep-empty'));
      const before = repo.hashes();
      const snapshot = await snap(repo);

      repo.write('src/app.ts', 'broken\n');
      repo.remove('docs/guide.md');
      repo.write('src/feature/deep/new.ts', 'new');
      repo.write('keep-empty/inside.txt', 'x');
      repo.write('-rf', 'x');
      repo.write('.env', 'SECRET=changed-by-agent\n');
      repo.write('build.log', 'created, but ignored');
      repo.git('add', 'src/app.ts');

      expect(await git.rollback(repo.dir, snapshot)).toEqual({ problems: [] });
      const after = repo.hashes();
      // Ignored files are never touched, even ones the agent changed or created.
      expect(after['.env']).not.toBe(before['.env']);
      expect(after['build.log']).toBeDefined();
      expect(without(after, '.env', 'build.log')).toEqual(without(before, '.env'));
      expect(repo.exists('node_modules/pkg/index.js')).toBe(true);
    });

    it('undoes a commit the agent made and returns to the snapshot branch', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('src/app.ts', 'agent\n');
      repo.git('commit', '-q', '-am', 'agent commit');
      repo.git('checkout', '-q', '-b', 'agent-branch');
      repo.write('stray.txt', 'x');

      expect(await git.rollback(repo.dir, snapshot)).toEqual({ problems: [] });
      expect(repo.git('branch', '--show-current').trim()).toBe('develop');
      expect(repo.git('rev-parse', 'HEAD').trim()).toBe(snapshot.head);
      expect(repo.read('src/app.ts')).toBe('export const app = 1;\n');
      expect(repo.exists('stray.txt')).toBe(false);
    });

    it('keeps nested empty folders that existed before the task', async () => {
      const repo = makeRepo();
      fs.mkdirSync(path.join(repo.dir, 'assets/icons'), { recursive: true });
      const before = repo.hashes();
      const snapshot = await snap(repo);
      repo.write('assets/icons/logo.svg', '<svg/>');
      repo.write('assets/icons/new/sub/x.svg', '<svg/>');

      expect(await git.rollback(repo.dir, snapshot)).toEqual({ problems: [] });
      expect(repo.hashes()).toEqual(before);
    });

    it('is a no-op on an untouched tree', async () => {
      const repo = makeRepo();
      const before = repo.hashes();
      expect(await git.rollback(repo.dir, await snap(repo))).toEqual({ problems: [] });
      expect(repo.hashes()).toEqual(before);
    });

    it('reports untracked files it cannot restore', async () => {
      const repo = makeRepo();
      const snapshot = { ...(await snap(repo)), untracked: ['was-here.txt'] };
      expect((await git.rollback(repo.dir, snapshot)).problems).toEqual(['Untracked files git cannot restore: was-here.txt']);
    });
  });

  describe('commitTouched (invariant 6)', () => {
    it('commits exactly the touched files, deletions included', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('src/app.ts', 'export const app = 2;\n');
      repo.remove('docs/guide.md');
      repo.write('star*.txt', 'literal');
      repo.write('build.log', 'ignored, never committed');

      const result = await git.commitTouched(repo.dir, snapshot, 'feat(#7): Add thing\n\nSummary from the agent.');
      expect(result).toMatchObject({ ok: true, files: ['docs/guide.md', 'src/app.ts', 'star*.txt'] });
      expect(repo.git('log', '-1', '--format=%B').trim()).toBe('feat(#7): Add thing\n\nSummary from the agent.');
      expect(repo.git('show', '--name-status', '--format=', 'HEAD')).toBe('D\tdocs/guide.md\nM\tsrc/app.ts\nA\tstar*.txt\n');
      expect(repo.git('status', '--porcelain')).toBe('');
      expect(repo.git('rev-parse', 'HEAD').trim()).toBe(result.ok ? result.sha : '');
    });

    it('stages names with glob and pathspec characters as exact names', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      for (const name of ['[ab].txt', ':(top)odd.txt', 'src/*.ts']) repo.write(name, 'x');

      expect(await git.commitTouched(repo.dir, snapshot, 'msg')).toMatchObject({
        ok: true,
        files: [':(top)odd.txt', '[ab].txt', 'src/*.ts'],
      });
      expect(repo.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
        ':(top)odd.txt',
        '[ab].txt',
        'src/*.ts',
      ]);
      expect(repo.git('status', '--porcelain')).toBe('');
    });

    it('reports nothing to commit', async () => {
      const repo = makeRepo();
      expect(await git.commitTouched(repo.dir, await snap(repo), 'msg')).toEqual({ ok: true, sha: null, files: [] });
    });

    it('keeps the work and the index unchanged when a hook rejects the commit', async () => {
      const repo = makeRepo();
      const snapshot = await snap(repo);
      repo.write('.git/hooks/pre-commit', '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
      fs.chmodSync(path.join(repo.dir, '.git/hooks/pre-commit'), 0o755);
      repo.write('src/app.ts', 'export const app = 2;\n');

      const result = await git.commitTouched(repo.dir, snapshot, 'msg');
      expect(result).toEqual({ ok: false, error: 'lint failed' });
      expect(repo.git('rev-parse', 'HEAD').trim()).toBe(snapshot.head);
      expect(repo.git('diff', '--cached', '--name-only')).toBe('');
      expect(repo.read('src/app.ts')).toBe('export const app = 2;\n');
    });
  });

  describe('push', () => {
    it('pushes the branch to origin', async () => {
      const repo = makeRepo();
      const remote = repo.addRemote();
      repo.write('src/app.ts', 'v2\n');
      repo.git('commit', '-q', '-am', 'v2');

      expect(await git.push(repo.dir, 'develop')).toEqual({ ok: true });
      expect(repo.git('--git-dir', remote, 'rev-parse', 'develop').trim()).toBe(repo.git('rev-parse', 'HEAD').trim());
    });

    it('reports a rejected push and keeps the local commit', async () => {
      const repo = makeRepo();
      const remote = repo.addRemote();
      // Someone else moved the remote branch first.
      const other = makeRepo();
      other.git('remote', 'add', 'origin', remote);
      other.git('fetch', '-q', 'origin');
      other.git('reset', '-q', '--hard', 'origin/develop');
      other.write('other.txt', 'x');
      other.git('add', 'other.txt');
      other.git('commit', '-q', '-m', 'other');
      other.git('push', '-q', 'origin', 'develop');

      repo.write('src/app.ts', 'mine\n');
      repo.git('commit', '-q', '-am', 'mine');
      const local = repo.git('rev-parse', 'HEAD').trim();

      const result = await git.push(repo.dir, 'develop');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(/rejected|failed to push/);
      expect(repo.git('rev-parse', 'HEAD').trim()).toBe(local);
    });

    it('reports a missing remote', async () => {
      const result = await git.push(makeRepo().dir, 'develop');
      expect(result).toMatchObject({ ok: false });
    });
  });

  describe('mergeInto (invariant 7)', () => {
    it('merges with a merge commit and returns to the working branch', async () => {
      const repo = makeRepo();
      repo.write('src/app.ts', 'feature\n');
      repo.git('commit', '-q', '-am', 'feature');

      const result = await git.mergeInto(repo.dir, 'develop', 'main', { push: false });
      expect(result).toMatchObject({ ok: true, pushed: false });
      expect(repo.git('branch', '--show-current').trim()).toBe('develop');
      expect(repo.git('rev-list', '--parents', '-n', '1', 'main').trim().split(' ')).toHaveLength(3);
      expect(repo.git('show', 'main:src/app.ts')).toBe('feature\n');
    });

    it('pushes the target when asked', async () => {
      const repo = makeRepo();
      const remote = repo.addRemote();
      repo.write('src/app.ts', 'feature\n');
      repo.git('commit', '-q', '-am', 'feature');

      const result = await git.mergeInto(repo.dir, 'develop', 'main', { push: true });
      expect(result).toMatchObject({ ok: true, pushed: true, pushError: null });
      expect(repo.git('--git-dir', remote, 'rev-parse', 'main').trim()).toBe(result.ok ? result.sha : '');
    });

    it('aborts a conflicting merge, keeps the commit and leaves main untouched', async () => {
      const repo = makeRepo();
      repo.git('checkout', '-q', 'main');
      repo.write('src/app.ts', 'main side\n');
      repo.git('commit', '-q', '-am', 'main change');
      const mainBefore = repo.git('rev-parse', 'main').trim();
      repo.git('checkout', '-q', 'develop');
      repo.write('src/app.ts', 'develop side\n');
      repo.git('commit', '-q', '-am', 'develop change');
      const developCommit = repo.git('rev-parse', 'HEAD').trim();

      const result = await git.mergeInto(repo.dir, 'develop', 'main', { push: false });
      expect(result).toMatchObject({ ok: false, conflict: true, files: ['src/app.ts'] });
      expect(repo.git('branch', '--show-current').trim()).toBe('develop');
      expect(repo.git('rev-parse', 'HEAD').trim()).toBe(developCommit);
      expect(repo.git('rev-parse', 'main').trim()).toBe(mainBefore);
      expect(repo.git('status', '--porcelain')).toBe('');
      expect(repo.exists('.git/MERGE_HEAD')).toBe(false);
    });

    it('refuses to merge from a dirty tree or into a missing branch', async () => {
      const repo = makeRepo();
      expect(await git.mergeInto(repo.dir, 'develop', 'release', { push: false })).toMatchObject({
        ok: false,
        error: 'There is no local branch release',
      });
      repo.write('wip.txt', 'x');
      expect(await git.mergeInto(repo.dir, 'develop', 'main', { push: false })).toMatchObject({
        ok: false,
        error: 'The working tree must be clean to merge',
      });
    });
  });
});
