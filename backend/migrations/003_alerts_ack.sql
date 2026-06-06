-- 003_alerts_ack.sql
-- Adds acknowledge state to alerts so the FMS mobile app can mark alerts as
-- "handled" from the alarm detail screen.
-- Idempotent: SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we guard
-- with PRAGMA introspection in the runner. Direct `sqlite3 db < file` will
-- error harmlessly on re-run (duplicate column name) — that's expected.

ALTER TABLE alerts ADD COLUMN acked_at INTEGER;
ALTER TABLE alerts ADD COLUMN acked_by TEXT;

CREATE INDEX IF NOT EXISTS idx_alerts_acked ON alerts (tenant_id, acked_at);
