// node --test backend/seed/kmx_demo_scenario.test.js
//
// The scenario exists so a site with no collector can still demonstrate the
// workbench. Its whole safety property is that nothing it writes can be mistaken
// for, or mixed into, real data — so that is what this tests, along with the
// evidence the triage prompt depends on (부록 K2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const scenario = require('./kmx_demo_scenario');
const T = require('../services/fms-topology');
const TR = require('../services/fms-triage');

const REPO = path.join(__dirname, '..', '..');
const LEDGER = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'kmx_ccr_topology.json'), 'utf8'));

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE ups_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, label TEXT,
      cbu TEXT, site TEXT, location TEXT, room TEXT, rack TEXT, rack_id INTEGER, u_pos INTEGER,
      u_height INTEGER, vendor TEXT, model TEXT, serial TEXT, ip TEXT, criticality TEXT,
      status TEXT, polling_enabled INTEGER, last_polled INTEGER, battery_pct REAL, load_pct REAL,
      temp_c REAL, runtime_min REAL, input_v REAL, output_v REAL, health_score INTEGER,
      decommissioned_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE ups_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, ts INTEGER,
      battery_pct REAL, load_pct REAL, temp_c REAL, runtime_min REAL, input_v REAL, output_v REAL,
      output_status TEXT, battery_status TEXT, health_score REAL, status TEXT,
      simulated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ups_thresholds (device_id INTEGER PRIMARY KEY, battery_warn REAL, battery_critical REAL,
      load_warn REAL, load_critical REAL, temp_warn REAL, temp_critical REAL, runtime_warn REAL,
      runtime_critical REAL, updated_at INTEGER);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      device_id TEXT NOT NULL, site TEXT, priority TEXT, metric TEXT, message TEXT, value REAL,
      threshold REAL, received_at INTEGER, ticket_id INTEGER, acked_at INTEGER, acked_by TEXT,
      object_id INTEGER, simulated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      ticket_no TEXT UNIQUE, site TEXT, device_id TEXT, device_label TEXT, priority TEXT,
      domain TEXT, title TEXT, description TEXT, status TEXT, assignee TEXT, alert_metric TEXT,
      alert_value REAL, alert_threshold REAL, created_at INTEGER, updated_at INTEGER,
      resolved_at INTEGER, triage TEXT, triage_at INTEGER, triage_source TEXT, verify_state TEXT,
      severity TEXT, cbu TEXT, source TEXT, dedup_key TEXT, channels TEXT, ack_at INTEGER,
      ack_by TEXT, closed_at INTEGER, simulated INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX uq_tickets_dedup_active ON tickets(tenant_id, dedup_key)
      WHERE dedup_key IS NOT NULL AND status IN ('open','ack','in_progress');
    CREATE TABLE ticket_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, author TEXT,
      note TEXT, kind TEXT, body_json TEXT, created_at INTEGER);
    CREATE TABLE incident_alarm_links (incident_id INTEGER NOT NULL, alarm_id INTEGER NOT NULL,
      alarm_source TEXT NOT NULL DEFAULT 'fms', attached_at INTEGER NOT NULL,
      PRIMARY KEY (incident_id, alarm_source, alarm_id));
    CREATE TABLE fms_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, cbu TEXT,
      location TEXT NOT NULL, name TEXT NOT NULL, cols INTEGER, rows INTEGER, tile_mm INTEGER,
      height_mm INTEGER, note TEXT, updated_at INTEGER, UNIQUE(tenant_id, location, name));
    CREATE TABLE fms_racks (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, room_id INTEGER,
      name TEXT NOT NULL, col INTEGER, row INTEGER, w INTEGER, d INTEGER, face TEXT,
      u_height INTEGER, kind TEXT, attrs TEXT, updated_at INTEGER, UNIQUE(tenant_id, room_id, name));
    CREATE TABLE fms_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, cbu TEXT,
      kind TEXT NOT NULL, label TEXT NOT NULL, vendor TEXT, model TEXT, serial TEXT, ip TEXT,
      rack_id INTEGER, u_pos INTEGER, u_height INTEGER, location TEXT, room TEXT, rack TEXT,
      status TEXT, last_polled INTEGER, ports_total INTEGER, ports_up INTEGER, attrs TEXT,
      decommissioned_at INTEGER, updated_at INTEGER, UNIQUE(tenant_id, label));
    CREATE TABLE fms_power_links (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      src_type TEXT, src_id INTEGER, src_port TEXT, dst_type TEXT, dst_id INTEGER, dst_port TEXT,
      circuit TEXT, rated_a REAL, phase TEXT, note TEXT, updated_at INTEGER);
    CREATE TABLE fms_control_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      device_id TEXT, device_label TEXT, action TEXT, channel TEXT, params TEXT, ok INTEGER,
      result TEXT, error TEXT, user_email TEXT, user_id TEXT, dry_run INTEGER, executed_at INTEGER);
    CREATE TABLE fms_alarm_mutes (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      device_id TEXT, metric TEXT, muted_until INTEGER, muted_by TEXT, muted_via TEXT, created_at INTEGER);
    CREATE TABLE fms_triage_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      incident_id INTEGER, hypothesis_id TEXT, cause TEXT, device_id TEXT, metric TEXT,
      outcome TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE fms_dispatch (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      incident_id INTEGER NOT NULL, engineer TEXT, skill TEXT, urgency TEXT, eta_min INTEGER,
      mop TEXT, channel TEXT, sent_at INTEGER, accepted_at INTEGER, arrived_at INTEGER,
      done_at INTEGER, note TEXT, created_by TEXT, created_at INTEGER);
    CREATE TABLE fms_ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      incident_id INTEGER, user_id TEXT, kind TEXT NOT NULL, device_id TEXT, alert_id INTEGER,
      model TEXT, question TEXT, answer TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
      latency_ms INTEGER, ok INTEGER NOT NULL DEFAULT 1, error TEXT, created_at INTEGER NOT NULL);
  `);
  const db = {
    prepare: (q) => { const st = raw.prepare(q); return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) }; },
    exec: (q) => raw.exec(q),
  };
  // A real alarm and a real ticket, so "simulated rows do not touch real data"
  // is actually observable.
  db.prepare("INSERT INTO alerts (tenant_id, device_id, priority, metric, message, received_at) VALUES (10,'ups-99','P1','battery_pct','real alarm',?)").run(Date.now() - 3600e3);
  db.prepare("INSERT INTO tickets (tenant_id, ticket_no, priority, title, status, created_at, updated_at) VALUES (10,'CFX-2026-00077','P1','real ticket','open',?,?)").run(Date.now(), Date.now());
  T.importTopology(db, 10, LEDGER(), { mode: 'merge' });
  return db;
}

const count = (db, sql, ...p) => db.prepare(sql).get(...p).c;

test('start writes the ledger\'s own alarms, with every row simulated', () => {
  const db = freshDb();
  const out = scenario.start(db, { tenantId: 10 });
  assert.deepEqual(out.skipped, [], 'nothing was skipped for a missing device or object');
  assert.strictEqual(out.alerts, LEDGER().alarms.length, 'one alert per ledger alarm');
  assert.ok(out.metrics > 40, `a usable series was written, got ${out.metrics}`);

  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM alerts WHERE simulated=1'), out.alerts);
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM ups_metrics WHERE simulated=0'), 0, 'no unflagged metric was written');
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM tickets WHERE simulated=1'), out.incidents.length);

  // Text comes from the shared ledger file, so the offline demo cannot drift (부록 K3).
  const msg = LEDGER().alarms[0].message;
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM alerts WHERE message=? AND simulated=1', msg), 1);
});

test('P1 and P2 become incidents; P3 does not', () => {
  const db = freshDb();
  const out = scenario.start(db, { tenantId: 10 });
  const ledger = LEDGER().alarms;
  const expected = ledger.filter(a => a.priority === 'P1' || a.priority === 'P2').length;
  assert.strictEqual(out.incidents.length, expected, `${expected} incidents for the P1/P2 alarms`);
  const p3 = ledger.find(a => a.priority === 'P3');
  if (p3) {
    assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM tickets WHERE title LIKE ?', `%${p3.message.slice(0, 12)}%`), 0,
      'a P3 alarm is recorded but does not open an incident');
  }
  // Ticket numbers are allocated, not derived from the clock: three in the same
  // millisecond used to collide on the UNIQUE ticket_no.
  const nos = db.prepare('SELECT ticket_no FROM tickets WHERE simulated=1').all().map(r => r.ticket_no);
  assert.strictEqual(new Set(nos).size, nos.length, 'every ticket number is distinct');
  assert.ok(nos.every(n => /^CFX-\d{4}-\d{5}$/.test(n)), `sequential format, got ${nos.join(', ')}`);
});

test('an object alarm is recorded against the ledger object', () => {
  const db = freshDb();
  scenario.start(db, { tenantId: 10 });
  const objAlarm = LEDGER().alarms.find(a => a.object && !a.device);
  assert.ok(objAlarm, 'the ledger has an object-only alarm (CRAC / leak zone)');
  const row = db.prepare('SELECT device_id, object_id FROM alerts WHERE message=?').get(objAlarm.message);
  assert.ok(row.object_id > 0, 'object_id points at the fms_racks row');
  // alerts.device_id is NOT NULL, so the object alarm carries a synthetic id there.
  assert.match(row.device_id, /^obj-\d+$/);
  const obj = db.prepare('SELECT name FROM fms_racks WHERE id=?').get(row.object_id);
  assert.strictEqual(obj.name, objAlarm.object);
});

test('the evidence carries the lead time the diagnosis depends on', () => {
  // 부록 K2 expects the top hypothesis to be the CRAC-2 fan slowdown, reached
  // from a P2 fourteen minutes earlier in the same room. A ±10 min adjacency
  // window hid it entirely, which is the context bug this asserts against.
  const db = freshDb();
  scenario.start(db, { tenantId: 10 });
  const inc = db.prepare("SELECT id FROM tickets WHERE simulated=1 AND title LIKE '%B07%'").get();
  assert.ok(inc, 'the B07 hotspot opened an incident');
  const ctx = TR.collectContext(db, inc.id);

  const crac = ctx.adjacent.find(a => (a.name || '').startsWith('CRAC'));
  assert.ok(crac, `the CRAC alarm is in the adjacency set, got ${ctx.adjacent.map(a => a.name).join(', ')}`);
  assert.ok(crac.lead_min > 10, `it leads by more than the old 10-minute window (${crac.lead_min} min)`);
  assert.strictEqual(crac.same_room, true, 'and is recognised as the same room');

  const ev = TR.buildEvidence(ctx);
  const roomEv = ev.find(e => e.kind === 'alarm' && /같은 룸/.test(e.label));
  assert.ok(roomEv, 'the same-room alarms are one evidence item');
  assert.match(roomEv.label, /CRAC-2/);
  assert.match(roomEv.label, /선행/, 'and the label states that it came first');

  // The climb must not be flattened by the recovery samples that follow it.
  const climb = ev.find(e => e.kind === 'metric' && /상승/.test(e.label));
  assert.ok(climb, `the run-up to the alarm reads as a rise, got: ${ev.filter(e => e.kind === 'metric').map(e => e.label).join(' | ')}`);
  assert.ok(ev.some(e => /알람 이후/.test(e.label)), 'the recovery is reported separately, for Verify');
  assert.ok(ev.some(e => e.kind === 'chain'), 'the power chain is evidence too');

  // Every rule hypothesis must bind to real evidence — no confidence without it.
  const t = TR.rulesTriage(ctx, ev, 'test');
  assert.ok(t.hypotheses.length > 0);
  assert.ok(t.hypotheses.every(h => h.evidence_ids.length > 0));
  assert.ok(t.verify, 'and a checkable return-to-normal condition');
});

test('reset removes everything it created and nothing else', () => {
  const db = freshDb();
  const realAlerts = count(db, 'SELECT COUNT(*) c FROM alerts');
  const realTickets = count(db, 'SELECT COUNT(*) c FROM tickets');
  const upsRows = count(db, 'SELECT COUNT(*) c FROM ups_devices');

  scenario.start(db, { tenantId: 10 });
  assert.ok(count(db, 'SELECT COUNT(*) c FROM alerts') > realAlerts);

  const r = scenario.reset(db, { tenantId: 10 });
  assert.ok(r.alerts > 0 && r.metrics > 0 && r.incidents > 0);
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM alerts WHERE simulated=1'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM ups_metrics WHERE simulated=1'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM tickets WHERE simulated=1'), 0);
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM ticket_notes WHERE ticket_id NOT IN (SELECT id FROM tickets)'), 0, 'no orphaned timeline rows');
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM incident_alarm_links WHERE incident_id NOT IN (SELECT id FROM tickets)'), 0, 'no orphaned alarm links');

  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM alerts'), realAlerts, 'the real alarm is untouched');
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM tickets'), realTickets, 'the real ticket is untouched');
  assert.strictEqual(count(db, 'SELECT COUNT(*) c FROM ups_devices'), upsRows, 'no device row is deleted');
  // The devices the scenario wrote readings onto go back to "nothing reported".
  const kmx = db.prepare("SELECT status, temp_c, last_polled FROM ups_devices WHERE cbu='KMX'").all();
  assert.ok(kmx.length >= 5);
  assert.ok(kmx.every(d => d.status === 'nodata' && d.temp_c === null && d.last_polled === null));
});

test('start is repeatable — a second run dedups rather than piling up', () => {
  const db = freshDb();
  scenario.start(db, { tenantId: 10 });
  const first = count(db, 'SELECT COUNT(*) c FROM tickets WHERE simulated=1');
  const out2 = scenario.start(db, { tenantId: 10 });
  const second = count(db, 'SELECT COUNT(*) c FROM tickets WHERE simulated=1');
  assert.strictEqual(second, first, 'the same faults reuse their open incidents');
  assert.ok(out2.incidents.every(i => i.deduped), 'and say so');
});
