import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@shared/events';
import type { Project } from '@shared/project';
import type { Task } from '@shared/task';
import { transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from '../infra/sqlite/testDb';
import type { AgentEvent, AgentExit, AgentPort, AgentRequest, AgentResult, Logger } from './ports';
import { Scheduler } from './scheduler';

// Repos run on in-memory SQLite; the agent, board events and logger are fakes.
type Script = (onEvent: (e: AgentEvent) => void, signal: AbortSignal) => Promise<AgentExit>;

class FakeAgent implements AgentPort {
  readonly calls: AgentRequest[] = [];
  readonly killed: Array<[number, string]> = [];
  constructor(public script: Script) {}
  run(req: AgentRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<AgentExit> {
    this.calls.push(req);
    return this.script(onEvent, signal);
  }
  killOrphan(pid: number, sessionId: string): boolean {
    this.killed.push([pid, sessionId]);
    return true;
  }
}

const fence = (json: object) => '```json\n' + JSON.stringify(json) + '\n```';
const DONE = fence({ outcome: 'done', summary: 'Added /settings' });

function result(text: string, subtype = 'success'): AgentResult {
  return {
    subtype,
    isError: subtype !== 'success',
    sessionId: 'sess-1',
    text,
    usage: { numTurns: 3, inputTokens: 10, outputTokens: 200, cacheCreationTokens: 1000, cacheReadTokens: 5000, costUsd: 0.02 },
  };
}

const finishWith = (exit: AgentExit): Script => async (onEvent) => {
  onEvent({ type: 'spawned', pid: 4242 });
  onEvent({ type: 'session', sessionId: 'sess-1' });
  onEvent({ type: 'log', line: { kind: 'tool_use', text: 'Write settings.tsx' } });
  return exit;
};

const waitForAbort: Script = (_onEvent, signal) =>
  new Promise((resolve) => signal.addEventListener('abort', () => resolve({ kind: 'cancelled' })));

describe('Scheduler', () => {
  let db: Database;
  let tasks: SqliteTaskRepo;
  let runs: SqliteRunRepo;
  let project: Project;
  let agent: FakeAgent;
  let events: BoardEvent[];
  let errors: string[];
  let sessions: number;
  let scheduler: Scheduler;

  const todo = (overrides: Parameters<typeof newTask>[1] = {}, projectId = project.id): Task =>
    tasks.applyStatusChange(transition(tasks.create(newTask(projectId, overrides)), 'promote'));
  const statusOf = (id: number) => tasks.get(id)?.status;
  const logTexts = (taskId: number) =>
    runs.listByTask(taskId).flatMap((r) => runs.logAfter(r.id, 0).map((l) => `${l.kind}: ${l.text}`));

  beforeEach(() => {
    const clock = fakeClock();
    db = memoryDb();
    const projects = new SqliteProjectRepo(db, clock);
    tasks = new SqliteTaskRepo(db, clock);
    runs = new SqliteRunRepo(db, clock);
    project = projects.update(seedProject(db, clock).id, { allowedCommands: ['npm run test'] });
    agent = new FakeAgent(finishWith({ kind: 'result', result: result(DONE) }));
    events = [];
    errors = [];
    sessions = 0;
    const log: Logger = { info: () => undefined, error: (msg) => errors.push(msg) };
    scheduler = new Scheduler(projects, tasks, runs, agent, { publish: (e) => events.push(e) }, log, {
      promptTemplate: '# Task #{{id}}: {{title}}',
      runTimeoutMs: 60_000,
      newSessionId: () => `new-session-${++sessions}`,
    });
  });

  it('runs the top Todo task and sends it to review', async () => {
    const task = todo({ title: 'Add settings page', model: 'opus', turnLimit: 12 });
    await scheduler.kick(project.id);

    expect(agent.calls).toEqual([
      {
        cwd: '/repos/web-app',
        prompt: `# Task #${task.id}: Add settings page`,
        model: 'opus',
        maxTurns: 12,
        allowedCommands: ['npm run test'],
        sessionId: 'new-session-1',
        resume: false,
        timeoutMs: 60_000,
      },
    ]);
    expect(statusOf(task.id)).toBe('in_review');
    const [run] = runs.listByTask(task.id);
    expect(run).toMatchObject({
      kind: 'initial',
      outcome: 'completed',
      sessionId: 'sess-1',
      pid: 4242,
      numTurns: 3,
      costUsd: 0.02,
    });
    expect(logTexts(task.id)).toEqual(['tool_use: Write settings.tsx']);
  });

  it('publishes task, run and log events in order', async () => {
    todo();
    await scheduler.kick(project.id);
    expect(events.map((e) => (e.type === 'task' ? `task:${e.task.status}` : e.type === 'run' ? `run:${e.run.outcome}` : 'log'))).toEqual([
      'task:in_progress',
      'run:running',
      'log',
      'run:completed',
      'task:in_review',
    ]);
  });

  it('moves the task to Needs Input when the agent asks a question', async () => {
    agent.script = finishWith({ kind: 'result', result: result(fence({ outcome: 'needs_input', question: 'Which route?' })) });
    const task = todo();
    await scheduler.kick(project.id);
    expect(statusOf(task.id)).toBe('needs_input');
    expect(logTexts(task.id)).toContain('system: Question: Which route?');
  });

  it('still sends the task to review when the review JSON is missing', async () => {
    agent.script = finishWith({ kind: 'result', result: result('All done!') });
    const task = todo();
    await scheduler.kick(project.id);
    expect(statusOf(task.id)).toBe('in_review');
    expect(logTexts(task.id)).toContain('error: No review JSON block found');
  });

  it.each([
    [{ kind: 'result', result: result('', 'error_max_turns') }, 'turn_limit', null],
    [{ kind: 'result', result: result('', 'error_during_execution') }, 'failed', 'CLI ended with error_during_execution'],
    [{ kind: 'timeout' }, 'timed_out', 'Run hit its time limit and was killed'],
    [{ kind: 'crashed', error: 'Not logged in' }, 'failed', 'Not logged in'],
  ] as const)('records %j as %s and sends the task to review', async (exit, outcome, error) => {
    agent.script = finishWith(exit);
    const task = todo();
    await scheduler.kick(project.id);
    expect(runs.listByTask(task.id)[0]).toMatchObject({ outcome, error });
    expect(statusOf(task.id)).toBe('in_review');
  });

  it('records an agent that throws as a failed run', async () => {
    agent.script = () => Promise.reject(new Error('spawn exploded'));
    const task = todo();
    await scheduler.kick(project.id);
    expect(runs.listByTask(task.id)[0]).toMatchObject({ outcome: 'failed', error: 'spawn exploded' });
    expect(statusOf(task.id)).toBe('in_review');
  });

  it('stop() kills the run and sends the task to review', async () => {
    agent.script = waitForAbort;
    const task = todo();
    const worker = scheduler.kick(project.id);
    expect(scheduler.stop(task.id)).toBe(true);
    await worker;
    expect(runs.listByTask(task.id)[0]?.outcome).toBe('stopped');
    expect(statusOf(task.id)).toBe('in_review');
    expect(scheduler.stop(task.id)).toBe(false);
  });

  it('does nothing when the project has no Todo task', async () => {
    tasks.create(newTask(project.id));
    await scheduler.kick(project.id);
    expect(agent.calls).toHaveLength(0);
  });

  it('keeps the project paused while a task is in review (invariant 3)', async () => {
    const first = todo({ title: 'first' });
    const second = todo({ title: 'second' });
    await scheduler.kick(project.id);
    await scheduler.kick(project.id);
    expect(agent.calls).toHaveLength(1);
    expect(statusOf(first.id)).toBe('in_review');
    expect(statusOf(second.id)).toBe('todo');
  });

  it('runs one worker per project even when kicked twice at once', async () => {
    agent.script = waitForAbort;
    const task = todo();
    todo();
    const a = scheduler.kick(project.id);
    const b = scheduler.kick(project.id);
    expect(agent.calls).toHaveLength(1);
    scheduler.stop(task.id);
    await Promise.all([a, b]);
  });

  it('runs different projects in parallel', async () => {
    agent.script = waitForAbort;
    const other = seedProject(db, fakeClock(), 'api');
    const a = todo({}, project.id);
    const b = todo({}, other.id);
    const workers = scheduler.kickAll();
    expect(agent.calls.map((c) => c.cwd).sort()).toEqual(['/repos/api', '/repos/web-app']);
    scheduler.stop(a.id);
    scheduler.stop(b.id);
    await workers;
  });

  it('recovers runs left running by a crash', () => {
    const task = tasks.applyStatusChange(transition(todo(), 'start'));
    const run = runs.start({ taskId: task.id, sessionId: 'sess-old', kind: 'initial', model: 'sonnet', turnLimit: 30, input: 'x' });
    runs.setPid(run.id, 999);

    scheduler.recoverInterrupted();

    expect(agent.killed).toEqual([[999, 'sess-old']]);
    expect(runs.get(run.id)).toMatchObject({ outcome: 'failed', error: 'Server stopped during the run' });
    expect(statusOf(task.id)).toBe('in_review');
  });

  it('leaves the task alone if it was moved while the agent ran', async () => {
    const task = todo();
    agent.script = async () => {
      tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, 'cancel'));
      return { kind: 'result', result: result(DONE) };
    };
    await scheduler.kick(project.id);
    expect(statusOf(task.id)).toBe('cancelled');
    expect(errors).toEqual([]);
  });
});
