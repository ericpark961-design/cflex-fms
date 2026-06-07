-- 002_fms_push_subscriptions.sql
-- Expo push subscriptions for the C-Flex FMS mobile app.
-- Idempotent.

CREATE TABLE IF NOT EXISTS fms_push_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL,
  user_id         INTEGER,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform        TEXT,                       -- 'ios' | 'android' | 'web'
  device_name     TEXT,
  app             TEXT NOT NULL DEFAULT 'fms',
  min_severity    TEXT NOT NULL DEFAULT 'warn', -- 'ok' | 'warn' | 'critical' | 'unreachable'
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_fms_push_tenant ON fms_push_subscriptions (tenant_id, app);
CREATE INDEX IF NOT EXISTS idx_fms_push_token  ON fms_push_subscriptions (expo_push_token);
