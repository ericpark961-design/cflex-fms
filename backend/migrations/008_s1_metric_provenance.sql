-- Sprint 1 items 5-6 — what the collectors write, and where each number came
-- from.
--
-- 007 created fms_metrics with a `source` column. Collecting against real
-- hardware made two more columns necessary, and both exist for the same
-- reason: a wrong SCALE is worse than a missing value, because it looks like a
-- measurement.
--
-- rPDU2PhaseStatusCurrent returns tenths of an amp. Read as amps, a 16 A
-- circuit reports 160 A and every capacity figure above it becomes nonsense —
-- and nothing on the screen would look wrong. ENTITY-SENSOR is worse: its
-- scale is an exponent ENUM and its precision a digit count, so applying
-- either as a multiplier turns a 42 degree inlet into 42,000.
--
-- The OIDs in the Liebert and NetBotz profiles are read from the vendor MIBs
-- and have not been confirmed against a unit's own display. That is a real
-- state of knowledge and it is recorded per row rather than assumed away.
ALTER TABLE fms_metrics ADD COLUMN raw_value REAL;    -- the integer the device returned, before scaling
ALTER TABLE fms_metrics ADD COLUMN oid TEXT;          -- which object produced it
ALTER TABLE fms_metrics ADD COLUMN confidence TEXT;   -- verified | documented
ALTER TABLE fms_metrics ADD COLUMN label TEXT;        -- the device's own name for it: 'L1', 'Gi1/0/24', 'Rack A01 inlet'
ALTER TABLE fms_metrics ADD COLUMN notes TEXT;

-- Keeping the raw integer means a scale that proves wrong is a correction in
-- place -- UPDATE value = raw_value * 0.1 -- instead of a month of history
-- thrown away and re-collected.

-- The newest reading per subject and metric is what every screen asks for, and
-- it was a full scan of a table that grows by a few thousand rows an hour.
CREATE INDEX IF NOT EXISTS idx_fms_metrics_latest
  ON fms_metrics(tenant_id, subject_type, subject_id, metric, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fms_metrics_latest_name
  ON fms_metrics(tenant_id, subject_name, metric, ts DESC);

-- ── Which objects a probe should collect ──────────────────────────
-- fms_devices rows were never polled by anything, so these have no meaning
-- there yet. A PDU needs to say whether it is basic, metered or switched (a
-- basic unit has no outlet table and walking it returns a page of
-- noSuchObject), and a CRAC needs to say whether it speaks iCOM SNMP or
-- BACnet -- the one the agent answers "not implemented" to, rather than
-- timing out for eight weeks while looking like a dead unit.
ALTER TABLE fms_devices ADD COLUMN protocol TEXT;     -- snmp | icom | bacnet | modbus
ALTER TABLE fms_devices ADD COLUMN pdu_type TEXT;     -- basic | metered | switched
ALTER TABLE fms_devices ADD COLUMN probe_id TEXT;     -- which probe owns this device

-- ── A room object can be polled too ──────────────────────────────
-- CRACs, PDU cabinets, panels and sensors are not rack-mounted inventory --
-- they are room furniture with a position -- so they live in `fms_racks`
-- alongside the racks themselves, distinguished by `kind`. (The table name is
-- from when it only held racks; every room object has been in it since 004.)
--
-- They still have IP addresses and still answer SNMP. The KMX ledger's three
-- CRACs are exactly the units whose readings the capacity module has been
-- assuming from a nameplate ton rating and a fan percentage typed into JSON.
ALTER TABLE fms_racks ADD COLUMN ip TEXT;
ALTER TABLE fms_racks ADD COLUMN protocol TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_version TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_community TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_port INTEGER;
ALTER TABLE fms_racks ADD COLUMN snmp_v3_user TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_v3_auth_protocol TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_v3_auth_password TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_v3_priv_protocol TEXT;
ALTER TABLE fms_racks ADD COLUMN snmp_v3_priv_password TEXT;
ALTER TABLE fms_racks ADD COLUMN polling_enabled INTEGER DEFAULT 0;
ALTER TABLE fms_racks ADD COLUMN last_polled INTEGER;
ALTER TABLE fms_racks ADD COLUMN last_ok_polled INTEGER;
ALTER TABLE fms_racks ADD COLUMN consecutive_fails INTEGER DEFAULT 0;
ALTER TABLE fms_racks ADD COLUMN poll_error TEXT;
ALTER TABLE fms_racks ADD COLUMN probe_id TEXT;
