-- C-Flex FMS v3 — the placement ledger behind the 3D twin.
--
-- v2's 3D scene guessed rack positions by parsing rack names. This gives rooms,
-- objects and power links real coordinates so the scene draws what is actually
-- there, and so a rack click can trace its supply upstream.
--
-- Additive only: no existing column changes, no existing endpoint changes.
--
-- Coordinates are in TILES (one 600 mm floor tile). Room origin is the top-left
-- corner, `col` increases to the right (+x), `row` increases downward (+z).
--
-- Idempotency: SQLite has no "ADD COLUMN IF NOT EXISTS", so re-running the three
-- ALTERs raises "duplicate column name". migrations/apply.js swallows exactly that
-- error and nothing else — do not add other ALTERs without checking it.

-- ── rooms ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fms_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  cbu        TEXT,
  location   TEXT NOT NULL,                 -- matches ups_devices.location 1:1
  name       TEXT NOT NULL,                 -- matches ups_devices.room 1:1
  cols       INTEGER NOT NULL DEFAULT 20,
  rows       INTEGER NOT NULL DEFAULT 12,
  tile_mm    INTEGER NOT NULL DEFAULT 600,
  height_mm  INTEGER NOT NULL DEFAULT 3000,
  note       TEXT,
  updated_at INTEGER,                       -- Date.now() ms, same unit as last_polled
  UNIQUE(tenant_id, location, name)
);

-- ── placeable objects ───────────────────────────────────────────────
-- Non-UPS equipment (PDU, panel, CRAC, sensor, leak zone) lives here too, keyed
-- by `kind`. The 3D scene treats everything as "an object with a footprint", so a
-- separate table per equipment type would buy nothing.
CREATE TABLE IF NOT EXISTS fms_racks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  room_id    INTEGER NOT NULL REFERENCES fms_rooms(id),
  name       TEXT NOT NULL,                 -- matches ups_devices.rack 1:1
  col        INTEGER NOT NULL,
  row        INTEGER NOT NULL,
  w          INTEGER NOT NULL DEFAULT 1,
  d          INTEGER NOT NULL DEFAULT 2,
  face       TEXT NOT NULL DEFAULT 'S',     -- N | S | E | W
  u_height   INTEGER NOT NULL DEFAULT 42,
  kind       TEXT NOT NULL DEFAULT 'rack',  -- rack | ups_cabinet | pdu_cabinet | panel | crac | sensor | leak_zone | door | pillar
  attrs      TEXT,                          -- JSON: {capacity_kw, rated_a, zone_poly:[[col,row],...], ...}
  updated_at INTEGER,
  UNIQUE(tenant_id, room_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fms_racks_room ON fms_racks(tenant_id, room_id);

-- ── device placement (NULL rack_id falls back to v2 name matching) ──
ALTER TABLE ups_devices ADD COLUMN rack_id INTEGER;
ALTER TABLE ups_devices ADD COLUMN u_pos INTEGER;
ALTER TABLE ups_devices ADD COLUMN u_height INTEGER;

-- ── non-UPS equipment ───────────────────────────────────────────────
-- Network, UC and server gear lives here rather than in ups_devices: the polling
-- logic is different (SNMP ifOperStatus / ICMP / HTTPS health) and mixing them
-- would drag that into the UPS poller. /v1/fms/assets stays UPS-only; floor and
-- topology merge both and tag each row with `kind`.
CREATE TABLE IF NOT EXISTS fms_devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  cbu        TEXT,
  kind       TEXT NOT NULL,              -- switch | router | sbc | server | pdu | patch | storage | ups | other
  label      TEXT NOT NULL,
  vendor     TEXT, model TEXT, serial TEXT, ip TEXT,
  rack_id    INTEGER REFERENCES fms_racks(id),
  u_pos      INTEGER, u_height INTEGER DEFAULT 1,
  location   TEXT, room TEXT, rack TEXT, -- string fallback when rack_id is null, same rule as ups_devices
  status     TEXT DEFAULT 'nodata',      -- no collector yet: stays nodata, never a fake 'ok'
  last_polled INTEGER,
  ports_total INTEGER, ports_up INTEGER,
  attrs      TEXT,                       -- JSON
  decommissioned_at INTEGER,
  updated_at INTEGER,
  UNIQUE(tenant_id, label)
);
CREATE INDEX IF NOT EXISTS idx_fms_devices_rack ON fms_devices(tenant_id, rack_id);

-- ── power links ─────────────────────────────────────────────────────
-- Direction is load → upstream: `src` is the side that RECEIVES power, `dst` is
-- the side that SUPPLIES it. Tracing a chain means following src → dst.
CREATE TABLE IF NOT EXISTS fms_power_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  src_type   TEXT NOT NULL,                 -- ups_device | device (fms_devices.id) | object (fms_racks.id)
  src_id     INTEGER NOT NULL,
  src_port   TEXT,
  dst_type   TEXT NOT NULL,
  dst_id     INTEGER NOT NULL,
  dst_port   TEXT,
  circuit    TEXT,
  rated_a    REAL,
  phase      TEXT,
  note       TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_power_links_src ON fms_power_links(tenant_id, src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_power_links_dst ON fms_power_links(tenant_id, dst_type, dst_id);
