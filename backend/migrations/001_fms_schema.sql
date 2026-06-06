-- C-Flex FMS schema additions on top of the v2 ups_devices / alerts / tickets tables.
-- Idempotent: every column add is wrapped so a re-run is harmless.

-- ── 1. ups_devices: CBU, location, mute, geo, control credentials ────
ALTER TABLE ups_devices ADD COLUMN location TEXT DEFAULT '';
ALTER TABLE ups_devices ADD COLUMN room TEXT DEFAULT '';
ALTER TABLE ups_devices ADD COLUMN rack TEXT DEFAULT '';
ALTER TABLE ups_devices ADD COLUMN muted_until INTEGER;
ALTER TABLE ups_devices ADD COLUMN muted_reason TEXT;
ALTER TABLE ups_devices ADD COLUMN lat REAL;
ALTER TABLE ups_devices ADD COLUMN lng REAL;
ALTER TABLE ups_devices ADD COLUMN cbu TEXT;

-- SNMP v3 read-write credentials (separate from read-only)
ALTER TABLE ups_devices ADD COLUMN snmp_v3_rw_user TEXT;
ALTER TABLE ups_devices ADD COLUMN snmp_v3_rw_auth_password TEXT;
ALTER TABLE ups_devices ADD COLUMN snmp_v3_rw_priv_password TEXT;

-- NMC HTTP API credentials (REST endpoint on the card itself)
ALTER TABLE ups_devices ADD COLUMN nmc_http_user TEXT;
ALTER TABLE ups_devices ADD COLUMN nmc_http_password TEXT;

-- EcoStruxure IT Expert device handle
ALTER TABLE ups_devices ADD COLUMN ecostruxure_device_id TEXT;

-- ── 2. alerts.ticket_id (so an alarm can point at the ticket it created) ─
ALTER TABLE alerts ADD COLUMN ticket_id INTEGER;

-- ── 3. tickets: AI RCA columns ──
ALTER TABLE tickets ADD COLUMN rca_summary TEXT;
ALTER TABLE tickets ADD COLUMN rca_actions TEXT;       -- JSON array of recommended actions
ALTER TABLE tickets ADD COLUMN rca_confidence REAL;    -- 0.0..1.0
ALTER TABLE tickets ADD COLUMN rca_model TEXT;
ALTER TABLE tickets ADD COLUMN rca_cost_usd REAL;
ALTER TABLE tickets ADD COLUMN rca_generated_at INTEGER;
ALTER TABLE tickets ADD COLUMN rca_error TEXT;

-- ── 4. Notification routes + dispatch log ──
CREATE TABLE IF NOT EXISTS fms_alarm_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  channel TEXT NOT NULL,        -- 'sms' | 'teams' | 'line' | 'email'
  min_priority TEXT DEFAULT 'P2',
  target TEXT NOT NULL,         -- phone, teamId/channelId, lineId, email
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fms_alarm_dispatch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER, channel TEXT, target TEXT, ok INTEGER, error TEXT, sent_at INTEGER
);

-- ── 5. Per-device threshold overrides ──
CREATE TABLE IF NOT EXISTS ups_thresholds (
  device_id INTEGER PRIMARY KEY,
  battery_warn REAL, battery_critical REAL,
  load_warn REAL,    load_critical REAL,
  temp_warn REAL,    temp_critical REAL,
  runtime_warn REAL, runtime_critical REAL,
  updated_at INTEGER
);

-- ── 6. Monthly PDF report log ──
CREATE TABLE IF NOT EXISTS fms_report_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER, year INTEGER, month INTEGER,
  recipients TEXT, ok INTEGER, error TEXT, message_id TEXT, sent_at INTEGER
);

-- ── 7. Device-control audit log + per-tenant feature flag ──
CREATE TABLE IF NOT EXISTS fms_control_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER, device_id INTEGER, device_label TEXT,
  action TEXT, channel TEXT,       -- snmp | nmc_http | ecostruxure
  params TEXT, ok INTEGER, result TEXT, error TEXT,
  user_email TEXT, user_id INTEGER,
  dry_run INTEGER DEFAULT 0, executed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctrl_log_tenant_time ON fms_control_log(tenant_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ctrl_log_device ON fms_control_log(device_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS fms_control_config (
  tenant_id INTEGER PRIMARY KEY,
  control_enabled INTEGER DEFAULT 0,
  snmp_enabled INTEGER DEFAULT 0,
  nmc_http_enabled INTEGER DEFAULT 0,
  ecostruxure_enabled INTEGER DEFAULT 0,
  ecostruxure_client_id TEXT,
  ecostruxure_client_secret TEXT,
  ecostruxure_org_id TEXT,
  require_2fa INTEGER DEFAULT 1,
  allowed_actions TEXT,          -- JSON array of allowed action keys
  updated_at INTEGER, updated_by TEXT
);
