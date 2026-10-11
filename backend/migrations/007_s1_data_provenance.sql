-- Sprint 1 (10/13-10/24) — data, provenance and probe health.
--
-- Roadmap item 3 calls this "005". 005 and 006 are already applied on the live
-- DB, so it ships as 007; the content is the item-3 list minus what is already
-- there. Already present and NOT repeated here:
--
--   fms_cbu                      001/004 + the KMX row (4 rows, CBU_ADDRESS gone)
--   alerts.simulated             005
--   alerts.object_id             005
--   ups_metrics.simulated        earlier
--
-- Everything below is the actual delta.

-- ── Planning attributes on a device ────────────────────────────────
-- The capacity module reads these off the record first and the catalogue
-- second, so a surveyed figure always beats a library one. Until now there was
-- nowhere to put a surveyed figure: every number came from the catalogue and
-- every total was therefore a planning estimate wearing a measurement's
-- clothes.
ALTER TABLE fms_devices ADD COLUMN rated_w REAL;        -- nameplate, from the label on the unit
ALTER TABLE fms_devices ADD COLUMN measured_w REAL;     -- a real reading, from a metered PDU outlet
ALTER TABLE fms_devices ADD COLUMN poe_w REAL;          -- PoE actually drawn, not the budget
ALTER TABLE fms_devices ADD COLUMN weight_kg REAL;      -- floor loading is a real limit in these rooms
ALTER TABLE fms_devices ADD COLUMN lib_id TEXT;         -- the catalogue entry an operator picked

-- ── Room electrical context ───────────────────────────────────────
-- Every breaker's kW capacity is amps x volts, so one wrong voltage is every
-- capacity in the room wrong at once. KMX Pesqueria is 127/220 V; the North
-- American 120/208 V default understates every circuit there by 6 %.
ALTER TABLE fms_rooms ADD COLUMN voltage_1ph INTEGER;
ALTER TABLE fms_rooms ADD COLUMN voltage_3ph INTEGER;
ALTER TABLE fms_rooms ADD COLUMN frequency_hz INTEGER;

-- ── Probe health ──────────────────────────────────────────────────
-- A probe that dies is indistinguishable, on screen, from a site where nothing
-- is wrong: the devices go stale, the freshness gate reports nodata, and
-- nothing raises its hand. This table is what makes a dead probe an alarmable
-- fact.
--
-- `probes` already exists and holds enrolment (uuid, key hash, capabilities).
-- It carries one last_seen_at and nothing about whether the polling it is
-- doing is working. This is the per-cycle health record beside it: one row per
-- probe, overwritten each heartbeat, plus the counters a 10-minute silence
-- check and an operator both need.
CREATE TABLE IF NOT EXISTS probe_status (
  probe_id      TEXT PRIMARY KEY,         -- probes.probe_uuid, or 'inproc' for the in-process poller
  tenant_id     INTEGER,
  cbu           TEXT,                     -- which site this probe is responsible for
  label         TEXT,
  last_seen     INTEGER,                  -- ms epoch of the last heartbeat
  version       TEXT,
  host          TEXT,                     -- hostname / IP the heartbeat came from
  poll_ok       INTEGER DEFAULT 0,        -- devices polled successfully in the last cycle
  poll_fail     INTEGER DEFAULT 0,        -- devices that timed out or errored
  devices       INTEGER DEFAULT 0,        -- devices this probe is assigned
  cycle_ms      INTEGER,                  -- how long the last cycle took, for the starvation check
  last_error    TEXT,
  down_alerted_at INTEGER,                -- so the P2 is raised once, not every minute
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_probe_status_seen ON probe_status(last_seen);
CREATE INDEX IF NOT EXISTS idx_probe_status_cbu ON probe_status(tenant_id, cbu);

-- ── Metrics for everything that is not a UPS ──────────────────────
-- ups_metrics is a wide table with a column per UPS reading, which cannot hold
-- a PDU phase current, a NetBotz humidity, a switch port count or a CRAC
-- supply temperature. This is the narrow table the new collectors write to:
-- one row per (subject, metric, timestamp).
--
-- `source` is the point. A number on screen must be able to say where it came
-- from, because "measured" and "estimated from a catalogue" are different
-- claims and the roadmap's trust rule ranks them. A row with no source is not
-- allowed to exist.
CREATE TABLE IF NOT EXISTS fms_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  cbu         TEXT,
  subject_type TEXT NOT NULL,             -- 'device' | 'object'
  subject_id  INTEGER,                    -- fms_devices.id, when subject_type='device'
  subject_name TEXT,                      -- fms_objects name, when subject_type='object'
  metric      TEXT NOT NULL,              -- 'load_a_l1', 'temp_c', 'humidity_pct', 'ports_up', ...
  value       REAL,
  unit        TEXT,
  str_value   TEXT,                       -- for states that are not numbers ('closed', 'wet')
  source      TEXT NOT NULL,              -- measured | nameplate | library | simulated
  probe_id    TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fms_metrics_subject ON fms_metrics(tenant_id, subject_type, subject_id, metric, ts);
CREATE INDEX IF NOT EXISTS idx_fms_metrics_name ON fms_metrics(tenant_id, subject_name, metric, ts);
CREATE INDEX IF NOT EXISTS idx_fms_metrics_ts ON fms_metrics(ts);

-- ── SNMPv3 reachability survey ────────────────────────────────────
-- Item 2 produces a CSV for the HAEA request. The same findings are kept in the
-- DB so the next survey can be diffed against this one rather than against a
-- file somebody has to find.
CREATE TABLE IF NOT EXISTS snmp_reach (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER,
  cbu         TEXT,
  device_id   INTEGER,
  label       TEXT,
  ip          TEXT,
  version     TEXT,                       -- '2c' | '3'
  ok          INTEGER NOT NULL,           -- 1 = answered
  rtt_ms      INTEGER,
  sys_descr   TEXT,                       -- the NMC firmware string, when it answers
  nmc_version TEXT,
  failure     TEXT,                       -- 'timeout' | 'no-route' | 'auth' | 'refused'
  probe_host  TEXT,                       -- where the test was run FROM, which is half the finding
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snmp_reach_run ON snmp_reach(ts);
CREATE INDEX IF NOT EXISTS idx_snmp_reach_dev ON snmp_reach(device_id, ts);

-- ── SNMPv3 credentials per device ─────────────────────────────────
-- ups_devices already carries snmp_v3_user and the auth/priv columns. The
-- network gear the new collectors reach does not live in ups_devices, so it
-- needs the same option. Values are written by the operator and never read back
-- out of the API.
ALTER TABLE fms_devices ADD COLUMN snmp_version TEXT;     -- '2c' | '3'
ALTER TABLE fms_devices ADD COLUMN snmp_community TEXT;
ALTER TABLE fms_devices ADD COLUMN snmp_port INTEGER;
ALTER TABLE fms_devices ADD COLUMN snmp_v3_user TEXT;
ALTER TABLE fms_devices ADD COLUMN snmp_v3_auth_protocol TEXT;
ALTER TABLE fms_devices ADD COLUMN snmp_v3_auth_password TEXT;
ALTER TABLE fms_devices ADD COLUMN snmp_v3_priv_protocol TEXT;
ALTER TABLE fms_devices ADD COLUMN snmp_v3_priv_password TEXT;
ALTER TABLE fms_devices ADD COLUMN polling_enabled INTEGER DEFAULT 0;
ALTER TABLE fms_devices ADD COLUMN consecutive_fails INTEGER DEFAULT 0;
ALTER TABLE fms_devices ADD COLUMN poll_error TEXT;

-- ── When a device last actually answered ──────────────────────────
-- `last_polled` is written on failure too — it records that an attempt was
-- made, not that a reading was obtained. The freshness gate reads it, so 41
-- HAEA devices currently report as "polled within 5 minutes" while every one of
-- them timed out and has no value at all. Exit criterion 2 asks for values that
-- are fresh within five minutes, which is a question only this column can
-- answer.
--
-- NOTE for Eric: the v4 brief said not to change `ups_devices`. This is an
-- additive column with no default behaviour change, and 1.x reads columns by
-- name, so nothing there is affected. Flagging it because it is a deliberate
-- departure from that rule, for the reason above.
ALTER TABLE ups_devices ADD COLUMN last_ok_polled INTEGER;
ALTER TABLE fms_devices ADD COLUMN last_ok_polled INTEGER;
