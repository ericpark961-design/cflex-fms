-- C-Flex FMS 2.0 — v4 S2 storage + v5 alarm workbench, in one migration.
--
-- WHY THIS IS SQLITE AND NOT POSTGRES
-- 0010_incidents_layer.sql is Postgres (UUID / JSONB / TIMESTAMPTZ) and targets
-- cflex_tickets in the cflex_monorepo database. That is the monorepo track, and
-- it is NOT the store the FMS API serves: /v1/fms/* and /v1/incidents run
-- against the SQLite file at cflex-api/data/cflex.db, whose tables are
-- `tickets` / `ticket_notes` / `ticket_rca` / `alerts` (no cflex_ prefix). The
-- RCA columns fms-rca.js writes are already on `tickets` there.
--
-- v5 §3.1 says to follow 0010's conventions for whichever store is real, so
-- 0010's gap list (severity, cbu, source, dedup_key, ack state, alarm links,
-- note kind/body_json) is ported here as SQLite DDL against those tables. A
-- cross-store design would put triage's context collection — metrics,
-- thresholds, power links, control log, alarm routes, all SQLite — on the far
-- side of a network hop from the incident it is reasoning about.
--
-- Incident ids are therefore INTEGER (tickets.id), not the UUID/TEXT 0010 uses.
--
-- Additive only, and free of transaction/trigger statements (apply.js refuses to
-- split those; note it scans the raw text, comments included). It
-- swallows exactly "duplicate column name", so re-running is safe.
-- All timestamps are Date.now() milliseconds, matching alerts.received_at.

-- ══ v4 S2 ═══════════════════════════════════════════════════════════

-- AI insights behind the dashboard's "AI 인사이트" panel. Nothing is computed at
-- read time, so a panel with no rows says "데이터 축적 중" instead of guessing.
CREATE TABLE IF NOT EXISTS fms_insights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  cbu         TEXT,                          -- NULL = fleet-wide
  kind        TEXT NOT NULL,                 -- risk | capacity | battery | thermal | anomaly
  severity    TEXT NOT NULL DEFAULT 'info',  -- info | warn | critical
  device_id   TEXT,                          -- 'ups-<n>' as alerts spells it, so TEXT
  title       TEXT NOT NULL,
  body        TEXT,
  evidence    TEXT,                          -- JSON: the rows/metrics the claim rests on
  confidence  REAL,                          -- 0..1, NULL when not a model output
  source      TEXT NOT NULL DEFAULT 'rule',  -- rule | ai
  model       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                        -- stale insights disappear rather than mislead
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fms_insights_live ON fms_insights(tenant_id, cbu, created_at);

-- Who an escalation reaches. Windows are half-open [starts_at, ends_at); a row
-- with ends_at NULL is the standing default for its CBU.
CREATE TABLE IF NOT EXISTS fms_oncall (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  cbu         TEXT,
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

-- ══ v5 — triage, dispatch, memory, cost ═════════════════════════════

-- Every AI call: triage, re-evaluation, MOP, RCA. Cost control (v5 §2 caps) and
-- traceability — an answer can be tied back to the data it was given. Device
-- credentials are never part of either payload.
CREATE TABLE IF NOT EXISTS fms_ai_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  incident_id   INTEGER,
  user_id       TEXT,
  kind          TEXT NOT NULL,               -- triage | reeval | mop | rca | copilot | insight
  device_id     TEXT,
  alert_id      INTEGER,
  model         TEXT,
  question      TEXT,
  answer        TEXT,
  tokens_in     INTEGER, tokens_out INTEGER,
  cost_usd      REAL,
  latency_ms    INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fms_ai_log_cost ON fms_ai_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fms_ai_log_incident ON fms_ai_log(incident_id, created_at);

-- Engineer dispatch, with the MOP the AI drafted attached to the record.
CREATE TABLE IF NOT EXISTS fms_dispatch (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  incident_id INTEGER NOT NULL,
  engineer    TEXT,
  skill       TEXT,                           -- e.g. "UPS L2"
  urgency     TEXT,                           -- now | 4h | next-day
  eta_min     INTEGER,
  mop         TEXT,                           -- markdown procedure draft
  channel     TEXT,                           -- teams | sms | email (where it was sent)
  sent_at     INTEGER, accepted_at INTEGER, arrived_at INTEGER, done_at INTEGER,
  note        TEXT,
  created_by  TEXT,
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fms_dispatch_incident ON fms_dispatch(incident_id, created_at);

-- Fleet learning, first step: a human's ✓/✗ on a hypothesis. The next triage
-- for the same device+metric gets the top confirmed causes as prior context.
CREATE TABLE IF NOT EXISTS fms_triage_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  incident_id   INTEGER,
  hypothesis_id TEXT,
  cause         TEXT,                         -- denormalised so a confirmed cause survives
  device_id     TEXT,
  metric        TEXT,
  outcome       TEXT NOT NULL,                -- confirmed | rejected
  user_id       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triage_fb_lookup ON fms_triage_feedback(tenant_id, device_id, metric, outcome);

-- One incident, many follow-up alarms (0010's cflex_incident_alarm_links).
CREATE TABLE IF NOT EXISTS incident_alarm_links (
  incident_id  INTEGER NOT NULL,
  alarm_id     INTEGER NOT NULL,
  alarm_source TEXT NOT NULL DEFAULT 'fms',
  attached_at  INTEGER NOT NULL,
  PRIMARY KEY (incident_id, alarm_source, alarm_id)
);
CREATE INDEX IF NOT EXISTS idx_inc_links_alarm ON incident_alarm_links(alarm_source, alarm_id);

-- ══ column additions ════════════════════════════════════════════════

-- Triage lives on the incident so the workbench reads one row (v5 §3.1).
ALTER TABLE tickets ADD COLUMN triage TEXT;
ALTER TABLE tickets ADD COLUMN triage_at INTEGER;
ALTER TABLE tickets ADD COLUMN triage_source TEXT;
ALTER TABLE tickets ADD COLUMN verify_state TEXT;

-- 0010's gap list, ported. `status` already holds open/in_progress/resolved/
-- closed; 'ack' joins it, guarded by incident/state_machine.js rather than a
-- CHECK constraint (SQLite cannot add one to an existing table).
ALTER TABLE tickets ADD COLUMN severity TEXT;
ALTER TABLE tickets ADD COLUMN cbu TEXT;
ALTER TABLE tickets ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE tickets ADD COLUMN dedup_key TEXT;
ALTER TABLE tickets ADD COLUMN channels TEXT DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN ack_at INTEGER;
ALTER TABLE tickets ADD COLUMN ack_by TEXT;
ALTER TABLE tickets ADD COLUMN closed_at INTEGER;

-- Timeline: a note is now a typed event, not just prose.
ALTER TABLE ticket_notes ADD COLUMN kind TEXT DEFAULT 'comment';
ALTER TABLE ticket_notes ADD COLUMN body_json TEXT;

-- The alarm centre renders an escalation column that could only read '—'.
ALTER TABLE fms_alarm_routes ADD COLUMN escalate_after_min INTEGER;
ALTER TABLE fms_alarm_routes ADD COLUMN escalate_to TEXT;

-- ══ indexes that depend on the new columns ══════════════════════════
-- One active incident per dedup_key: a repeating alarm appends to the timeline
-- instead of opening a second incident.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_dedup_active
  ON tickets(tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('open', 'ack', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tickets_severity ON tickets(severity, status);
CREATE INDEX IF NOT EXISTS idx_tickets_cbu ON tickets(cbu, status);
CREATE INDEX IF NOT EXISTS idx_notes_kind ON ticket_notes(ticket_id, kind);

-- ══ 부록 K — CBU registry and simulation flags ══════════════════════

-- CBU_ADDRESS was three hard-coded objects in fms.routes.js, so adding KMX
-- meant a code deploy and the alarm map could only pin sites whose devices
-- already carried lat/lng. The registry is a table now; summary.cbu_list,
-- sites-map, the alarm map and the CBU toggle all read it.
--
-- Keyed on (tenant_id, cbu) but joined on cbu alone, so splitting HAEM onto its
-- own tenant before UAT is an UPDATE of fms_cbu.tenant_id and nothing else.
CREATE TABLE IF NOT EXISTS fms_cbu (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  cbu          TEXT NOT NULL,
  company      TEXT,
  display      TEXT,
  full_address TEXT,
  lat          REAL, lng REAL,
  timezone     TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  note         TEXT,
  updated_at   INTEGER,
  UNIQUE(tenant_id, cbu)
);

-- The three that were hard-coded, plus KMX. Coordinates are pin-grade; the
-- Pesqueria address is provisional until the survey (부록 K1).
INSERT OR IGNORE INTO fms_cbu (tenant_id, cbu, company, display, full_address, lat, lng, timezone, note, updated_at)
VALUES
  (10, 'HMA',     'Hyundai Motor America', 'Fountain Valley, CA', '10550 Talbert Ave, Fountain Valley, CA 92708', 33.7033, -117.9470, 'America/Los_Angeles', NULL, 0),
  (10, 'KUS',     'Kia America',           'Irvine, CA',          '111 Peters Canyon Rd, Irvine, CA 92606',       33.6978, -117.7700, 'America/Los_Angeles', NULL, 0),
  (10, 'HAEA_HQ', 'HAEA HQ',               'Irvine, CA',          '2300 Main St, Irvine, CA 92614',               33.6846, -117.8265, 'America/Los_Angeles', NULL, 0),
  (10, 'KMX',     'Kia Mexico (KMX)',      'Pesqueria, NL',       'Pesqueria, Nuevo Leon, Mexico',                25.7800, -100.0500, 'America/Monterrey', 'plant-area pin, address pending survey', 0);

-- Simulation, kept in the schema rather than in a naming convention. A demo
-- row must never reach a KPI, an SLA number, fleet-live or a monthly report,
-- and must be removable in one statement.
ALTER TABLE alerts ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ups_metrics ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;

-- Object-level alarms: a CRAC or a leak zone has no ups_devices row, so an
-- alarm against a ledger object needs its own reference (부록 K2).
ALTER TABLE alerts ADD COLUMN object_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_alerts_simulated ON alerts(tenant_id, simulated, received_at);
CREATE INDEX IF NOT EXISTS idx_metrics_simulated ON ups_metrics(device_id, simulated, ts);
