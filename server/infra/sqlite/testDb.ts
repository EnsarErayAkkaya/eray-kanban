import type { Database } from 'better-sqlite3';
import { CreateProjectInput, type Project } from '@shared/project';
import type { Clock, NewTask } from '../../services/ports';
import { MIGRATIONS_DIR, openDatabase } from './database';
import { SqliteProjectRepo } from './sqliteProjectRepo';

export function memoryDb(): Database {
  return openDatabase(':memory:', MIGRATIONS_DIR);
}

export function fakeClock(start = '2026-10-16T09:00:00.000Z'): Clock {
  let t = Date.parse(start);
  return () => new Date((t += 1000)).toISOString();
}

export function seedProject(db: Database, clock: Clock, name = 'web-app'): Project {
  return new SqliteProjectRepo(db, clock).create(
    CreateProjectInput.parse({ name, repoPath: `/repos/${name}`, workingBranch: 'develop' }),
  );
}

export function newTask(projectId: number, overrides: Partial<NewTask> = {}): NewTask {
  return {
    projectId,
    title: 'Add settings page',
    description: '',
    acceptanceCriteria: '',
    priority: 'normal',
    visual: false,
    routes: [],
    model: 'sonnet',
    turnLimit: 30,
    dependsOn: null,
    ...overrides,
  };
}
