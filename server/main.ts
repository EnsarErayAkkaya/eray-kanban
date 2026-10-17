import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericAdapter } from './adapters/generic/genericAdapter';
import { CommandRunner } from './adapters/shared/commandRunner';
import { DevServerManager } from './adapters/web/devServer';
import { Screenshotter } from './adapters/web/screenshotter';
import { WebAdapter } from './adapters/web/webAdapter';
import { buildServer } from './api/buildServer';
import { ClaudeCliAgent } from './infra/claudeCli/claudeCliAgent';
import { EventHub } from './infra/events/eventHub';
import { FsMemoryFiles } from './infra/fs/memoryFiles';
import { FsRepoProbe } from './infra/fs/repoProbe';
import { writeControlToken } from './infra/fs/controlToken';
import { FsScreenshotFiles } from './infra/fs/screenshotFiles';
import { LinuxNotifier } from './infra/notify/linuxNotifier';
import { MacNotifier } from './infra/notify/macNotifier';
import { SilentNotifier } from './infra/notify/silentNotifier';
import { WindowsNotifier } from './infra/notify/windowsNotifier';
import { GitService } from './infra/git/gitService';
import { hostProcessPlatform } from './infra/process/processPlatform';
import { ProcessSupervisor } from './infra/process/processSupervisor';
import { MIGRATIONS_DIR, openDatabase } from './infra/sqlite/database';
import { SqliteCheckRepo } from './infra/sqlite/sqliteCheckRepo';
import { SqliteProjectRepo } from './infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from './infra/sqlite/sqliteRunRepo';
import { SqliteScreenshotRepo } from './infra/sqlite/sqliteScreenshotRepo';
import { SqliteSnapshotRepo } from './infra/sqlite/sqliteSnapshotRepo';
import { SqliteTaskRepo } from './infra/sqlite/sqliteTaskRepo';
import { SqliteTemplateRepo } from './infra/sqlite/sqliteTemplateRepo';
import type { AdapterRegistry, Logger, Notifier } from './services/ports';
import { MemoryService } from './services/memoryService';
import { ProjectService } from './services/projectService';
import { ReviewService } from './services/reviewService';
import { Scheduler } from './services/scheduler';
import { TaskService } from './services/taskService';
import { TemplateService } from './services/templateService';

// Invariant 8: never bind to anything but loopback.
const HOST = '127.0.0.1';
const PORT = Number(process.env.KANBAN_PORT ?? 4317);
const UI_DEV_PORT = Number(process.env.KANBAN_UI_PORT ?? 5173);
const DATA_DIR = process.env.KANBAN_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
const SCREENSHOTS_DIR = process.env.KANBAN_SCREENSHOTS_DIR ?? fileURLToPath(new URL('../screenshots/', import.meta.url));
const NOTIFY = process.env.KANBAN_NOTIFY !== '0';
const UI_DIR = fileURLToPath(new URL('../dist/ui/', import.meta.url));
const prompt = (name: string) => fileURLToPath(new URL(`./services/prompts/${name}`, import.meta.url));
const RUN_TIMEOUT_MS = Number(process.env.KANBAN_RUN_TIMEOUT_MS ?? 30 * 60_000);
const NOTIFIERS: Partial<Record<NodeJS.Platform, new (supervisor: ProcessSupervisor, log: Logger) => Notifier>> = {
  darwin: MacNotifier,
  linux: LinuxNotifier,
  win32: WindowsNotifier,
};

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDatabase(path.join(DATA_DIR, 'kanban.db'), MIGRATIONS_DIR);
  const clock = () => new Date().toISOString();
  const projectRepo = new SqliteProjectRepo(db, clock);
  const taskRepo = new SqliteTaskRepo(db, clock);
  const runRepo = new SqliteRunRepo(db, clock);
  const control = writeControlToken(DATA_DIR);

  const supervisor = new ProcessSupervisor(5_000, hostProcessPlatform());
  const HostNotifier = NOTIFY ? NOTIFIERS[process.platform] : undefined;
  const hub = new EventHub();
  // The scheduler needs a logger before the server that owns it exists.
  const logRef: { current?: Logger } = {};
  const log: Logger = {
    info: (msg) => logRef.current?.info(msg),
    error: (msg, err) => logRef.current?.error(msg, err),
  };
  const snapshotRepo = new SqliteSnapshotRepo(db, clock);
  const checkRepo = new SqliteCheckRepo(db);
  const git = new GitService(supervisor);
  const screenshotRepo = new SqliteScreenshotRepo(db, clock);
  const commands = new CommandRunner(supervisor);
  const adapters: AdapterRegistry = {
    web: new WebAdapter(commands, new DevServerManager(supervisor), new Screenshotter(), SCREENSHOTS_DIR),
    generic: new GenericAdapter(commands),
  };
  const scheduler = new Scheduler(
    {
      projects: projectRepo,
      tasks: taskRepo,
      runs: runRepo,
      snapshots: snapshotRepo,
      checks: checkRepo,
      screenshots: screenshotRepo,
      agent: new ClaudeCliAgent(supervisor),
      git,
      adapters,
      notifier: HostNotifier ? new HostNotifier(supervisor, log) : new SilentNotifier(),
      events: hub,
      log,
    },
    {
      taskTemplate: fs.readFileSync(prompt('task.md'), 'utf8'),
      feedbackTemplate: fs.readFileSync(prompt('feedback.md'), 'utf8'),
      answerTemplate: fs.readFileSync(prompt('answer.md'), 'utf8'),
      checkFixTemplate: fs.readFileSync(prompt('checkFix.md'), 'utf8'),
      runTimeoutMs: RUN_TIMEOUT_MS,
      newSessionId: () => crypto.randomUUID(),
    },
  );

  const app = buildServer(
    {
      projects: new ProjectService(projectRepo, taskRepo, new FsRepoProbe(), scheduler, runRepo, git, hub),
      tasks: new TaskService(projectRepo, taskRepo, runRepo, snapshotRepo, scheduler, hub),
      review: new ReviewService({
        projects: projectRepo,
        tasks: taskRepo,
        runs: runRepo,
        checks: checkRepo,
        screenshots: screenshotRepo,
        screenshotFiles: new FsScreenshotFiles(SCREENSHOTS_DIR),
        snapshots: snapshotRepo,
        git,
        scheduler,
        events: hub,
      }),
      templates: new TemplateService(projectRepo, new SqliteTemplateRepo(db, clock)),
      memory: new MemoryService(projectRepo, taskRepo, new FsMemoryFiles(), clock),
      control: { token: control.token, shutdown: () => shutdown() },
      subscribe: (listener) => hub.subscribe(listener),
      heartbeatMs: 25_000,
    },
    {
      logger: true,
      allowedPorts: [PORT, UI_DEV_PORT],
      uiRoot: fs.existsSync(path.join(UI_DIR, 'index.html')) ? UI_DIR : null,
    },
  );
  logRef.current = { info: (msg) => app.log.info(msg), error: (msg, err) => app.log.error({ err }, msg) };

  // Invariant 9: no agent outlives the server.
  process.on('exit', () => {
    supervisor.killAll();
    control.remove();
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    supervisor.killAll();
    void app.close().finally(() => process.exit(0));
  };
  // SIGHUP is how Windows reports a closed console window, and Linux a closed terminal.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, shutdown);

  scheduler.recoverInterrupted();
  await app.listen({ host: HOST, port: PORT });
  void scheduler.kickAll();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
