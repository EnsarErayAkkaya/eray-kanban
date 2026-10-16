# CLAUDE.md — Agent Kanban rules

Local tool: a kanban board where tasks are created per project, one headless Claude Code agent per project runs them, and nothing reaches git until the user accepts a review. Runs locally on the user's machine: macOS, Windows or Linux. Read this file fully before any task. The rules below are mandatory.

## 1. Stack
- **TypeScript** everywhere, `strict: true`. No `any` and no `@ts-ignore` without a one-line reason.
- **Server:** Node (LTS) and a small HTTP framework (Fastify). The server sends live updates to the UI with Server-Sent Events.
- **Storage:** SQLite through `better-sqlite3`. Migrations are numbered SQL files in `server/db/migrations/`.
- **UI:** React + Vite. Components are views only: they render state and call the API client.
- **Screenshots:** Playwright, headless Chromium.
- **Tests:** Vitest.
- Don't add a dependency without asking. Prefer the standard library.

## 2. Architecture

### Layout
```
server/
  domain/      # Task, Project, Run, state machine. Pure TS, no I/O
  services/    # Scheduler, ReviewService, GitService, AgentRunner
  adapters/    # web/, unity/ (later), generic/: prepare, check, screenshot, teardown
  infra/       # sqlite repos, process spawning, fs, SSE
  api/         # HTTP routes. Thin: validate → call a service → map the result
ui/
  components/  # views only
  state/       # store + API client
shared/        # types and zod schemas shared by server and UI
```

### Rules
- **Dependencies point one way:** api/infra → services → domain. Domain imports nothing from the other layers.
- **SOLID:**
  - One responsibility per module.
  - Services depend on interfaces such as `GitPort`, `AgentPort`, `ProjectAdapter` and `TaskRepo`, not on concrete classes.
  - New project types or agent backends come as new adapters, not as `if`/`switch` chains on type.
- **Wiring:** constructor injection from one composition root (`server/main.ts`). No singletons, no module-level mutable state.
- **State machine:** all task state changes go through `domain/taskMachine.ts`. No other code writes `task.status`.
- **Platforms:** OS differences live only in infra: `ProcessPlatform` (`posixProcessPlatform.ts`, `windowsProcessPlatform.ts`) and one notifier per OS, chosen in `main.ts`. Use `path.join`, never hard-coded `/` or `sh`; tests run on all three OSes.
- **Validation:** validate every API input, and the agent's review JSON, with zod schemas from `shared/`.

### Naming
- Files `camelCase.ts`, React components `PascalCase.tsx`.
- Private class fields use the `_camelCase` prefix.
- Interfaces describe a role without an `I` prefix (`GitPort`, not `IGitService`).

### Comments
- Keep comments minimal, one line at most. Comment only *why*, never *what*. No commented-out code.

## 3. Invariants — never break these
These protect the user's real projects. A change that weakens one needs explicit user approval.

1. **Agents never write to git.** The orchestrator runs every history-changing git command (commit, push, merge, reset, clean, checkout), and only after a user action in review.
2. **Each agent run is denied** git commit/add/push/reset/checkout/merge/rebase/stash and file deletion outside its repo, through `--disallowedTools`. The working directory is locked to the project repo.
3. **One active task per project.** A project in review is paused. Different projects run in parallel.
4. **Snapshot before every task:** HEAD plus the list of untracked files, saved in SQLite before the agent starts.
5. **Rollback restores the snapshot exactly.** Rollback never touches ignored files (`node_modules`, `.env`, `Library/`).
6. **Commits stage only the task's touched files,** never `git add -A`.
7. **Merge conflicts are never resolved automatically.** Abort the merge, keep the commit and flag the task.
8. **The server binds to `127.0.0.1` only.**
9. **Every spawned process has a timeout and is killed on cancel.** No orphaned `claude`, dev server or Playwright processes.

## 4. Agent runner (the token budget lives here)
- **Agents run as headless CLI processes:** `claude -p --output-format stream-json`, so usage runs on the user's Claude Code login. Don't switch to an API-key SDK without asking.
- **Fresh session per task.** Use `--resume <sessionId>` only for review feedback or the single automatic check-fix pass.
- **Keep the task prompt template short** (`server/services/prompts/task.md`): title, description, acceptance criteria, the review JSON format. Don't paste file contents, diffs or project rules into it. The project's own CLAUDE.md supplies the rules.
- **Pass `--max-turns` and `--model` from the task,** and use an allow-list of tools.
- **Read tokens and turns from the stream's result event** and store them per run.
- **The orchestrator, not the model, builds** touched files, diffs, check output and screenshots.

## 5. Tests
- Domain and services get unit tests with fake ports. No real git or processes in unit tests.
- `GitService` gets integration tests against a temp repo (`fs.mkdtemp` + `git init`). These cover snapshot, rollback with new, modified and deleted files, commit of touched files only, and merge conflict abort.
- The state machine gets a test for every allowed transition and for the rejection of every illegal one.

## 6. Edit → verify loop
```bash
npm run typecheck
npm run lint
npm test -- <name>      # targeted first, full suite before reporting
```
Run them after every change. Report failures, don't hide them.

## 7. Token economy
- Don't read `node_modules/`, `dist/`, `*.db`, `data/`, `screenshots/` or lockfiles.
- Search with `rg` before opening files. Open only the files the task needs.
- Read test and command output through `tail` or a filter. Don't dump whole logs.
- Keep edits within the module the task names.

## 8. Workflow
- Plan first for anything that touches more than one layer or any invariant in section 3. Confirm the plan before writing code.
- Work in small steps: implement → typecheck → tests → report.
- Schema changes need a new migration file. Never edit an applied migration.

## 9. Version control — hands off
- **Never stage, commit, push, stash, reset or amend** in this repo. The user does all version control.
- Read-only commands are fine: `git status`, `git diff`, `git log`.
- When work is done, list the changed files and a suggested commit message. Leave them unstaged.
