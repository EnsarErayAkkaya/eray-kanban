-- Soft delete: a deleted task's runs still count towards the cost totals.
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
