import { fileURLToPath } from 'node:url';
import Sqlite, { type Database } from 'better-sqlite3';
import { migrate } from './migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

export function openDatabase(file: string, migrationsDir: string): Database {
  const db = new Sqlite(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrationsDir);
  return db;
}
