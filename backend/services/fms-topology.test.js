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
    vendor TEXT, model TEXT, decommissioned_at INTEGER,
    ip TEXT, serial TEXT, criticality TEXT, polling_enabled INTEGER,
    created_at INTEGER, updated_at INTEGER)`);
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

console.log('ups registration (부록 K1)');
{
  // A ledger UPS with no ups_devices row must become one — that table is what
  // the KPIs, the CBU toggle, the device list and the alarm map all read.
  const d = makeDb();
  const r = T.importTopology(d, 10, {
    cbu: 'KMX',
    rooms: [{ location: 'KMX Pesquería', name: 'CCR', objects: [{ name: 'B07', kind: 'rack', col: 1, row: 1 }],
      devices: [
        { label: 'B07-UPS', kind: 'ups', rack: 'B07', u_pos: 2, vendor: 'APC', model: 'Smart-UPS SRT 5000VA RM', ip: '10.60.1.14', status: 'critical', battery_pct: 71, load_pct: 88, temp_c: 29.4 },
        { label: 'MDF-SW-1', kind: 'switch', rack: 'B07', u_pos: 40, ports_total: 48 },
      ] }],
  }, { mode: 'merge' });

  t('registers a ledger UPS in ups_devices, not fms_devices', () => {
    assert.strictEqual(r.ups_registered, 1);
    const up = d.prepare("SELECT * FROM ups_devices WHERE label='B07-UPS'").get();
    assert.ok(up, 'the UPS is in ups_devices');
    assert.strictEqual(up.cbu, 'KMX');
    assert.strictEqual(up.room, 'CCR');
    assert.strictEqual(up.rack, 'B07');
    assert.ok(up.rack_id > 0, 'bound to the ledger rack');
    assert.strictEqual(up.ip, '10.60.1.14');
    assert.strictEqual(d.prepare("SELECT COUNT(*) c FROM fms_devices WHERE label='B07-UPS'").get().c, 0);
  });

  t('a registered UPS is nodata with polling off — a ledger is a design document', () => {
    const up = d.prepare("SELECT status, polling_enabled FROM ups_devices WHERE label='B07-UPS'").get();
    assert.strictEqual(up.status, 'nodata', 'the ledger\'s own "critical" is not trusted');
    assert.strictEqual(up.polling_enabled, 0, 'no poller starts against an unconfirmed address');
  });

  t('non-UPS gear still goes to fms_devices', () => {
    assert.strictEqual(d.prepare("SELECT COUNT(*) c FROM fms_devices WHERE label='MDF-SW-1'").get().c, 1);
    assert.strictEqual(d.prepare("SELECT COUNT(*) c FROM ups_devices WHERE label='MDF-SW-1'").get().c, 0);
  });

  t('re-import does not duplicate the UPS', () => {
    T.importTopology(d, 10, {
      cbu: 'KMX',
      rooms: [{ location: 'KMX Pesquería', name: 'CCR', objects: [{ name: 'B07', kind: 'rack', col: 1, row: 1 }],
        devices: [{ label: 'B07-UPS', kind: 'ups', rack: 'B07', u_pos: 2, ip: '10.60.1.14' }] }],
    }, { mode: 'merge' });
    assert.strictEqual(d.prepare("SELECT COUNT(*) c FROM ups_devices WHERE label='B07-UPS'").get().c, 1);
  });

  t('an existing fms_devices UPS row is cleaned up on import', () => {
    const d2 = makeDb();
    d2.prepare("INSERT INTO fms_devices (tenant_id, cbu, kind, label, status) VALUES (10,'KMX','ups','KMX-UPS-01','nodata')").run();
    const r2 = T.importTopology(d2, 10, {
      cbu: 'KMX',
      rooms: [{ location: 'KMX Pesquería', name: 'CCR', objects: [{ name: 'UPS-1', kind: 'ups_cabinet', col: 1, row: 1 }],
        devices: [{ label: 'KMX-UPS-01', kind: 'ups', rack: 'UPS-1', u_pos: 1 }] }],
    }, { mode: 'merge' });
    assert.strictEqual(r2.ups_dedup, 1, 'the duplicate was removed');
    assert.strictEqual(d2.prepare("SELECT COUNT(*) c FROM fms_devices WHERE label='KMX-UPS-01'").get().c, 0);
    assert.strictEqual(d2.prepare("SELECT COUNT(*) c FROM ups_devices WHERE label='KMX-UPS-01'").get().c, 1);
  });

  t('removing the duplicate takes its power links with it', () => {
    // Regression: deleting only the fms_devices row left links pointing at a
    // device id that no longer existed. A chain trace then walked into the
    // dangling edge and stopped — B07-UPS reached PDU-A and no further, with
    // the correct ups_device link sitting unused beside it.
    const d4 = makeDb();
    const LED = {
      cbu: 'KMX',
      rooms: [{ location: 'L', name: 'CCR',
        objects: [
          { name: 'B07', kind: 'rack', col: 1, row: 1 },
          { name: 'PDU-A', kind: 'pdu_cabinet', col: 2, row: 1, attrs: { rated_a: 63 } },
          { name: 'PANEL-1', kind: 'panel', col: 3, row: 1, attrs: { rated_a: 200 } },
        ],
        devices: [{ label: 'B07-UPS', kind: 'ups', rack: 'B07', u_pos: 2 }],
        power_links: [
          { src: 'B07', src_type: 'object', dst: 'B07-UPS', dst_type: 'ups_device', rated_a: 16 },
          { src: 'B07-UPS', src_type: 'ups_device', dst: 'PDU-A', dst_type: 'object', rated_a: 32 },
          { src: 'PDU-A', src_type: 'object', dst: 'PANEL-1', dst_type: 'object', rated_a: 63 },
        ] }],
    };
    // First import as the old code would have left things: the UPS in
    // fms_devices, with links bound to that row.
    T.importTopology(d4, 10, LED, { mode: 'merge' });
    const links = d4.prepare('SELECT COUNT(*) c FROM fms_power_links WHERE tenant_id=10').get().c;

    const r4 = T.importTopology(d4, 10, LED, { mode: 'merge' });
    assert.strictEqual(d4.prepare('SELECT COUNT(*) c FROM fms_power_links WHERE tenant_id=10').get().c, links,
      're-import does not accumulate links');
    const dangling = d4.prepare(`SELECT COUNT(*) c FROM fms_power_links WHERE tenant_id=10 AND (
        (src_type='device' AND src_id NOT IN (SELECT id FROM fms_devices)) OR
        (dst_type='device' AND dst_id NOT IN (SELECT id FROM fms_devices)) OR
        (src_type='ups_device' AND src_id NOT IN (SELECT id FROM ups_devices)) OR
        (dst_type='ups_device' AND dst_id NOT IN (SELECT id FROM ups_devices)))`).get().c;
    assert.strictEqual(dangling, 0, 'no link points at a row that was removed');

    const up = d4.prepare("SELECT id FROM ups_devices WHERE label='B07-UPS'").get();
    const chain = T.powerChainForDevice(d4, 10, up.id).chain.map(c => c.name);
    assert.ok(chain.includes('PANEL-1'), `the chain reaches the panel, got ${chain.join(' → ')}`);
    assert.ok(r4 !== null);
  });

  t('a polled UPS keeps its real data and is only placed', () => {
    const d3 = dbWithDevice();
    const before = d3.prepare("SELECT status, battery_pct FROM ups_devices WHERE label='KMX-UPS-01'").get();
    T.importTopology(d3, 10, LEDGER, { mode: 'merge' });
    const after = d3.prepare("SELECT status, battery_pct, rack_id FROM ups_devices WHERE label='KMX-UPS-01'").get();
    assert.strictEqual(after.status, before.status, 'a live status is never overwritten by the ledger');
    assert.strictEqual(after.battery_pct, before.battery_pct);
    assert.ok(after.rack_id > 0, 'but it does get placed');
  });
}

console.log('u_height passthrough');
{
  const d = makeDb();
  T.importTopology(d, 10, {
    cbu: 'KMX',
    rooms: [{ location: 'L', name: 'R', objects: [{ name: 'A01', kind: 'rack', col: 1, row: 1 }],
      devices: [
        { label: 'CORE-1', kind: 'switch', rack: 'A01', u_pos: 40 },            // no u_height
        { label: 'BIG-CHASSIS', kind: 'switch', rack: 'A01', u_pos: 20, u_height: 7 },
      ] }],
  }, { mode: 'merge' });

  t('an unknown U height stays unknown instead of becoming 1', () => {
    // Defaulting here hid "unknown" behind a number and, worse, made the
    // client's equipment-catalogue lookup unreachable: the value was always
    // truthy, so a 7U chassis drew as a 1U slab.
    const devs = T.getTopology(d, 10, 'KMX').rooms[0].objects[0].devices;
    const core = devs.find(x => x.label === 'CORE-1');
    assert.strictEqual(core.u_height, null, 'null, not 1');
    const big = devs.find(x => x.label === 'BIG-CHASSIS');
    assert.strictEqual(big.u_height, 7, 'a recorded height is passed through unchanged');
  });
}

console.log('heat');
t('emits one cell per rack that has a reading, and skips the rest', () => {
  const cells = T.getHeat(db, 10, 'KMX', 'load')[0].cells;
  assert.strictEqual(cells.length, 1);              // only UPS-A holds a device
  assert.deepStrictEqual(cells[0], { col: 20, row: 2, v: 48 });
  assert.strictEqual(T.getHeat(db, 10, 'KMX', 'temp')[0].cells[0].v, 24.5);
});

console.log('non-UPS equipment (A2)');
t('import creates fms_devices rows and places them', () => {
  const d7 = dbWithDevice();
  const r7 = T.importTopology(d7, 10, {
    cbu: 'KMX',
    rooms: [{
      location: 'L', name: 'R',
      objects: [{ name: 'A01', kind: 'rack' }, { name: 'PDU-A', kind: 'pdu_cabinet' }],
      devices: [
        { label: 'MDF-CORE-1', kind: 'switch', model: 'Catalyst 9500', rack: 'A01', u_pos: 40, ports_total: 48, ports_up: 31 },
        { label: 'CUCM-PUB', kind: 'server', model: 'UCS C220', rack: 'A01', u_pos: 20 },
      ],
      power_links: [{ src: 'MDF-CORE-1', src_type: 'device', dst: 'PDU-A', dst_type: 'object', dst_port: 'CB-9', rated_a: 16 }],
    }],
  });
  assert.strictEqual(r7.devices, 2);
  assert.deepStrictEqual(r7.unplaced, []);
  const list = T.listDevices(d7, 10, {});
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list.find(x => x.label === 'MDF-CORE-1').ports_up, 31);
});
t('a ledger cannot declare equipment healthy — status stays nodata until a collector says otherwise', () => {
  const d8 = dbWithDevice();
  T.importTopology(d8, 10, { cbu: 'X', rooms: [{ location: 'L', name: 'R', objects: [{ name: 'A01', kind: 'rack' }], devices: [{ label: 'SW-1', kind: 'switch', rack: 'A01', status: 'ok' }] }] });
  assert.strictEqual(T.listDevices(d8, 10, {})[0].status, 'nodata');
});
t('a chain can start at a non-UPS device', () => {
  const d9 = dbWithDevice();
  T.importTopology(d9, 10, {
    cbu: 'X',
    rooms: [{
      location: 'L', name: 'R',
      objects: [{ name: 'PDU-A', kind: 'pdu_cabinet' }, { name: 'PANEL-1', kind: 'panel' }],
      devices: [{ label: 'SW-1', kind: 'switch', rack: 'PDU-A' }],
      power_links: [
        { src: 'SW-1', src_type: 'device', dst: 'PDU-A', dst_type: 'object', rated_a: 16 },
        { src: 'PDU-A', src_type: 'object', dst: 'PANEL-1', dst_type: 'object', rated_a: 63 },
      ],
    }],
  });
  const id = d9.prepare("SELECT id FROM fms_devices WHERE label='SW-1'").get().id;
  assert.deepStrictEqual(T.getDevice(d9, 10, id).chain.chain.map(c => c.name), ['SW-1', 'PDU-A', 'PANEL-1']);
});
t('kind filter and tenant isolation hold', () => {
  const dA = dbWithDevice();
  T.importTopology(dA, 10, { cbu: 'X', rooms: [{ location: 'L', name: 'R', objects: [{ name: 'A01', kind: 'rack' }], devices: [{ label: 'SW-1', kind: 'switch', rack: 'A01' }, { label: 'SRV-1', kind: 'server', rack: 'A01' }] }] });
  assert.strictEqual(T.listDevices(dA, 10, { kind: 'switch' }).length, 1);
  assert.strictEqual(T.listDevices(dA, 99, {}).length, 0);
  assert.strictEqual(T.getDevice(dA, 99, 1), null);
});
t('topology merges equipment into the rack with its kind', () => {
  const dB = dbWithDevice();
  T.importTopology(dB, 10, { cbu: 'X', rooms: [{ location: 'L', name: 'R', objects: [{ name: 'A01', kind: 'rack' }], devices: [{ label: 'SW-1', kind: 'switch', rack: 'A01', u_pos: 40 }] }] });
  const rack = T.getTopology(dB, 10, 'X').rooms[0].objects[0];
  assert.strictEqual(rack.devices.length, 1);
  assert.strictEqual(rack.devices[0].kind, 'switch');
  assert.strictEqual(rack.devices[0].u_pos, 40);
});

console.log('§8 response shape');
t('topology also emits room-level devices[] and power_links[]', () => {
  const room = T.getTopology(db, 10, 'KMX').rooms[0];
  assert.ok(Array.isArray(room.devices), 'room.devices missing');
  assert.ok(Array.isArray(room.power_links), 'room.power_links missing');
  assert.strictEqual(room.power_links.length, 4);
  assert.ok(room.power_links.every(l => l.src && l.dst), 'a link lost an endpoint name');
});

console.log(`\n${pass} passed`);
