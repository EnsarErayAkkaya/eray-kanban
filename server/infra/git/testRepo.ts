import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The user's global git config (hooks, signing, aliases) must not leak into tests.
export const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export interface TestRepo {
  readonly dir: string;
  git(...args: string[]): string;
  write(file: string, content: string | Buffer): void;
  read(file: string): string;
  exists(file: string): boolean;
  remove(file: string): void;
  /** Every file outside .git, ignored ones included, with a content hash. */
  hashes(): Record<string, string>;
  addRemote(): string;
}

const roots: string[] = [];

export function cleanupRepos(): void {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: HERMETIC_GIT_ENV, encoding: 'utf8' });
}

function walk(root: string, rel = ''): string[] {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (child === '.git') return [];
    return entry.isDirectory() ? [`${child}/`, ...walk(root, child)] : [child];
  });
}

export function makeRepo(): TestRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-git-')));
  roots.push(root);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir);

  const repo: TestRepo = {
    dir,
    git: (...args) => gitIn(dir, args),
    write: (file, content) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    },
    read: (file) => fs.readFileSync(path.join(dir, file), 'utf8'),
    exists: (file) => fs.existsSync(path.join(dir, file)),
    remove: (file) => fs.rmSync(path.join(dir, file), { recursive: true }),
    hashes: () =>
      Object.fromEntries(
        walk(dir).map((f) => [
          f,
          f.endsWith('/') ? 'dir' : crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex'),
        ]),
      ),
    addRemote: () => {
      const remote = path.join(root, 'remote.git');
      gitIn(root, ['init', '-q', '--bare', remote]);
      repo.git('remote', 'add', 'origin', remote);
      repo.git('push', '-q', 'origin', 'develop', 'main');
      return remote;
    },
  };

  repo.git('init', '-q', '-b', 'main');
  repo.git('config', 'user.name', 'Test User');
  repo.git('config', 'user.email', 'test@example.com');
  repo.write('.gitignore', 'node_modules/\n*.log\n.env\n');
  repo.write('README.md', '# Demo\n');
  repo.write('src/app.ts', 'export const app = 1;\n');
  repo.write('src/util.ts', 'export const util = 1;\n');
  repo.write('docs/guide.md', 'Guide\n');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'init');
  repo.git('branch', 'develop');
  repo.git('checkout', '-q', 'develop');
  // Ignored files a rollback must never touch (invariant 5).
  repo.write('.env', 'SECRET=1\n');
  repo.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
  repo.write('debug.log', 'log\n');
  return repo;
}
