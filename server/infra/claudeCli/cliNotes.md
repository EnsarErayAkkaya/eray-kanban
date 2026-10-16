# Claude CLI: findings from the M1 test (claude 2.1.296, 2026-10-16)

## Command the AgentRunner uses (see `claudeArgs.ts`)
The prompt goes in on stdin (`claude -p` with no prompt argument reads stdin). `--session-id <uuid>` sets the session ID up front; the reaper uses it to recognize our processes, because `--output-format stream-json` alone also matches the Claude desktop app's own processes. End-to-end smoke test (2026-10-16, small file task): $0.012, 2 turns.
```
claude -p "<task prompt>" \
  --output-format stream-json --verbose \
  --model <task.model> --max-turns <task.turnLimit> \
  --restricted --strict-mcp-config --disable-slash-commands \
  --append-system-prompt-file CLAUDE.md \
  --tools Read Edit Write Glob Grep Bash \
  --allowedTools Read Edit Write Glob Grep "Bash(npm run test:*)" ... \
  --disallowedTools "Bash(git commit:*)" "Bash(git add:*)" ...
```
Review feedback and the check-fix pass add `--resume <sessionId>`. The session ID stays the same.

## Flags
- `--verbose` is required with `-p --output-format stream-json`.
- `--max-turns` works, but `--help` doesn't list it.
- `--restricted`: keeps only the tools that `--tools` names, ignores user/project/local settings files (so no user hooks and no plugins), confines file tools to the cwd, and refuses writes to `.git/` and settings files. It also **skips CLAUDE.md**, which is why `--append-system-prompt-file CLAUDE.md` is needed (tested: the rules load).
- `--strict-mcp-config` with no `--mcp-config` turns off every MCP server, claude.ai connectors included.
- Don't use `--bare`: it reads only `ANTHROPIC_API_KEY`, not the OAuth login (CLAUDE.md §4).
- `--allowedTools` only pre-approves. `--tools` decides what the model sees. In `-p` mode, a tool that isn't allowed is denied and listed in `result.permission_denials`.

## Cost of a trivial task
- Default flags (user plugins, MCP, hooks, 29 tools): $0.077 for 2 turns, about 78k input tokens.
- Locked-down flags above: $0.027 for 7 turns.

## Deny-list gaps (invariant 2)
Blocked: `git add x`, `git commit -m`, `cd . && git commit`, and writes to `.git/hooks/*`.
**Got through:** `sh -c 'git add -A && git commit -m two'` created a commit.
- Never allow bare `Bash`. Allow-list specific commands such as the project's scripts and `rg`.
- The post-run guard (HEAD and index vs. snapshot) is still required, because project scripts can run git too.

## Stream events (fixtures in `./fixtures`)
- Order: `system/init` (session_id, model, tools) → `assistant` / `user` (tool_use and tool_result, `is_error` on denial) → `result`.
- `result`: `subtype` ("success" | error subtypes), `is_error`, `num_turns`, `session_id`, `total_cost_usd`, `usage` (input / output / cache_creation / cache_read tokens), `permission_denials`, `result` (final text), `terminal_reason`.
- `system/task_summary` can arrive **after** `result`, so don't treat `result` as the last line.
- Ignore event types the runner doesn't know (hook_*, commands_changed, rate_limit_event, post_turn_summary).
