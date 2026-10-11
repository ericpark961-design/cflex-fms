// node backend/services/fms-probe-health.test.js
//
// The thing under test is the alarm that did not exist on 2026-08-24, when the
// collector was restarted 40,103 times over six weeks and every screen quietly
// went to `nodata` with nobody told. So:
//
//   · silence longer than ten minutes raises exactly one P2
//   · it is raised once, not every sweep
//   · coming back resolves it and re-arms the next one
//   · a probe that is up and failing every device is not reported as online
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { statements } = require('../migrations/apply');
const health = require('./fms-probe-health');

const MIN = 60 * 1000;
const T0 = 1_760_000_000_000;          // fixed clock; the service takes `at`

function db0() {
  const d = new DatabaseSync(':memory:');
  // The whole FMS schema, from the migrations that ship — so this test cannot
  // pass against a schema that does not. Loading only 005 and 007 failed on
  // seeds that reference tables 001 creates, which surfaced as six failures
  // about `fms_alarm_routes` in a test that never touches alarm routing.
  const root = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(root).filter(f => /^00[1-7]_.*\.sql$/.test(f)).sort();

  // ticket_notes and tickets predate these migrations: they live on the server
  // from the 1.x schema, so the fixture carries the live definitions verbatim.
  d.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, ticket_no TEXT UNIQUE,
    site TEXT, device_id TEXT, device_label TEXT, priority TEXT, domain TEXT,
    title TEXT, description TEXT, status TEXT, alert_metric TEXT, alert_value REAL,
    alert_threshold REAL, severity TEXT, cbu TEXT, source TEXT, dedup_key TEXT,
    channels TEXT, created_at INTEGER, updated_at INTEGER,
    ack_at INTEGER, ack_by TEXT, resolved_at INTEGER, closed_at INTEGER);`);
  d.exec(`CREATE TABLE IF NOT EXISTS ticket_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
    author TEXT DEFAULT 'C-Flex System', note TEXT NOT NULL,
    created_at INTEGER NOT NULL, kind TEXT DEFAULT 'comment', body_json TEXT);`);
  d.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, device_id TEXT NOT NULL,
    site TEXT, priority TEXT, metric TEXT, message TEXT, value REAL, threshold REAL,
    health_score REAL, received_at INTEGER, ticket_id INTEGER, acked_at INTEGER,
    acked_by TEXT, simulated INTEGER DEFAULT 0, object_id INTEGER);`);
  d.exec(`CREATE TABLE IF NOT EXISTS ups_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, label TEXT, site TEXT,
    cbu TEXT, location TEXT, room TEXT, rack TEXT, ip TEXT, vendor TEXT, model TEXT,
    status TEXT, last_polled INTEGER, polling_enabled INTEGER DEFAULT 1,
    consecutive_fails INTEGER DEFAULT 0, poll_error TEXT, decommissioned_at INTEGER);`);

  for (const f of files) {
    let stmts;
    try { stmts = statements(fs.readFileSync(path.join(root, f), 'utf8')); }
    catch { continue; }                       // transactions/triggers: applied by hand on the server
    for (const stmt of stmts) {
      try { d.exec(stmt); } catch (e) {
        // The same two classes apply.js tolerates on a replay, plus the
        // cross-migration references this fixture cannot order perfectly.
        if (!/duplicate column name|already exists|no such table|no such column/i.test(e.message)) throw e;
      }
    }
  }
  return d;
}

const probe = (over = {}) => ({
  probe_id: 'p_haea_1', tenant_id: 10, cbu: 'HMA', label: 'probe-haea-vm1',
  version: '0.1.0', host: '10.112.0.9', poll_ok: 28, poll_fail: 3, devices: 31,
  cycle_ms: 41_000, ...over,
});

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

t('a first heartbeat registers the collector', () => {
  const d = db0();
  health.heartbeat(d, probe());
  const [p] = health.list(d, 10, { at: T0 });
  assert.equal(p.probe_id, 'p_haea_1');
  assert.equal(p.cbu, 'HMA');
  assert.equal(p.devices, 31);
  assert.equal(p.success_pct, 90, '28 of 31');
  assert.equal(health.sweep(d).down.length, 0, 'a probe that just reported is not down');
});

t('ten minutes of silence raises one P2, and only one', () => {
  const d = db0();
  health.heartbeat(d, probe());
  d.prepare('UPDATE probe_status SET last_seen=? WHERE probe_id=?').run(T0, 'p_haea_1');

  // Nine minutes: still nothing. The line is ten.
  assert.equal(health.sweep(d, { at: T0 + 9 * MIN }).raised.length, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0);

  const first = health.sweep(d, { at: T0 + 11 * MIN });
  assert.deepEqual(first.down, ['p_haea_1']);
  assert.equal(first.raised.length, 1);
  const a = d.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 1').get();
  assert.equal(a.priority, 'P2');
  assert.equal(a.metric, 'probe_heartbeat');
  assert.equal(a.device_id, 'probe-p_haea_1');
  assert.match(a.message, /프로브 무신호 11분/);
  assert.match(a.message, /HMA/, 'the site is in the message, because that is what stopped being collected');

  // An incident, not a bare row — so it dedups, has a timeline and can be
  // dispatched like any other.
  const inc = d.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 1').get();
  assert.equal(inc.domain, 'PROBE');
  assert.equal(inc.status, 'open');
  assert.equal(inc.device_id, 'probe-p_haea_1');
  assert.equal(first.raised[0].incidentId, inc.id);

  // Sweeping every minute for an hour must not produce an alarm per minute.
  for (let i = 12; i < 72; i++) health.sweep(d, { at: T0 + i * MIN });
  assert.equal(d.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1,
    'one outage is one alarm, however often it is checked');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tickets').get().n, 1);
});

t('a probe-down incident does not collide with a UPS incident', () => {
  const d = db0();
  const incident = require('./fms-incident');
  // Same tenant, same synthetic id, same severity, same symptom text: with one
  // hard-coded asset type these two shared a dedup key and the second attached
  // to the first.
  const base = {
    tenant_id: 10, device_id: 'probe-p_haea_1', priority: 'P2',
    metric: 'probe_heartbeat', message: 'x', received_at: T0,
  };
  const r1 = incident.ensureIncidentForAlert(d, { ...base }, { assetType: 'probe', domain: 'PROBE' });
  const r2 = incident.ensureIncidentForAlert(d, { ...base }, { assetType: 'ups' });
  assert.notEqual(r1.dedupKey, r2.dedupKey, 'a probe and a UPS are different assets');
  assert.equal(r2.created, true, 'so the second one is its own incident');
});

t('coming back resolves the incident and re-arms the next outage', () => {
  const d = db0();
  health.heartbeat(d, probe());
  d.prepare('UPDATE probe_status SET last_seen=? WHERE probe_id=?').run(T0, 'p_haea_1');
  health.sweep(d, { at: T0 + 11 * MIN });
  const inc = d.prepare('SELECT id, status FROM tickets ORDER BY id DESC LIMIT 1').get();
  assert.equal(inc.status, 'open');

  health.heartbeat(d, probe({ poll_ok: 31, poll_fail: 0 }));
  const after = d.prepare('SELECT status FROM tickets WHERE id=?').get(inc.id);
  assert.equal(after.status, 'resolved', 'the heartbeat closes the outage');
  assert.equal(d.prepare('SELECT down_alerted_at FROM probe_status WHERE probe_id=?').get('p_haea_1').down_alerted_at,
    null, 'and clears the flag');

  // A second outage must alarm again rather than be swallowed as a duplicate.
  d.prepare('UPDATE probe_status SET last_seen=? WHERE probe_id=?').run(T0 + 20 * MIN, 'p_haea_1');
  const second = health.sweep(d, { at: T0 + 40 * MIN });
  assert.equal(second.raised.length, 1, 'the next outage is a new alarm');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM alerts').get().n, 2);
});

t('a probe that is up and failing every device is not reported as online', () => {
  // This is the fleet's real state: the collector is alive and answers, and
  // every HAEA device times out because no probe sits inside those networks.
  // A green dot here would stand in for data nobody has.
  const d = db0();
  health.heartbeat(d, probe({ poll_ok: 0, poll_fail: 31, last_error: 'Request timed out' }));
  const [p] = health.list(d, 10, { at: T0 });
  assert.equal(p.state, 'blind');
  assert.equal(p.success_pct, 0);
  assert.equal(p.last_error, 'Request timed out');

  health.heartbeat(d, probe({ probe_id: 'p_ok', poll_ok: 5, poll_fail: 0 }));
  const ok = health.list(d, 10, { at: T0 }).find(x => x.probe_id === 'p_ok');
  assert.equal(ok.state, 'online');

  // And a probe that has never polled anything is neither — it is just online.
  health.heartbeat(d, probe({ probe_id: 'p_new', poll_ok: 0, poll_fail: 0, devices: 0 }));
  const fresh = health.list(d, 10, { at: T0 }).find(x => x.probe_id === 'p_new');
  assert.equal(fresh.state, 'online');
  assert.equal(fresh.success_pct, null, 'no attempts is not 0 %');
});

t('a heartbeat without an id is refused', () => {
  const d = db0();
  assert.throws(() => health.heartbeat(d, { tenant_id: 10 }), /probe_id required/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM probe_status').get().n, 0);
});

t('the ten-minute line is the roadmap\'s, not a guess', () => {
  assert.equal(health.DOWN_AFTER_MS, 10 * 60 * 1000);
});

console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - a dead collector raises its hand');
process.exit(fail ? 1 : 0);
