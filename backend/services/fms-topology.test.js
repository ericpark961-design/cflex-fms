// node backend/services/fms-topology.test.js
//
// Runs against a real in-memory SQLite built from migrations/004 plus a minimal
// ups_devices, so the SQL is exercised rather than mocked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const T = require('./fms-topology');

// ── a better-sqlite3-shaped wrapper over node:sqlite ────────────────
function makeDb() {
  const raw = new DatabaseSync(':memory:');
  // Only the columns the service touches.
  raw.exec(`CREATE TABLE ups_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, label TEXT, cbu TEXT,
    location TEXT, room TEXT, rack TEXT, status TEXT, last_polled INTEGER,
    health_score INTEGER, battery_pct INTEGER, load_pct INTEGER, temp_c REAL,
    decommissioned_at INTEGER)`);
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/004_fms_topology.sql'), 'utf8');
  for (const s of sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').split(';').map(x => x.trim()).filter(Boolean)) raw.exec(s);
  return {
    prepare(q) {
      const st = raw.prepare(q);
      return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) };
    },
    exec: (q) => raw.exec(q),
  };
}

const FRESH = () => Date.now() - 1000;
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok -', name); };

const LEDGER = {
  cbu: 'KMX',
  rooms: [{
    location: 'KMX Pesquería', name: 'CCR', cols: 24, rows: 14, tile_mm: 600,
    objects: [
      { name: 'A-01', kind: 'rack', col: 3, row: 2 },
      { name: 'PDU-A1', kind: 'pdu_cabinet', col: 2, row: 2, attrs: { rated_a: 63 } },
      { name: 'UPS-A', kind: 'ups_cabinet', col: 20, row: 2, w: 2, d: 2, attrs: { capacity_kw: 40 } },
      { name: 'PANEL-1', kind: 'panel', col: 23, row: 0, attrs: { rated_a: 200 } },
      { name: 'UTILITY', kind: 'panel', col: 23, row: 13, attrs: { utility: true } },
      { name: 'LEAK-A', kind: 'leak_zone', attrs: { zone_poly: [[0, 4], [2, 4], [2, 8], [0, 8]] } },
    ],
    devices: [{ label: 'KMX-UPS-01', rack: 'UPS-A', u_pos: 1, u_height: 10 }],
    power_links: [
      { src: 'A-01', src_type: 'object', dst: 'PDU-A1', dst_type: 'object', dst_port: 'CB-3', rated_a: 16 },
      { src: 'PDU-A1', src_type: 'object', dst: 'KMX-UPS-01', dst_type: 'ups_device', dst_port: 'OUT-1', rated_a: 32 },
      { src: 'KMX-UPS-01', src_type: 'ups_device', dst: 'PANEL-1', dst_type: 'object', circuit: 'LP1-7', rated_a: 63 },
      { src: 'PANEL-1', src_type: 'object', dst: 'UTILITY', dst_type: 'object', circuit: 'MAIN', rated_a: 200 },
    ],
  }],
};

// A DB holding just the device the ledger refers to.
function dbWithDevice() {
  const db = makeDb();
  db.prepare('INSERT INTO ups_devices (tenant_id,label,cbu,location,room,rack,status,last_polled,health_score,battery_pct,load_pct,temp_c) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(10, 'KMX-UPS-01', 'KMX', 'KMX Pesquería', 'CCR', 'UPS-A', 'ok', FRESH(), 92, 100, 48, 24.5);
  return db;
}

function seeded() {
  const db = makeDb();
  db.prepare('INSERT INTO ups_devices (tenant_id,label,cbu,location,room,rack,status,last_polled,health_score,battery_pct,load_pct,temp_c) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(10, 'KMX-UPS-01', 'KMX', 'KMX Pesquería', 'CCR', 'UPS-A', 'ok', FRESH(), 92, 100, 48, 24.5);
  const r = T.importTopology(db, 10, LEDGER, { mode: 'merge' });
  return { db, r };
}

console.log('import');
const { db, r } = seeded();
t('creates rooms, objects, links and places the device', () => {
  assert.strictEqual(r.rooms, 1);
  assert.strictEqual(r.objects, 6);
  assert.strictEqual(r.links, 4);
  assert.strictEqual(r.placed_devices, 1);
  assert.deepStrictEqual(r.unplaced, []);
});
t('is idempotent — re-import does not duplicate', () => {
  T.importTopology(db, 10, LEDGER, { mode: 'merge' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM fms_rooms').get().c, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM fms_racks').get().c, 6);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM fms_power_links').get().c, 4);
});
t('rejects a link to an object that is not in the ledger', () => {
  const bad = JSON.parse(JSON.stringify(LEDGER));
  bad.rooms[0].power_links.push({ src: 'A-01', src_type: 'object', dst: 'GHOST', dst_type: 'object' });
  assert.throws(() => T.importTopology(dbWithDevice(), 10, bad), /unknown object "GHOST"/);
});
t('rejects an unknown object kind', () => {
  const bad = JSON.parse(JSON.stringify(LEDGER));
  bad.rooms[0].objects.push({ name: 'X', kind: 'teleporter', col: 1, row: 1 });
  assert.throws(() => T.importTopology(dbWithDevice(), 10, bad), /unknown object kind/);
});

console.log('export round-trip');
t('export reproduces the ledger it imported', () => {
  const out = T.exportTopology(db, 10, 'KMX');
  const room = out.rooms[0];
  assert.strictEqual(out.cbu, 'KMX');
  assert.strictEqual(room.location, 'KMX Pesquería');
  assert.strictEqual(room.cols, 24);
  assert.strictEqual(room.objects.length, 6);
  assert.deepStrictEqual(room.objects.find(o => o.name === 'LEAK-A').attrs.zone_poly, [[0, 4], [2, 4], [2, 8], [0, 8]]);
  assert.deepStrictEqual(room.devices, [{ label: 'KMX-UPS-01', rack: 'UPS-A', u_pos: 1, u_height: 10 }]);
  assert.strictEqual(room.power_links.length, 4);
});
t('re-importing an export produces the same row counts', () => {
  const db2 = makeDb();
  db2.prepare('INSERT INTO ups_devices (tenant_id,label,cbu,location,room,rack,status,last_polled) VALUES (?,?,?,?,?,?,?,?)')
    .run(10, 'KMX-UPS-01', 'KMX', 'KMX Pesquería', 'CCR', 'UPS-A', 'ok', FRESH());
  const again = T.importTopology(db2, 10, T.exportTopology(db, 10, 'KMX'));
  assert.strictEqual(again.objects, 6);
  assert.strictEqual(again.links, 4);
  assert.strictEqual(again.placed_devices, 1);
});

console.log('power chain');
t('traces rack → PDU → UPS → panel → utility', () => {
  const rackId = db.prepare("SELECT id FROM fms_racks WHERE name='A-01'").get().id;
  const { chain, upstream_capacity_a } = T.powerChainForObject(db, 10, rackId);
  assert.deepStrictEqual(chain.map(c => c.name), ['A-01', 'PDU-A1', 'KMX-UPS-01', 'PANEL-1', 'UTILITY']);
  assert.strictEqual(chain[1].kind, 'pdu_cabinet');
  assert.strictEqual(chain[2].type, 'ups_device');
  // the weakest rated link is what actually limits the load
  assert.strictEqual(upstream_capacity_a, 16);
});
t('traces from a device too, and reports its load', () => {
  const devId = db.prepare("SELECT id FROM ups_devices WHERE label='KMX-UPS-01'").get().id;
  const r2 = T.powerChainForDevice(db, 10, devId);
  assert.deepStrictEqual(r2.chain.map(c => c.name), ['KMX-UPS-01', 'PANEL-1', 'UTILITY']);
  assert.strictEqual(r2.load_pct, 48);
});
t("accepts the alerts' 'ups-NN' id shape", () => {
  const devId = db.prepare("SELECT id FROM ups_devices WHERE label='KMX-UPS-01'").get().id;
  assert.deepStrictEqual(
    T.powerChainForDevice(db, 10, `ups-${devId}`).chain.map(c => c.name),
    T.powerChainForDevice(db, 10, devId).chain.map(c => c.name));
});
t('a device with no links returns an empty chain, not an error', () => {
  const d2 = makeDb();
  d2.prepare('INSERT INTO ups_devices (tenant_id,label,status,last_polled) VALUES (?,?,?,?)').run(10, 'LONE-01', 'ok', FRESH());
  const id = d2.prepare("SELECT id FROM ups_devices WHERE label='LONE-01'").get().id;
  assert.deepStrictEqual(T.powerChainForDevice(d2, 10, id).chain.map(c => c.name), ['LONE-01']);
});
t('a cycle terminates instead of hanging', () => {
  const d3 = makeDb();
  T.importTopology(d3, 10, {
    cbu: 'X',
    rooms: [{
      location: 'L', name: 'R', objects: [{ name: 'P1', kind: 'panel' }, { name: 'P2', kind: 'panel' }],
      power_links: [
        { src: 'P1', src_type: 'object', dst: 'P2', dst_type: 'object' },
        { src: 'P2', src_type: 'object', dst: 'P1', dst_type: 'object' },
      ],
    }],
  });
  const p1 = d3.prepare("SELECT id FROM fms_racks WHERE name='P1'").get().id;
  const chain = T.powerChainForObject(d3, 10, p1).chain;
  assert.deepStrictEqual(chain.map(c => c.name), ['P1', 'P2']);
});
t('a long chain stops at MAX_CHAIN', () => {
  const d4 = makeDb();
  const objects = Array.from({ length: 15 }, (_, i) => ({ name: `N${i}`, kind: 'panel' }));
  const power_links = Array.from({ length: 14 }, (_, i) => ({ src: `N${i}`, src_type: 'object', dst: `N${i + 1}`, dst_type: 'object' }));
  T.importTopology(d4, 10, { cbu: 'X', rooms: [{ location: 'L', name: 'R', objects, power_links }] });
  const n0 = d4.prepare("SELECT id FROM fms_racks WHERE name='N0'").get().id;
  assert.strictEqual(T.powerChainForObject(d4, 10, n0).chain.length, T.MAX_CHAIN + 1);
});

console.log('tenant isolation');
t('another tenant sees nothing', () => {
  assert.deepStrictEqual(T.getTopology(db, 99, null).rooms, []);
  const rackId = db.prepare("SELECT id FROM fms_racks WHERE name='A-01'").get().id;
  assert.deepStrictEqual(T.powerChainForObject(db, 99, rackId).chain, []);
  assert.deepStrictEqual(T.exportTopology(db, 99, 'KMX').rooms, []);
});

console.log('topology read');
t('places the ledger device and reports it under its object', () => {
  const { rooms, unplaced } = T.getTopology(db, 10, 'KMX');
  assert.strictEqual(rooms.length, 1);
  const ups = rooms[0].objects.find(o => o.name === 'UPS-A');
  assert.strictEqual(ups.devices.length, 1);
  assert.strictEqual(ups.devices[0].label, 'KMX-UPS-01');
  assert.deepStrictEqual(unplaced, []);
});
t('a device with no ledger row lands in unplaced, not lost', () => {
  const d5 = makeDb();
  d5.prepare('INSERT INTO ups_devices (tenant_id,label,cbu,location,room,rack,status,last_polled) VALUES (?,?,?,?,?,?,?,?)')
    .run(10, 'HMA-UPS-07', 'HMA', 'HMA 1West', 'IDF', '', 'ok', FRESH());
  const { rooms, unplaced } = T.getTopology(d5, 10, null);
  assert.deepStrictEqual(rooms, []);
  assert.strictEqual(unplaced.length, 1);
  assert.strictEqual(unplaced[0].label, 'HMA-UPS-07');
});
t('a stale device reads as nodata, not as its last status', () => {
  const d6 = makeDb();
  d6.prepare('INSERT INTO ups_devices (tenant_id,label,cbu,location,room,rack,status,last_polled,load_pct) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(10, 'OLD-01', 'KMX', 'L', 'R', 'A', 'ok', Date.now() - 20 * 60000, 55);
  T.importTopology(d6, 10, { cbu: 'KMX', rooms: [{ location: 'L', name: 'R', objects: [{ name: 'A', kind: 'rack' }], devices: [{ label: 'OLD-01', rack: 'A' }] }] });
  const dev = T.getTopology(d6, 10, 'KMX').rooms[0].objects[0].devices[0];
  assert.strictEqual(dev.status, 'nodata');
  assert.strictEqual(dev.load_pct, null);
});

console.log('heat');
t('emits one cell per rack that has a reading, and skips the rest', () => {
  const cells = T.getHeat(db, 10, 'KMX', 'load')[0].cells;
  assert.strictEqual(cells.length, 1);              // only UPS-A holds a device
  assert.deepStrictEqual(cells[0], { col: 20, row: 2, v: 48 });
  assert.strictEqual(T.getHeat(db, 10, 'KMX', 'temp')[0].cells[0].v, 24.5);
});

console.log(`\n${pass} passed`);
