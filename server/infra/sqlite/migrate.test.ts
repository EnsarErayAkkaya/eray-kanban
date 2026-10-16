import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from './database';
import { migrate } from './migrate';

const tempDirs: string[] = [];

function migrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-migrations-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

const tableNames = (db: Sqlite.Database) =>
  db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrate', () => {
  it('applies the real migrations once', () => {
    const db = new Sqlite(':memory:');
    expect(migrate(db, MIGRATIONS_DIR)).toEqual(['001_init.sql']);
    expect(migrate(db, MIGRATIONS_DIR)).toEqual([]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['projects', 'tasks', 'runs', 'run_log', 'schema_migrations']));
  });

  it('applies only migrations newer than the last applied one', () => {
    const db = new Sqlite(':memory:');
    const one = { '001_a.sql': 'CREATE TABLE a (x);' };
    migrate(db, migrationsDir(one));
    expect(migrate(db, migrationsDir({ ...one, '002_b.sql': 'CREATE TABLE b (x);' }))).toEqual(['002_b.sql']);
  });

  it('rolls back a failing migration and does not record it', () => {
    const db = new Sqlite(':memory:');
    const dir = migrationsDir({ '001_bad.sql': 'CREATE TABLE ok (x); CREATE TABLE broken (' });
    expect(() => migrate(db, dir)).toThrow();
    expect(tableNames(db)).toEqual(['schema_migrations']);
  });

  it('rejects badly named files', () => {
    expect(() => migrate(new Sqlite(':memory:'), migrationsDir({ 'init.sql': '' }))).toThrow(/Bad migration file name/);
  });

  it('rejects a gap in the sequence', () => {
    const dir = migrationsDir({ '001_a.sql': '', '003_c.sql': '' });
    expect(() => migrate(new Sqlite(':memory:'), dir)).toThrow(/sequence/);
  });

  it('refuses to run when an applied migration was renamed', () => {
    const db = new Sqlite(':memory:');
    migrate(db, migrationsDir({ '001_a.sql': 'CREATE TABLE a (x);' }));
    expect(() => migrate(db, migrationsDir({ '001_renamed.sql': 'CREATE TABLE a (x);' }))).toThrow(/was applied as/);
  });
});
