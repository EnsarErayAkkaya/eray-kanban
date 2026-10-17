---
name: kanban
description: Put an agreed plan onto the Agent Kanban board as Backlog tasks for the current repo. Use when the user asks to put, add, push or send tasks, a plan or a breakdown to the board, kanban or Agent Kanban, or to turn the plan into board tasks. Also lists the board's projects, open tasks and templates.
---

# Agent Kanban: plan to tasks

Agent Kanban is the user's local board (http://127.0.0.1:4317). Each project there is a git repo with one headless Claude Code agent. The agent takes Todo tasks one at a time, and every result waits for the user's review. This skill turns a plan you made with the user into **Backlog** tasks. The user reviews them on the board and moves them to Todo themselves.

The helper `kanban.ts` sits in this skill's folder (the base directory shown when the skill loads). Run it with `node <skill folder>/kanban.ts <command>`. It needs Node 24+ and the board running. If the board isn't on port 4317, set `KANBAN_URL`.

| Command | What it does |
|---|---|
| `here [dir]` | The board project whose repo contains `dir` (default: current folder) |
| `projects` | Every board project |
| `tasks <projectId>` | Open tasks, so the plan can depend on them and avoid duplicates |
| `templates <projectId>` | The project's task templates |
| `create <plan.json> --dry-run` | Checks the plan and shows what would be created |
| `create <plan.json>` | Creates the tasks in order, all in Backlog |

## Steps

1. **Have a plan first.** This skill writes down a plan; it doesn't replace planning. If there isn't one yet, read the code and agree the breakdown with the user before going on.
2. **Find the project:** `here`. If there's no match, ask the user to add the repo as a project on the board. Never create projects.
3. **Look at what's there:** `tasks <id>` and `templates <id>`. Don't duplicate open tasks; depend on them instead.
4. **Write the tasks** following the rules below.
5. **Show the list** (titles, order, dependencies, which ones are visual). If the user already asked you to put these exact tasks on the board, go ahead; otherwise wait for their OK.
6. **Write the plan file in a temp or scratch folder, never inside the repo** (an untracked file stops the board from starting tasks). Run `create <file> --dry-run`, fix anything it reports, then run `create <file>`.
7. **Report the new task ids** and remind the user the tasks are in Backlog. Delete the temp file.

If `create` stops partway, it lists the tasks already created. Don't run the same file again. Remove those tasks from the file, point any `dependsOn` at their new ids, then create the rest.

## Plan file

```json
{
  "projectId": 3,
  "tasks": [
    {
      "key": "model",
      "title": "Add the product review model and migration",
      "description": "Reviews belong to a product and a customer ... See @src/db/schema.ts.",
      "acceptanceCriteria": "- Migration adds a reviews table ...\n- Unit tests cover ...",
      "template": "Bug fix",
      "model": "opus"
    },
    {
      "key": "ui",
      "title": "Show reviews on the product page",
      "description": "...",
      "acceptanceCriteria": "...",
      "visual": true,
      "routes": ["/products/1"],
      "dependsOn": "model"
    }
  ]
}
```

| Field | Notes |
|---|---|
| `title` | Required, at most 200 characters |
| `description`, `acceptanceCriteria` | Plain text or Markdown |
| `key` | Only so later tasks in this file can depend on this one |
| `dependsOn` | The `key` of an **earlier** task in the file, an existing task id (number), or leave it out |
| `template` | Template name: fills in the title prefix, text, priority, visual and routes, model and turn limit unless the task sets them |
| `priority` | `high`, `normal` (default) or `low` |
| `visual`, `routes` | `visual: true` plus 1 to 20 routes starting with `/` (pages the board screenshots for review) |
| `model` | `sonnet`, `opus` or `haiku`. Leave it out to use the project default |
| `turnLimit` | 1 to 500. Leave it out to use the project default |

## Writing good tasks

- **One reviewable change per task.** The user should be able to review the diff in about five minutes. Split anything bigger into a chain with `dependsOn`.
- **Make the acceptance criteria checkable:** behaviour, edge cases, tests to add. The agent checks itself against them, and the user reviews against them.
- **Point to the code with `@path` references** (repo-relative, forward slashes; quote a path with spaces as `@"path with space"`). This saves the agent from searching. Don't paste file contents or diffs.
- **Don't repeat the project's rules.** The agent reads the repo's CLAUDE.md; the task only says what to do.
- **Set `visual: true` with routes for anything a user sees.** Use routes that render without login or setup.
- **Use `opus` only** for hard or cross-cutting work. Leave the model out otherwise.
- **Never put secrets in tasks** (keys, passwords, tokens). Agents can't read `.env` files; say which variable to use instead.
- **Flag risky areas in the description** (payments, auth, pricing, data migrations) so the user reviews them closely.

## Never

- Move tasks to Todo, start, accept, reject or cancel anything. Creating Backlog tasks is this skill's only write.
- Edit or delete existing tasks, or create projects.
- Call the board API in any other way than through the helper.
