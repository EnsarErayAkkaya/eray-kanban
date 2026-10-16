import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

function readMigrations(dir: string): Migration[] {
  const migrations = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      const match = FILE_PATTERN.exec(name);
      if (!match?.[1]) throw new Error(`Bad migration file name: ${name} (want NNN_name.sql)`);
      return { version: Number(match[1]), name, sql: fs.readFileSync(path.join(dir, name), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration ${m.name} breaks the 001, 002, ... sequence`);
  });
  return migrations;
}

// Returns the names of the migrations applied by this call.
export function migrate(db: Database, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);

  const applied = new Map(
    db
      .prepare<[], { version: number; name: string }>('SELECT version, name FROM schema_migrations')
      .all()
      .map((r) => [r.version, r.name]),
  );
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const ran: string[] = [];

  for (const m of readMigrations(dir)) {
    const appliedName = applied.get(m.version);
    if (appliedName !== undefined) {
      if (appliedName !== m.name) throw new Error(`Migration ${m.version} was applied as ${appliedName}, now ${m.name}`);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    })();
    ran.push(m.name);
  }
  return ran;
}
