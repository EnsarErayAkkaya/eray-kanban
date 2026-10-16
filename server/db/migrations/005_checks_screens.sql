-- Adapter settings: checks run after each agent run; the dev server and sizes serve screenshots.
ALTER TABLE projects ADD COLUMN check_commands TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN auto_fix INTEGER NOT NULL DEFAULT 1 CHECK (auto_fix IN (0, 1));
ALTER TABLE projects ADD COLUMN dev_command TEXT;
ALTER TABLE projects ADD COLUMN dev_url TEXT;
ALTER TABLE projects ADD COLUMN screenshot_sizes TEXT NOT NULL DEFAULT '["desktop"]';

-- Counts on the run let a card show red or green without loading every result.
ALTER TABLE runs ADD COLUMN checks_passed INTEGER;
ALTER TABLE runs ADD COLUMN checks_failed INTEGER;

CREATE TABLE check_results (
  run_id      INTEGER NOT NULL REFERENCES runs (id),
  seq         INTEGER NOT NULL,
  command     TEXT    NOT NULL,
  exit_code   INTEGER,
  passed      INTEGER NOT NULL CHECK (passed IN (0, 1)),
  timed_out   INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
  duration_ms INTEGER NOT NULL,
  output      TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE TABLE screenshots (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  INTEGER NOT NULL REFERENCES runs (id),
  route   TEXT    NOT NULL,
  size    TEXT    NOT NULL,
  width   INTEGER NOT NULL,
  height  INTEGER NOT NULL,
  file    TEXT,
  error   TEXT,
  taken_at TEXT   NOT NULL
);

CREATE INDEX screenshots_by_run ON screenshots (run_id);
