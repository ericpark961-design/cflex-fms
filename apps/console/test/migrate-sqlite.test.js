// node --test apps/console/test/migrate-sqlite.test.js
//
// WO-INT-008: bin/cflex-migrate-sqlite.js — a pre-008 console.db (the SQLite
// schema as it shipped, test/fixtures) into PostgreSQL 16. Dry run counts and
// writes nothing; the real run moves users, settings, devices, open alarms and
// recent events with their ids; a second run inserts nothing; and the console
// then serves the migrated data (login with the old password, the alarm list,
// the sealed SNMP community opened for the collector).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Database = require('better-sqlite3');
const dbmod = require('../src/db');
const pgt = require('./support/pg');
const { createSealer } = require('../src/seal');
const auth = require('../src/auth');

const T = (name, f) => test(name, { skip: pgt.unavailable }, f);
const ROOT = path.resolve(__dirname, '..');
const KEY = crypto.randomBytes(32).toString('hex');
const NOW = Date.now();
const DAY = 86400e3;
let pg, dir, file, conn;

/** A console.db as an app node has it before the upgrade. */
function buildSqlite(f) {
  const s = new Database(f);
  s.exec(fs.readFileSync(path.join(__dirname, 'fixtures/sqlite-schema-pre008.sql'), 'utf8'));
  const sealer = createSealer(KEY);
  const ins = (t, row) => s.prepare(`INSERT INTO ${t} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
  ins('sites', { id: 'HMA-FV', name: 'HMA Fountain Valley', company: 'HMA', timezone: 'America/Los_Angeles' });
  ins('sites', { id: 'KUS-IRV', name: 'KUS Irvine', company: 'KUS', timezone: 'America/Los_Angeles' });
  ins('users', { id: 3, username: 'Admin', role: 'admin', pw_hash: auth.hashPassword('Old-Store-Pass-2026!'), pw_changed_at: NOW - 9 * DAY, must_change: 0, created_at: NOW - 30 * DAY });
  ins('users', { id: 7, username: 'otto', role: 'operator', pw_hash: auth.hashPassword('Old-Operator-2026!'), pw_changed_at: NOW, must_change: 0, created_at: NOW });
  ins('settings', { key: 'thresholds', value: JSON.stringify({ battery_pct: { critical: 25, warn: 50, direction: 'below' } }), updated_by: 'Admin', updated_at: NOW });
  ins('collectors', { node_id: 'cap01', key_hash: crypto.createHash('sha256').update('collector-key').digest('hex'), created_at: NOW });
  ins('devices', { id: 12, device_id: 'aaaaaaaaaaaaaaaa', site_id: 'HMA-FV', label: 'HMA-UPS-1W-B', serial: 'AS2535281781', nmc_ip: '10.112.3.169', serial_alt: '[]', in_sow: 1, polling_enabled: 1, battery_pct: 88.5, created_at: NOW, updated_at: NOW });
  ins('devices', { id: 15, device_id: 'bbbbbbbbbbbbbbbb', site_id: 'KUS-IRV', label: 'KUS-IDF1', serial_alt: '[]', in_sow: 1, polling_enabled: 1, created_at: NOW, updated_at: NOW });
  ins('credentials', { id: 2, device_id: 'aaaaaaaaaaaaaaaa', version: '2c', secret: sealer.seal({ community: 'fixture-ro-community' }), updated_by: 'Admin', updated_at: NOW });
  ins('maintenance', { id: 4, device_id: 'aaaaaaaaaaaaaaaa', starts_at: NOW - DAY, ends_at: NOW + DAY, reason: 'battery swap', created_by: 'otto', created_at: NOW });
  ins('maintenance', { id: 5, device_id: 'aaaaaaaaaaaaaaaa', starts_at: NOW - 9 * DAY, ends_at: NOW - 8 * DAY, reason: 'over', created_by: 'otto', created_at: NOW });
  ins('alarms', { id: 40, alarm_id: 'al-open', device_id: 'aaaaaaaaaaaaaaaa', site_id: 'HMA-FV', code: 'UPS_ON_BATTERY', severity: 'P1', title: 'UPS on battery', state: 'open', raised_at: NOW - 200 * DAY, updated_at: NOW, detail: '{}', local_notified: '{"email":true,"teams":false,"itsm":"INC0012345"}', maintenance: 0 });
  ins('alarms', { id: 41, alarm_id: 'al-old', device_id: 'aaaaaaaaaaaaaaaa', site_id: 'HMA-FV', code: 'UPS_COMM_LOST', severity: 'P2', title: 'comm lost', state: 'cleared', raised_at: NOW - 5 * DAY, updated_at: NOW, cleared_at: NOW, maintenance: 0 });
  ins('alarm_comments', { id: 8, alarm_id: 'al-open', ts: NOW - DAY, author: 'otto', kind: 'ack', text: 'on it' });
  ins('alarm_comments', { id: 9, alarm_id: 'al-old', ts: NOW - DAY, author: 'otto', kind: 'comment', text: 'gone' });
  ins('itsm_map', { alarm_id: 'al-open', value: JSON.stringify({ number: 'INC0012345', sys_id: 'c'.repeat(32) }), updated: NOW });
  ins('alarm_events', { event_id: 'ev-raise-200d', alarm_id: 'al-open', ts: NOW - 200 * DAY, kind: 'alarm_raise', title: 'UPS on battery', detail: '{}' });
  ins('alarm_events', { event_id: 'ev-old-5d', alarm_id: 'al-old', ts: NOW - 5 * DAY, kind: 'alarm_raise', title: 'comm lost', detail: '{}' });
  ins('alarm_events', { event_id: 'ev-ancient', alarm_id: 'al-gone', ts: NOW - 400 * DAY, kind: 'alarm_raise', title: 'x', detail: '{}' });
  for (let i = 1; i <= 5; i++) ins('audit_log', { id: i, ts: NOW - (10 - i) * DAY, actor: 'Admin', action: i === 1 ? 'login' : 'alarm_ack', node: i % 2 ? 'app01' : 'app02' });
  ins('telemetry', { device_id: 'aaaaaaaaaaaaaaaa', ts: NOW - 60e3, battery_pct: 88.5, comm_ok: 1, m: '{}' });
  s.close();
}

const run = (...a) => new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, 'bin/cflex-migrate-sqlite.js'), ...a], {
  cwd: dir, env: { PATH: process.env.PATH, CFLEX_DB_URL: conn.url, CFLEX_DB_PASSWORD_FILE: conn.passwordFile },
}, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout, err: stderr })));
const counts = (r) => Object.fromEntries(r.tables.map(t => [t.table, [t.source, t.inserted, t.skipped]]));

test.before(async () => {
  if (pgt.unavailable) return;
  pg = await pgt.start({ database: 'migrated' });
  conn = pg.conn();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-mig-sqlite-'));
  file = path.join(dir, 'console.db');
  buildSqlite(file);
});
test.after(async () => { if (pg) await pg.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const EXPECT = {
  sites: 2, users: 2, settings: 1, collectors: 1, devices: 2, credentials: 1,
  maintenance: 1,       // the active window; the one that ended is history
  alarms: 1,            // open only
  alarm_comments: 1, itsm_map: 1,
  alarm_events: 2,      // last 90 days + the open alarm's raise (200 days old); not the 400-day one of an alarm long gone
  audit_log: 5,
};

T('dry run: exact counts per table, nothing written', async () => {
  const r = await run('--sqlite', file, '--dry-run', '--json');
  assert.strictEqual(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.strictEqual(j.dry_run, true);
  assert.deepStrictEqual(counts(j), Object.fromEntries(Object.entries(EXPECT).map(([k, n]) => [k, [n, n, 0]])));
  const db = await dbmod.open(conn, { migrate: false, partitions: false });
  for (const t of Object.keys(EXPECT)) assert.strictEqual((await db.one(`SELECT COUNT(*) AS n FROM ${t}`)).n, 0, `${t} untouched`);
  await db.close();
  const text = await run('--sqlite', file, '--dry-run');
  assert.match(text.out, /^# cflex-migrate-sqlite .*\(dry run\)/);
  assert.match(text.out, /^devices\s+2\s+2\s+0$/m);
  assert.match(text.out, /dry run: rolled back, nothing written/);
});

T('run: the rows arrive with their ids; history lands in month partitions; sequences moved past the ids', async () => {
  const r = await run('--sqlite', file, '--json');
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(counts(JSON.parse(r.out)), Object.fromEntries(Object.entries(EXPECT).map(([k, n]) => [k, [n, n, 0]])));
  const db = await dbmod.open(conn, { migrate: false, partitions: false });
  assert.deepStrictEqual((await db.all('SELECT id, username FROM users ORDER BY id')).map(u => [u.id, u.username]), [[3, 'Admin'], [7, 'otto']]);
  assert.deepStrictEqual((await db.all('SELECT id, label, battery_pct FROM devices ORDER BY id')).map(d => [d.id, d.label, d.battery_pct]), [[12, 'HMA-UPS-1W-B', 88.5], [15, 'KUS-IDF1', null]]);
  assert.deepStrictEqual((await db.all('SELECT id, alarm_id, state FROM alarms')).map(a => [a.id, a.alarm_id, a.state]), [[40, 'al-open', 'open']]);
  assert.strictEqual((await db.one(`SELECT COUNT(*) AS n FROM alarm_events_default`)).n, 0, 'every migrated event is in its month partition');
  assert.strictEqual((await db.one(`SELECT COUNT(*) AS n FROM telemetry`)).n, 0, 'telemetry is not migrated');
  // New rows continue after the old ids instead of colliding with them.
  const u = await db.run(`INSERT INTO users (username, role, pw_hash, pw_changed_at, created_at) VALUES ('vera', 'viewer', 'x', 1, 1) RETURNING id`);
  assert.strictEqual(u.rows[0].id, 8);
  const a = await db.run(`INSERT INTO audit_log (ts, action) VALUES (?, 'x') RETURNING id`, NOW);
  assert.strictEqual(a.rows[0].id, 6);
  await db.run(`DELETE FROM users WHERE username = 'vera'`);
  await db.close();
});

T('idempotent: a second run inserts nothing and reports every row as skipped', async () => {
  const r = await run('--sqlite', file, '--json');
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(counts(JSON.parse(r.out)), Object.fromEntries(Object.entries(EXPECT).map(([k, n]) => [k, [n, 0, n]])));
});

T('the console serves what was migrated: old password logs in, the open alarm is listed, the sealed community opens for the collector', async () => {
  const db = await dbmod.open(conn);
  const { createApp } = require('../src/server');
  const { startMiniRedis } = require('./support/mini-redis');
  const { createRedis } = require('../src/redis');
  const redisSrv = await startMiniRedis();
  const redis = createRedis(redisSrv.url);
  const config = { ...require('../src/config').load(), nodeId: 'app01', db: conn, secretKey: KEY, cookieSecure: false, twinDir: dir };
  const { server } = createApp({ config, db, redis, log: { log() {}, warn() {}, error() {} } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Case-insensitive like SQLite's COLLATE NOCASE.
    const login = await fetch(base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Old-Store-Pass-2026!' }) });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const alerts = await fetch(base + '/v1/fms/alerts?state=open', { headers: { cookie } }).then(r => r.json());
    assert.deepStrictEqual(alerts.alerts.map(a => [a.id, a.alarm_id, a.device_id, a.local_notified.itsm, a.muted_until != null]), [[40, 'al-open', 'ups-12', 'INC0012345', true]]);
    const th = await fetch(base + '/v1/console/thresholds', { headers: { cookie } }).then(r => r.json());
    assert.strictEqual(th.thresholds.battery_pct.critical, 25);
    const devs = await fetch(base + '/collector/v1/devices', { headers: { 'x-cflex-node': 'cap01', authorization: 'Bearer collector-key' } }).then(r => r.json());
    assert.strictEqual(devs.devices.find(d => d.device_id === 'aaaaaaaaaaaaaaaa').snmp_community, 'fixture-ro-community');
  } finally {
    await new Promise(r => server.close(r));
    redis.close(); await redisSrv.close(); await db.close();
  }
});

T('usage errors: exit 2; a missing file: exit 1 and nothing written', async () => {
  assert.strictEqual((await run('--bogus')).code, 2);
  const r = await run('--sqlite', path.join(dir, 'nope.db'));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no such file/);
});
