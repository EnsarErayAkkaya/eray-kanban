-- Per-project starting points for new tasks. A null model or turn limit means the project's default.
CREATE TABLE task_templates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects (id),
  name                TEXT    NOT NULL,
  title_prefix        TEXT    NOT NULL DEFAULT '',
  description         TEXT    NOT NULL DEFAULT '',
  acceptance_criteria TEXT    NOT NULL DEFAULT '',
  priority            TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  visual              INTEGER NOT NULL DEFAULT 0 CHECK (visual IN (0, 1)),
  routes              TEXT    NOT NULL DEFAULT '[]',
  model               TEXT    CHECK (model IN ('sonnet', 'opus', 'haiku')),
  turn_limit          INTEGER CHECK (turn_limit > 0),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE (project_id, name)
);
