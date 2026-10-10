-- C-Flex FMS 2.0 — S2: insights, on-call, AI audit, escalation.
--
-- S1 connected the 2.0 console to the APIs that already existed. S2 adds the
-- four things the console shows a grey "S2에서 연결" placeholder for, and the
-- escalation column the alarm-route UI already renders a column for.
--
-- Additive only. Two ALTERs at the end: apply.js swallows exactly
-- "duplicate column name" so re-running is safe.
--
-- Timestamps are Date.now() milliseconds throughout, matching ups_devices.last_polled.

-- ── AI insights ─────────────────────────────────────────────────────
-- One row per generated insight. The dashboard's "AI 인사이트" panel reads the
-- newest unexpired rows for the selected CBU; nothing here is computed at read
-- time, so a panel with no rows shows "데이터 축적 중" rather than a guess.
CREATE TABLE IF NOT EXISTS fms_insights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  cbu         TEXT,                          -- NULL = fleet-wide
  kind        TEXT NOT NULL,                 -- risk | capacity | battery | thermal | anomaly
  severity    TEXT NOT NULL DEFAULT 'info',  -- info | warn | critical
  device_id   INTEGER,                       -- ups_devices.id when device-specific
  title       TEXT NOT NULL,
  body        TEXT,
  evidence    TEXT,                          -- JSON: the rows/metrics the claim rests on
  confidence  REAL,                          -- 0..1, NULL when not a model output
  source      TEXT NOT NULL DEFAULT 'rule',  -- rule | model
  model       TEXT,                           -- e.g. claude-opus-5, NULL for rule-derived
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                        -- stale insights disappear instead of misleading
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fms_insights_live ON fms_insights(tenant_id, cbu, created_at);

-- ── on-call roster ──────────────────────────────────────────────────
-- Who an escalation reaches. Windows are half-open [starts_at, ends_at); a row
-- with ends_at NULL is the standing default for its CBU.
CREATE TABLE IF NOT EXISTS fms_oncall (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  cbu         TEXT,                          -- NULL = all sites
  name        TEXT NOT NULL,
  role        TEXT,                           -- primary | secondary | manager
  phone       TEXT, email TEXT, teams_id TEXT, line_id TEXT,
  starts_at   INTEGER, ends_at INTEGER,
  tz          TEXT DEFAULT 'America/Los_Angeles',
  enabled     INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fms_oncall_window ON fms_oncall(tenant_id, cbu, starts_at, ends_at);

-- ── AI call audit ───────────────────────────────────────────────────
-- Every copilot/RCA call, for cost control and so an answer can be traced back
-- to the data it was given. Prompt and answer are stored; device credentials
-- are never part of either payload.
CREATE TABLE IF NOT EXISTS fms_ai_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  user_id       TEXT,
  kind          TEXT NOT NULL,               -- copilot | rca | insight | battery
  device_id     INTEGER,
  alert_id      INTEGER,
  model         TEXT,
  question      TEXT,
  answer        TEXT,
  input_tokens  INTEGER, output_tokens INTEGER,
  latency_ms    INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fms_ai_log_user ON fms_ai_log(tenant_id, user_id, created_at);

-- ── escalation on the existing alarm routes ─────────────────────────
-- The rules table in the alarm centre already has an escalation column; it has
-- been reading "—" because there was nowhere to store the value.
ALTER TABLE fms_alarm_routes ADD COLUMN escalate_after_min INTEGER;
ALTER TABLE fms_alarm_routes ADD COLUMN escalate_to TEXT;
