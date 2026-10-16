import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './api/buildServer';
import { ClaudeCliAgent } from './infra/claudeCli/claudeCliAgent';
import { EventHub } from './infra/events/eventHub';
import { FsRepoProbe } from './infra/fs/repoProbe';
import { GitService } from './infra/git/gitService';
import { ProcessSupervisor } from './infra/process/processSupervisor';
import { MIGRATIONS_DIR, openDatabase } from './infra/sqlite/database';
import { SqliteProjectRepo } from './infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from './infra/sqlite/sqliteRunRepo';
import { SqliteSnapshotRepo } from './infra/sqlite/sqliteSnapshotRepo';
import { SqliteTaskRepo } from './infra/sqlite/sqliteTaskRepo';
import type { Logger } from './services/ports';
import { ProjectService } from './services/projectService';
import { ReviewService } from './services/reviewService';
import { Scheduler } from './services/scheduler';
import { TaskService } from './services/taskService';

// Invariant 8: never bind to anything but loopback.
const HOST = '127.0.0.1';
const PORT = Number(process.env.KANBAN_PORT ?? 4317);
const UI_DEV_PORT = Number(process.env.KANBAN_UI_PORT ?? 5173);
const DATA_DIR = process.env.KANBAN_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
const prompt = (name: string) => fileURLToPath(new URL(`./services/prompts/${name}`, import.meta.url));
const RUN_TIMEOUT_MS = Number(process.env.KANBAN_RUN_TIMEOUT_MS ?? 30 * 60_000);

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDatabase(path.join(DATA_DIR, 'kanban.db'), MIGRATIONS_DIR);
  const clock = () => new Date().toISOString();
  const projectRepo = new SqliteProjectRepo(db, clock);
  const taskRepo = new SqliteTaskRepo(db, clock);
  const runRepo = new SqliteRunRepo(db, clock);

  const supervisor = new ProcessSupervisor();
  const hub = new EventHub();
  // The scheduler needs a logger before the server that owns it exists.
  const logRef: { current?: Logger } = {};
  const log: Logger = {
    info: (msg) => logRef.current?.info(msg),
    error: (msg, err) => logRef.current?.error(msg, err),
  };
  const snapshotRepo = new SqliteSnapshotRepo(db, clock);
  const git = new GitService(supervisor);
  const scheduler = new Scheduler(
    {
      projects: projectRepo,
      tasks: taskRepo,
      runs: runRepo,
      snapshots: snapshotRepo,
      agent: new ClaudeCliAgent(supervisor),
      git,
      events: hub,
      log,
    },
    {
      taskTemplate: fs.readFileSync(prompt('task.md'), 'utf8'),
      feedbackTemplate: fs.readFileSync(prompt('feedback.md'), 'utf8'),
      runTimeoutMs: RUN_TIMEOUT_MS,
      newSessionId: () => crypto.randomUUID(),
    },
  );

  const app = buildServer(
    {
      projects: new ProjectService(projectRepo, taskRepo, new FsRepoProbe(), scheduler),
      tasks: new TaskService(projectRepo, taskRepo, runRepo, scheduler, hub),
      review: new ReviewService({
        projects: projectRepo,
        tasks: taskRepo,
        runs: runRepo,
        snapshots: snapshotRepo,
        git,
        scheduler,
        events: hub,
      }),
      subscribe: (listener) => hub.subscribe(listener),
      heartbeatMs: 25_000,
    },
    { logger: true, allowedPorts: [PORT, UI_DEV_PORT] },
  );
  logRef.current = { info: (msg) => app.log.info(msg), error: (msg, err) => app.log.error({ err }, msg) };

  // Invariant 9: no agent outlives the server.
  process.on('exit', () => supervisor.killAll());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      supervisor.killAll();
      void app.close().finally(() => process.exit(0));
    });
  }

  scheduler.recoverInterrupted();
  await app.listen({ host: HOST, port: PORT });
  void scheduler.kickAll();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
