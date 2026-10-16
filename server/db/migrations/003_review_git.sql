-- Invariant 4: taken once, at a task's first pickup, and kept across rejects until rollback or accept.
CREATE TABLE snapshots (
  task_id    INTEGER PRIMARY KEY REFERENCES tasks (id),
  branch     TEXT    NOT NULL,
  head       TEXT    NOT NULL,
  untracked  TEXT    NOT NULL DEFAULT '[]',
  empty_dirs TEXT    NOT NULL DEFAULT '[]',
  created_at TEXT    NOT NULL
);

-- Shown as a badge on the card; never a status.
ALTER TABLE tasks ADD COLUMN git_issue TEXT CHECK (git_issue IN ('guard_tripped', 'merge_conflict', 'push_failed'));
ALTER TABLE tasks ADD COLUMN git_issue_detail TEXT;
ALTER TABLE tasks ADD COLUMN commit_sha TEXT;

ALTER TABLE runs ADD COLUMN review_json TEXT;

ALTER TABLE projects ADD COLUMN push_after_merge INTEGER NOT NULL DEFAULT 0 CHECK (push_after_merge IN (0, 1));
