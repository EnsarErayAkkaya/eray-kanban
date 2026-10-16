CREATE TABLE projects (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL UNIQUE,
  repo_path             TEXT    NOT NULL UNIQUE,
  type                  TEXT    NOT NULL CHECK (type IN ('web', 'generic')),
  working_branch        TEXT    NOT NULL,
  merge_target          TEXT,
  accept_commit         INTEGER NOT NULL CHECK (accept_commit IN (0, 1)),
  accept_followup       TEXT    NOT NULL CHECK (accept_followup IN ('none', 'push', 'merge')),
  commit_message_format TEXT    NOT NULL,
  default_model         TEXT    NOT NULL CHECK (default_model IN ('sonnet', 'opus', 'haiku')),
  default_turn_limit    INTEGER NOT NULL CHECK (default_turn_limit > 0),
  allowed_commands      TEXT    NOT NULL DEFAULT '[]',
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE TABLE tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects (id),
  title               TEXT    NOT NULL,
  description         TEXT    NOT NULL DEFAULT '',
  acceptance_criteria TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'backlog' CHECK (status IN
                        ('backlog', 'todo', 'in_progress', 'needs_input', 'in_review', 'done', 'cancelled')),
  priority            TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  position            REAL    NOT NULL,
  visual              INTEGER NOT NULL DEFAULT 0 CHECK (visual IN (0, 1)),
  routes              TEXT    NOT NULL DEFAULT '[]',
  model               TEXT    NOT NULL CHECK (model IN ('sonnet', 'opus', 'haiku')),
  turn_limit          INTEGER NOT NULL CHECK (turn_limit > 0),
  depends_on          INTEGER REFERENCES tasks (id),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE INDEX tasks_by_project_status ON tasks (project_id, status);

-- Invariant 3, enforced by the database as well as the scheduler.
CREATE UNIQUE INDEX tasks_one_active_per_project ON tasks (project_id)
  WHERE status IN ('in_progress', 'needs_input', 'in_review');

CREATE TABLE runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id               INTEGER NOT NULL REFERENCES tasks (id),
  kind                  TEXT    NOT NULL CHECK (kind IN ('initial', 'feedback', 'check_fix', 'answer')),
  outcome               TEXT    NOT NULL DEFAULT 'running' CHECK (outcome IN
                          ('running', 'completed', 'turn_limit', 'stopped', 'timed_out', 'failed')),
  session_id            TEXT,
  model                 TEXT    NOT NULL,
  turn_limit            INTEGER NOT NULL,
  input                 TEXT    NOT NULL,
  num_turns             INTEGER,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  cost_usd              REAL,
  error                 TEXT,
  started_at            TEXT    NOT NULL,
  ended_at              TEXT
);

CREATE INDEX runs_by_task ON runs (task_id);

CREATE TABLE run_log (
  run_id INTEGER NOT NULL REFERENCES runs (id),
  seq    INTEGER NOT NULL,
  kind   TEXT    NOT NULL CHECK (kind IN ('text', 'tool_use', 'tool_result', 'error', 'system')),
  text   TEXT    NOT NULL,
  at     TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
