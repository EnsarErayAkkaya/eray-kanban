# Agent Kanban — Project Plan

Oct 16, 2026 · @Master · updated Oct 17, 2026: M1 to M3 done, M4 complete apart from its soak test

## Goals and scope

A local kanban where I create tasks per project, one Claude Code agent per project picks them up, and nothing lands in git until I accept a review.

**In scope**

- Kanban board to create, order and track tasks across several projects
- One agent per project that takes the next task automatically
- A review step on every task: summary, touched files, diff, check results, screenshots for visual tasks
- Reject with feedback, accept (commit, then optionally push or merge), or cancel with full rollback
- Low token use: deterministic work done by the orchestrator, not the model

**Project types:** web apps first. Unity support comes later, opening the editor only when a task needs it.

**Non-goals**

- No manager or CEO agents, no agent-to-agent delegation
- No cloud hosting or multi-user access; it runs on my machine (macOS, Windows or Linux)
- No mobile simulators
- No automatic merge-conflict resolution

## Architecture

Everything runs on my machine: a browser UI, one local server, and one headless Claude Code process per project.

&#91;embedded content: architecture · UI, orchestrator, one worker per project\]

The orchestrator does scheduling, git, checks and screenshots itself; workers only read and edit code in their own repo. Suggested stack: TypeScript, Node, SQLite, a small React UI.

## Kanban board and task model

The board has one column per state, with a filter per project. Dragging a card from Backlog to Todo makes it available to that project's agent.

| Column | Meaning | Who moves it out |
| --- | --- | --- |
| Backlog | Ideas, not ready for an agent | Me |
| Todo | Ready; ordered by priority, then position | Agent picks it up |
| In Progress | Agent working; live log visible | Agent submits, or hits a limit |
| Needs Input | Agent stopped on a real ambiguity and asked a question | Me, by answering |
| In Review | Waiting for my decision; project is paused | Me |
| Done | Accepted, with or without commit | — |
| Cancelled | Cancelled and rolled back | — |

**Task fields**

| Field | Notes |
| --- | --- |
| Project | Which repo the task runs in |
| Title, description | What to do and acceptance criteria |
| Priority | High / Normal / Low |
| Visual | On = screenshots required in review |
| Routes | Web pages to capture when Visual is on, e.g. /settings |
| Model | Sonnet by default, Opus for hard tasks |
| Turn limit | Hard cap per run, default per project |
| Depends on | Optional; task starts only after the other is accepted |
| History | Each run, my feedback, cost per run |

**Templates** per project (bug fix, UI change, refactor) pre-fill Visual, model and turn limit.

## Task lifecycle

A project runs one task at a time and waits while that task is in review; other projects keep working.

&#91;embedded content: task lifecycle · 6 states, review gate\]

1. **Pick up:** the worker takes the top Todo task, checks out the working branch, confirms a clean tree and saves the snapshot.
2. **Run:** a fresh headless session gets the short task prompt; its log streams to the card.
3. **Submit:** the agent ends with its review JSON; the orchestrator runs checks, sends failures back once, then builds the review package.
4. **Review:** I reject, accept or cancel. Reject resumes the same session with my feedback.
5. **Next:** after Done or Cancelled the project unpauses and the worker picks the next Todo task.

## Review package

The agent writes only the summary; everything else in the review is gathered by the orchestrator, so it costs no tokens and cannot be wrong about what changed.

| Item | Produced by | How |
| --- | --- | --- |
| Summary of work, notes, open concerns | Agent | Short JSON block in its final message |
| Touched files (added / modified / deleted) | Orchestrator | git status against the start snapshot |
| Diff | Orchestrator | git diff, shown per file in the review panel |
| Check results | Orchestrator | Project's build, lint, typecheck, test commands |
| Screenshots | Orchestrator | Playwright capture of the listed routes (Visual tasks) (optional) |
| Cost | Orchestrator | Tokens and turns from the CLI's stream output |

If checks fail, the orchestrator sends the errors back to the agent once, automatically, before the task reaches review. A second failure goes to review marked red.

**Review actions**

1. **Reject with feedback.** My text goes into the same session, resumed, so the agent keeps its context. The task returns to In Progress.
2. **Accept.** Choose Commit or No commit; if Commit, choose the follow-up: nothing, push, or merge into a target branch. Defaults come from the project settings.
3. **Cancel.** Roll back to the start snapshot; the task moves to Cancelled.

## Git and branches

Each project has its own working branch, and only the orchestrator runs git commands that change history; the agent never commits, stages, pushes or resets.

**Project settings**

| Setting | Example |
| --- | --- |
| Working branch | develop |
| Default on accept | Commit + push |
| Merge target (optional) | main |
| Commit message format | `feat(#42): <task title>` + agent summary |

**Rules**

- **Before a task:** check out the working branch, require a clean tree, record HEAD and the list of untracked files as the snapshot.
- **On accept with commit:** stage only the touched files, commit, then run the chosen follow-up (nothing, push, or merge into target and optionally push).
- **On accept without commit:** leave changes in the tree; the project stays paused until I commit or discard them myself, so the next task starts clean.
- **On cancel:** restore tracked files to the snapshot HEAD and remove only files created during the task. Ignored folders such as node\_modules are untouched.
- **Merge conflict:** abort the merge, keep the commit on the working branch, mark the task "Merge conflict" for me to resolve.
- **Push failure** (auth, rejected): keep the commit, show the error, offer Retry push.

## Project adapters

An adapter tells the orchestrator how to check and screenshot one kind of project; web is built first, Unity is a later adapter with the same interface.

|  | Web (v1) | Unity (later) | Generic |
| --- | --- | --- | --- |
| Checks | build, lint, typecheck, test commands from project settings | Compile errors and tests via Unity MCP | Any shell commands |
| Runtime | Start the dev server if not running; wait for its URL | Launch the editor for that project only when a task needs it | — |
| Screenshots | Headless Playwright on each listed route, desktop and mobile widths | Game or Scene view capture via Unity MCP | None |
| Shutdown | Stop the dev server if the orchestrator started it | Leave editor open | — |

Adapter interface: `prepare()`, `check()`, `screenshot(routes)`, `teardown()`. Adding Unity later means one new adapter, no changes elsewhere.

## Token efficiency

Tokens go only to the coding itself; scheduling, git, checks, screenshots and summaries of file changes are plain code.

1. **Own Claude Code login.** Agents are the `claude` CLI in headless mode, so usage runs on my existing plan.
2. **No hierarchy.** One agent per task, no manager or reviewer agents.
3. **No polling.** Workers react to board events; idle projects cost nothing.
4. **Fresh session per task.** No context carried between tasks; the session is resumed only for my feedback or an automatic check-fix pass.
5. **Short prompt.** Task title, description, acceptance criteria and the review JSON format. Project rules live in a lean CLAUDE.md per repo.
6. **Tool allow-list.** Only the tools a task needs; no web search unless the task enables it.
7. **Hard caps.** Turn limit per run; a run that hits it goes to review with what it has.
8. **Model per task.** Sonnet by default, Opus only when chosen.
9. **Cost on every card.** Tokens and turns per run, totals per project.

## Safety and permissions

Agents can edit files and run project commands inside their own repo, and nothing else.

- **Working directory locked** to the project repo.
- **Denied commands:** git commit, add, push, reset, checkout, merge, rebase, stash; rm outside the repo; package publishing.
- **Allowed by default:** read, edit, write, search, and the project's own scripts (dev, build, test, lint).
- **No secrets in prompts.** Env files stay local; the agent may read them only if the project allows it.
- **One task per project at a time,** so two agents never touch the same tree.
- **Kill switch** per project and globally: stop the run, keep the changes for review or roll back.
- **Server binds to localhost only.**

## Milestones

Four milestones, each usable on its own; web projects are fully covered after M3.

**Status (Oct 17, 2026):** M1, M2 and M3 are done and committed. M4's features are built and tested; its done condition, a day of parallel use, is still to run.

1. **M1 — Board and one worker.** ✅ Done. Projects and tasks in SQLite, kanban UI, one worker running the CLI headless, live log on the card.
   - Done when: a Todo task in one project runs and its log streams on the board.
   - Checked in the browser: a task ran with the real CLI and its log streamed onto the card.
2. **M2 — Review loop and git.** ✅ Done. Snapshot, touched files, diff, review panel, reject with resume, accept with commit / push / merge, cancel with rollback, auto next task.
   - Done when: a task can be rejected twice, accepted and pushed, and a cancelled task leaves the tree exactly as before.
   - Checked in the browser: a task was rejected twice and accepted, and its commit reached the remote. After a cancel, every file hashed the same as before the task (119 of 119).
3. **M3 — Web adapter.** ✅ Done. Check commands, auto-fix pass, dev server handling, Playwright screenshots, macOS notification on review.
   - Done when: a Visual task arrives in review with screenshots of its routes and green checks.
   - Checked in the browser: a Visual task reached review with green checks and screenshots at desktop and mobile size, and the dev server the board started was stopped afterwards. In a separate run, a lint failure was fixed by the automatic fix pass.
4. **M4 — Polish and parallel projects.** 🔨 Built, soak test pending. All projects running at once, cost totals, templates, dependencies, Needs Input state.
   - Done when: three projects run in parallel for a day without manual git cleanup.
   - Built: projects run in parallel. A Needs Input question is answered from the review panel and the agent resumes its session. New tasks can depend on another task, and cards show what they wait for (or that the dependency was cancelled). The top bar shows cost, turns and runs for one project or all. Per-project templates (name, title prefix, description, criteria, priority, visual and routes, model, turn limit) are managed in project settings and pre-fill the task form.
   - Pause switch: a project, or all of them at once, can be paused from the top bar. Pausing stops the running agent (its task goes to review with what it has) and nothing starts, including a reply to a question or review, until you resume. The pause survives a restart.
   - A Backlog or Todo task's dependency can be changed in its edit form. Loops are refused, and a Todo task starts as soon as its new dependency allows.
5. **Later — Unity adapter.** Editor launch on demand, Unity MCP checks and captures.

### Decisions made along the way

These go beyond the open decisions below:

- **Agent runs** use `claude -p --restricted` with the project's CLAUDE.md passed in. Bash is allowed only for listed commands, and shells and git are refused. `.env*` files can't be read or edited.
- **Post-run guard:** after every run the board checks HEAD, the branch and the index, and flags the task if the agent changed git.
- **Wrong branch at pickup:** the project waits and shows why; the board never runs a checkout. A guard-tripped task can still be accepted or cancelled.
- **Merges** always use `--no-ff`. Merge conflicts and push failures show as badges on Done cards, with Retry push and Mark resolved.
- **Screenshots** use your installed Chrome through `playwright-core`.

## Open decisions

- [x] Where the tool's repo lives: `~/Repos/eray-kanban`
- [x] Stack: TypeScript, Node, Fastify, SQLite (better-sqlite3), React + Vite, Vitest
- [x] Accept without commit: the project stays paused until you clean up. A task starts only from a fully clean tree.
- [x] Screenshot widths: chosen per project (Desktop 1280, Tablet 768, Mobile 390); the default is desktop only
- [x] Auto check-fix pass: on by default with a per-project toggle, and at most once per review round
