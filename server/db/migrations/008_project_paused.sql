-- Pause switch: a paused project starts no agent until resumed, and stays paused across restarts.
ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));
