import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ClaudeCliAgent } from './infra/claudeCli/claudeCliAgent';
import { EventHub } from './infra/events/eventHub';
import { ProcessSupervisor } from './infra/process/processSupervisor';
import { MIGRATIONS_DIR, openDatabase } from './infra/sqlite/database';
import { SqliteProjectRepo } from './infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from './infra/sqlite/sqliteRunRepo';
import { SqliteTaskRepo } from './infra/sqlite/sqliteTaskRepo';
import type { Logger } from './services/ports';
import { Scheduler } from './services/scheduler';

// Invariant 8: never bind to anything but loopback.
const HOST = '127.0.0.1';
const PORT = Number(process.env.KANBAN_PORT ?? 4317);
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const PROMPT_TEMPLATE = fileURLToPath(new URL('./services/prompts/task.md', import.meta.url));
const RUN_TIMEOUT_MS = Number(process.env.KANBAN_RUN_TIMEOUT_MS ?? 30 * 60_000);

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  const log: Logger = {
    info: (msg) => app.log.info(msg),
    error: (msg, err) => app.log.error({ err }, msg),
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDatabase(`${DATA_DIR}kanban.db`, MIGRATIONS_DIR);
  const clock = () => new Date().toISOString();
  const projects = new SqliteProjectRepo(db, clock);
  const tasks = new SqliteTaskRepo(db, clock);
  const runs = new SqliteRunRepo(db, clock);

  const supervisor = new ProcessSupervisor();
  const hub = new EventHub();
  const scheduler = new Scheduler(projects, tasks, runs, new ClaudeCliAgent(supervisor), hub, log, {
    promptTemplate: fs.readFileSync(PROMPT_TEMPLATE, 'utf8'),
    runTimeoutMs: RUN_TIMEOUT_MS,
    newSessionId: () => crypto.randomUUID(),
  });

  // Invariant 9: no agent outlives the server.
  process.on('exit', () => supervisor.killAll());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      supervisor.killAll();
      void app.close().finally(() => process.exit(0));
    });
  }

  app.get('/api/health', async () => ({ ok: true }));

  scheduler.recoverInterrupted();
  await app.listen({ host: HOST, port: PORT });
  void scheduler.kickAll();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
