-- Local Console schema (SQLite; PostgreSQL 16 in WO-INT-008). Idempotent.
-- Times are epoch milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT,
  email         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  pw_hash       TEXT NOT NULL,
  pw_changed_at INTEGER NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 1,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Append-only (spec 01 §4): the triggers refuse UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  ip      TEXT,
  node    TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS sites (
  id        TEXT PRIMARY KEY,               -- contract site code, e.g. HMA-FV
  name      TEXT NOT NULL,
  company   TEXT,
  timezone  TEXT NOT NULL DEFAULT 'America/Los_Angeles'
);

CREATE TABLE IF NOT EXISTS devices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id         TEXT NOT NULL UNIQUE,   -- contract §2 sha1(tenant|site|serial)[:16]
  site_id           TEXT NOT NULL REFERENCES sites(id),
  label             TEXT NOT NULL,
  vendor            TEXT,
  model             TEXT,
  serial            TEXT,
  serial_alt        TEXT,                   -- JSON array (modular frames/modules)
  nmc_ip            TEXT,
  building          TEXT,
  floor             TEXT,
  room              TEXT,
  rack              TEXT,
  firmware          TEXT,
  mfg_date          TEXT,                   -- YYYY-MM
  battery_installed TEXT,
  battery_due       TEXT,
  in_sow            INTEGER NOT NULL DEFAULT 1,
  polling_enabled   INTEGER NOT NULL DEFAULT 1,
  thresholds        TEXT,                   -- JSON per-device override
  -- latest reading, kept on the row so the fleet list is one query
  last_ts           INTEGER,
  comm_ok           INTEGER,
  battery_pct       REAL,
  load_pct          REAL,
  temp_c            REAL,
  runtime_min       REAL,
  output_v          REAL,
  input_v           REAL,
  ups_status        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_site ON devices(site_id);

CREATE TABLE IF NOT EXISTS telemetry (
  device_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  battery_pct REAL,
  load_pct    REAL,
  temp_c      REAL,
  runtime_min REAL,
  comm_ok     INTEGER,
  m           TEXT,
  PRIMARY KEY (device_id, ts)
);

-- One row per alarm (contract alarm_id); the events are its history.
CREATE TABLE IF NOT EXISTS alarms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_id       TEXT NOT NULL UNIQUE,
  device_id      TEXT,
  site_id        TEXT,
  code           TEXT NOT NULL,
  severity       TEXT NOT NULL,
  title          TEXT,
  state          TEXT NOT NULL CHECK (state IN ('open', 'cleared')),
  raised_at      INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  cleared_at     INTEGER,
  acked_at       INTEGER,
  acked_by       TEXT,
  detail         TEXT,
  local_notified TEXT,
  maintenance    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alarms_state ON alarms(state, severity);
CREATE INDEX IF NOT EXISTS idx_alarms_raised ON alarms(raised_at);

CREATE TABLE IF NOT EXISTS alarm_events (
  event_id  TEXT PRIMARY KEY,               -- contract event_id: replays are no-ops
  alarm_id  TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  title     TEXT,
  detail    TEXT,
  local_notified TEXT                       -- what the console delivered for this event (JSON), returned again on a replay
);
CREATE INDEX IF NOT EXISTS idx_alarm_events_alarm ON alarm_events(alarm_id, ts);

-- alarm_id → ServiceNow incident, so a clear resolves the ticket its raise
-- opened — on either node and across restarts (notify.js).
CREATE TABLE IF NOT EXISTS itsm_map (
  alarm_id  TEXT PRIMARY KEY,
  value     TEXT NOT NULL,                  -- {number, sys_id, code, device_id, opened, updated?, resolved?}
  updated   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alarm_comments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_id  TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  author    TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'comment',  -- comment | ack | unack
  text      TEXT
);

CREATE TABLE IF NOT EXISTS maintenance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT,                         -- contract device_id; NULL with site NULL = whole node
  site_id     TEXT,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  reason      TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- SNMP credentials: per site (device_id NULL) or per device. secret is AES-GCM sealed.
CREATE TABLE IF NOT EXISTS credentials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     TEXT,
  device_id   TEXT,
  version     TEXT NOT NULL CHECK (version IN ('1', '2c', '3')),
  username    TEXT,                         -- v3 user (not secret)
  auth_proto  TEXT,
  priv_proto  TEXT,
  secret      TEXT,                         -- sealed JSON {community|auth_key,priv_key}
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL,
  UNIQUE (site_id, device_id)
);

-- Key/value settings: thresholds, notify channels (secrets sealed), portal status.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collectors (
  node_id     TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  heartbeat   TEXT
);
