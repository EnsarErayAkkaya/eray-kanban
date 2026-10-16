-- The branch whose push failed after an accept, so "Retry push" knows what to push.
ALTER TABLE tasks ADD COLUMN pending_push TEXT;
