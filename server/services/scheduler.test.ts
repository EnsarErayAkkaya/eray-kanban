import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@shared/events';
import type { Project } from '@shared/project';
import type { Task } from '@shared/task';
import { transition } from '../domain/taskMachine';
import { SqliteProjectRepo } from '../infra/sqlite/sqliteProjectRepo';
import { SqliteCheckRepo } from '../infra/sqlite/sqliteCheckRepo';
import { SqliteRunRepo } from '../infra/sqlite/sqliteRunRepo';
import { SqliteSnapshotRepo } from '../infra/sqlite/sqliteSnapshotRepo';
import { SqliteTaskRepo } from '../infra/sqlite/sqliteTaskRepo';
import { fakeClock, memoryDb, newTask, seedProject } from '../infra/sqlite/testDb';
import type { AgentEvent, AgentExit, AgentPort, AgentRequest, AgentResult, Logger } from './ports';
import { Scheduler } from './scheduler';
import { FakeAdapter, FakeGit, SNAPSHOT, failedCheck, passedCheck } from './testFakes';

// Repos run on in-memory SQLite; the agent, git, board events and logger are fakes.
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

// Pickup awaits the git check, so the agent starts a few microtasks after kick().
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Scheduler', () => {
  let db: Database;
  let tasks: SqliteTaskRepo;
  let runs: SqliteRunRepo;
  let project: Project;
  let agent: FakeAgent;
  let events: BoardEvent[];
  let errors: string[];
  let sessions: number;
  let git: FakeGit;
  let snapshots: SqliteSnapshotRepo;
  let checks: SqliteCheckRepo;
  let adapter: FakeAdapter;
  let projectRepo: SqliteProjectRepo;
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
    git = new FakeGit();
    snapshots = new SqliteSnapshotRepo(db, clock);
    checks = new SqliteCheckRepo(db);
    adapter = new FakeAdapter();
    projectRepo = projects;
    const log: Logger = { info: () => undefined, error: (msg) => errors.push(msg) };
    scheduler = new Scheduler(
      {
        projects,
        tasks,
        runs,
        snapshots,
        checks,
        agent,
        git,
        adapters: { web: adapter, generic: adapter },
        events: { publish: (e) => events.push(e) },
        log,
      },
      {
        taskTemplate: '# Task #{{id}}: {{title}}',
        feedbackTemplate: 'Feedback on #{{id}}: {{feedback}}',
        checkFixTemplate: 'Fix #{{id}}:\n{{failures}}',
        runTimeoutMs: 60_000,
        newSessionId: () => `new-session-${++sessions}`,
      },
    );
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
    await settle();
    expect(scheduler.stop(task.id)).toBe(true);
    await worker;
    expect(runs.listByTask(task.id)[0]?.outcome).toBe('stopped');
    expect(statusOf(task.id)).toBe('in_review');
    expect(scheduler.stop(task.id)).toBe(false);
  });

  it('stopAndWait resolves only after the stopped run moved the task to review', async () => {
    agent.script = waitForAbort;
    const task = todo();
    void scheduler.kick(project.id);
    await settle();
    await scheduler.stopAndWait(task.id);
    expect(statusOf(task.id)).toBe('in_review');
    expect(runs.listByTask(task.id)[0]?.outcome).toBe('stopped');
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
    await settle();
    expect(agent.calls).toHaveLength(1);
    expect(git.snapshotCalls).toHaveLength(1);
    scheduler.stop(task.id);
    await Promise.all([a, b]);
  });

  it('runs different projects in parallel', async () => {
    agent.script = waitForAbort;
    const other = seedProject(db, fakeClock(), 'api');
    const a = todo({}, project.id);
    const b = todo({}, other.id);
    const workers = scheduler.kickAll();
    await settle();
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

  describe('pickup (invariant 4)', () => {
    it('saves the snapshot before the agent starts', async () => {
      const task = todo();
      let snapshotAtStart: unknown;
      agent.script = async () => {
        snapshotAtStart = snapshots.get(task.id);
        return { kind: 'result', result: result(DONE) };
      };
      await scheduler.kick(project.id);
      expect(git.snapshotCalls).toEqual([['/repos/web-app', 'develop']]);
      expect(snapshotAtStart).toEqual(SNAPSHOT);
    });

    it('waits on a dirty tree or wrong branch, tells the board why, and starts once fixed', async () => {
      git.snapshotResult = { ok: false, reason: 'wrong_branch', detail: 'Repo is on main, expected develop' };
      const task = todo();
      await scheduler.kick(project.id);

      expect(agent.calls).toHaveLength(0);
      expect(statusOf(task.id)).toBe('todo');
      expect(scheduler.statuses()).toEqual([{ projectId: project.id, blocked: 'Repo is on main, expected develop' }]);
      expect(events).toContainEqual({ type: 'projectStatus', projectId: project.id, blocked: 'Repo is on main, expected develop' });

      git.snapshotResult = { ok: true, snapshot: SNAPSHOT };
      await scheduler.kick(project.id);
      expect(agent.calls).toHaveLength(1);
      expect(scheduler.statuses()).toEqual([{ projectId: project.id, blocked: null }]);
      expect(events).toContainEqual({ type: 'projectStatus', projectId: project.id, blocked: null });
    });

    it('reports an unreadable repo as a block, not a crash', async () => {
      git.snapshotError = new Error('not a git repository');
      todo();
      await scheduler.kick(project.id);
      expect(scheduler.statuses()[0]?.blocked).toBe('Could not read the repo: not a git repository');
      expect(errors).toEqual([]);
    });

    it('publishes a block only when it changes', async () => {
      git.snapshotResult = { ok: false, reason: 'dirty', detail: 'Uncommitted changes: a.txt' };
      todo();
      await scheduler.kick(project.id);
      await scheduler.kick(project.id);
      expect(events.filter((e) => e.type === 'projectStatus')).toHaveLength(1);
    });

    it('does not start a task cancelled while the repo was being checked', async () => {
      const task = todo();
      const original = git.snapshot.bind(git);
      git.snapshot = async (repo, branch) => {
        tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, 'cancel'));
        return original(repo, branch);
      };
      await scheduler.kick(project.id);
      expect(agent.calls).toHaveLength(0);
      expect(statusOf(task.id)).toBe('cancelled');
      expect(errors).toEqual([]);
    });
  });

  describe('post-run guard', () => {
    it('flags the task when the agent touched git, and still sends it to review', async () => {
      git.guardProblems = ['HEAD moved from abc123 to def45678'];
      const task = todo();
      await scheduler.kick(project.id);

      expect(tasks.get(task.id)).toMatchObject({
        status: 'in_review',
        gitIssue: 'guard_tripped',
        gitIssueDetail: 'HEAD moved from abc123 to def45678',
      });
      expect(logTexts(task.id)).toContain('error: Git guard: HEAD moved from abc123 to def45678');
    });

    it('clears the flag when a later run leaves git alone', async () => {
      const task = todo();
      git.guardProblems = ['Changes were staged in the index'];
      await scheduler.kick(project.id);
      tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, 'reject'));

      git.guardProblems = [];
      await scheduler.resumeWithFeedback(task.id, 'unstage that');
      expect(tasks.get(task.id)).toMatchObject({ status: 'in_review', gitIssue: null, gitIssueDetail: null });
    });
  });

  it('stores the review JSON on the run', async () => {
    agent.script = finishWith({
      kind: 'result',
      result: result(fence({ outcome: 'done', summary: 'Added /settings', concerns: ['No tests for it'] })),
    });
    const task = todo();
    await scheduler.kick(project.id);
    expect(runs.listByTask(task.id)[0]?.review).toEqual({
      outcome: 'done',
      summary: 'Added /settings',
      notes: [],
      concerns: ['No tests for it'],
    });
  });

  describe('resumeWithFeedback', () => {
    const toReviewThenReject = async (task: Task) => {
      await scheduler.kick(project.id);
      tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, 'reject'));
    };

    it('resumes the same session with the feedback and returns to review', async () => {
      const task = todo();
      await toReviewThenReject(task);
      await scheduler.resumeWithFeedback(task.id, 'Use a toggle');

      expect(agent.calls.at(-1)).toMatchObject({
        prompt: `Feedback on #${task.id}: Use a toggle`,
        sessionId: 'sess-1',
        resume: true,
      });
      expect(runs.listByTask(task.id).map((r) => r.kind)).toEqual(['initial', 'feedback']);
      expect(statusOf(task.id)).toBe('in_review');
      // The snapshot from the first pickup stays; a reject takes no new one.
      expect(git.snapshotCalls).toHaveLength(1);
    });

    it('can be rejected twice', async () => {
      const task = todo();
      await toReviewThenReject(task);
      await scheduler.resumeWithFeedback(task.id, 'first');
      tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, 'reject'));
      await scheduler.resumeWithFeedback(task.id, 'second');
      expect(runs.listByTask(task.id).map((r) => r.kind)).toEqual(['initial', 'feedback', 'feedback']);
      expect(statusOf(task.id)).toBe('in_review');
    });

    it('sends the task back to review when there is no session to resume', async () => {
      const task = tasks.applyStatusChange(transition(todo(), 'start'));
      await scheduler.resumeWithFeedback(task.id, 'x');
      expect(agent.calls).toHaveLength(0);
      expect(statusOf(task.id)).toBe('in_review');
      expect(errors).toEqual([`Task ${task.id} has no session to resume`]);
    });

    it('waits for a worker that is still finishing', async () => {
      const task = todo();
      await toReviewThenReject(task);
      const kick = scheduler.kick(project.id);
      const resume = scheduler.resumeWithFeedback(task.id, 'after the kick');
      await Promise.all([kick, resume]);
      expect(agent.calls).toHaveLength(2);
      expect(agent.calls.at(-1)?.resume).toBe(true);
    });
  });

  describe('checks and the fix pass', () => {
    const withChecks = (autoFix = true) =>
      projectRepo.update(project.id, { checkCommands: ['npm run typecheck', 'npm run lint'], autoFix });
    const kinds = (taskId: number) => runs.listByTask(taskId).map((r) => r.kind);

    it('skips checks when the project has none', async () => {
      const task = todo();
      await scheduler.kick(project.id);
      expect(adapter.calls).toBe(0);
      expect(runs.listByTask(task.id)[0]).toMatchObject({ checksPassed: null, checksFailed: null });
    });

    it('runs the checks after the run and goes to review when they pass', async () => {
      withChecks();
      const task = todo();
      await scheduler.kick(project.id);

      expect(adapter.calls).toBe(1);
      expect(runs.listByTask(task.id)[0]).toMatchObject({ checksPassed: 2, checksFailed: 0 });
      expect(checks.listByTask(task.id)[0]?.results.map((r) => r.command)).toEqual(['npm run typecheck', 'npm run lint']);
      expect(logTexts(task.id)).toContain('system: Checks: 2 passed, 0 failed');
      expect(statusOf(task.id)).toBe('in_review');
    });

    it('resumes once with the failing output, then rechecks', async () => {
      withChecks();
      adapter.queue.push([passedCheck('npm run typecheck'), failedCheck('npm run lint', 'src/a.ts: no-unused-vars')]);
      const task = todo();
      await scheduler.kick(project.id);

      expect(kinds(task.id)).toEqual(['initial', 'check_fix']);
      const fix = agent.calls[1];
      expect(fix).toMatchObject({ resume: true, sessionId: 'sess-1' });
      expect(fix?.prompt).toContain('### `npm run lint` (exit 1)');
      expect(fix?.prompt).toContain('src/a.ts: no-unused-vars');
      expect(fix?.prompt).not.toContain('npm run typecheck');
      expect(adapter.calls).toBe(2);
      expect(runs.listByTask(task.id).map((r) => r.checksFailed)).toEqual([1, 0]);
      expect(statusOf(task.id)).toBe('in_review');
    });

    it('goes to review red when the fix pass does not fix it, with no third run', async () => {
      withChecks();
      adapter.queue.push([failedCheck('npm run lint')], [failedCheck('npm run lint')]);
      const task = todo();
      await scheduler.kick(project.id);
      expect(kinds(task.id)).toEqual(['initial', 'check_fix']);
      expect(runs.listByTask(task.id).at(-1)?.checksFailed).toBe(1);
      expect(statusOf(task.id)).toBe('in_review');
    });

    it('does not retry when auto-fix is off', async () => {
      withChecks(false);
      adapter.queue.push([failedCheck('npm run lint')]);
      const task = todo();
      await scheduler.kick(project.id);
      expect(kinds(task.id)).toEqual(['initial']);
      expect(statusOf(task.id)).toBe('in_review');
    });

    it('allows one fix pass again after a reject (once per review round)', async () => {
      withChecks();
      adapter.queue.push([failedCheck('npm run lint')], [failedCheck('npm run lint')]);
      const task = todo();
      await scheduler.kick(project.id);
      tasks.applyStatusChange(transition(tasks.get(task.id) ?? task, 'reject'));

      adapter.queue.push([failedCheck('npm run lint')]);
      await scheduler.resumeWithFeedback(task.id, 'please fix lint');
      expect(kinds(task.id)).toEqual(['initial', 'check_fix', 'feedback', 'check_fix']);
    });

    it('skips checks when the agent asked a question, and after a stopped run', async () => {
      withChecks();
      agent.script = finishWith({ kind: 'result', result: result(fence({ outcome: 'needs_input', question: 'Which?' })) });
      await scheduler.kick(project.id);
      expect(adapter.calls).toBe(0);

      const other = seedProject(db, fakeClock(), 'api');
      projectRepo.update(other.id, { checkCommands: ['npm test'] });
      agent.script = waitForAbort;
      const task = todo({}, other.id);
      const worker = scheduler.kick(other.id);
      await settle();
      scheduler.stop(task.id);
      await worker;
      expect(adapter.calls).toBe(0);
    });

    it('runs checks after a run that hit its turn limit, but does not try to fix', async () => {
      withChecks();
      agent.script = finishWith({ kind: 'result', result: result('', 'error_max_turns') });
      adapter.queue.push([failedCheck('npm run lint')]);
      const task = todo();
      await scheduler.kick(project.id);
      expect(adapter.calls).toBe(1);
      expect(kinds(task.id)).toEqual(['initial']);
    });

    it('stop() during the checks aborts them and skips the fix pass', async () => {
      withChecks();
      const task = todo();
      adapter.queue.push([failedCheck('npm run lint')]);
      adapter.onCheck = () => scheduler.stop(task.id);
      await scheduler.kick(project.id);
      expect(adapter.signals[0]?.aborted).toBe(true);
      expect(kinds(task.id)).toEqual(['initial']);
      expect(statusOf(task.id)).toBe('in_review');
    });

    it('records an adapter that throws as one failed check', async () => {
      withChecks(false);
      adapter.check = () => Promise.reject(new Error('npm not found'));
      const task = todo();
      await scheduler.kick(project.id);
      expect(checks.listByTask(task.id)[0]?.results).toEqual([
        { command: 'checks', exitCode: null, passed: false, timedOut: false, durationMs: 0, output: 'npm not found' },
      ]);
      expect(statusOf(task.id)).toBe('in_review');
    });
  });
});
