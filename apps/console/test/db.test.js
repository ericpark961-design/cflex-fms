// node --test apps/console/test/db.test.js
//
// WO-INT-008: the PostgreSQL side of the console store, on a real PostgreSQL 16
// (embedded-postgres, test/support/pg.js).
//
//   · migrations: numbered files, recorded in schema_migrations, idempotent,
//     exactly once when two instances start at the same moment, a changed file refused
//   · month partitions: made ahead by the lock holder only, a stray row in the
//     default partition moved when its month is made
//   · retention: past-retention partitions DETACHed then DROPped, per table kind
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dbmod = require('../src/db');
const parts = require('../src/partitions');
const pgt = require('./support/pg');

const T = (name, f) => test(name, { skip: pgt.unavailable }, f);
let pg;
test.before(async () => { if (!pgt.unavailable) pg = await pgt.start({ database: 'base' }); });
test.after(async () => { if (pg) await pg.stop(); });

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);   // 2026-10-26 12:00 UTC
const names = async (db, table) => (await parts.list(db, table)).map(p => p.name);

T('migrations: two instances at once apply 0001 exactly once; a second start applies nothing', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('mig_once');
  const opened = await Promise.all([1, 2, 3].map(() => dbmod.open(conn, { partitions: false })));
  const rows = await opened[0].all('SELECT version, name FROM schema_migrations ORDER BY version');
  assert.deepStrictEqual(rows, dbmod.migrationFiles().map(m => ({ version: m.version, name: m.name })));
  assert.deepStrictEqual(await dbmod.migrate(opened[1]), [], 'nothing left to apply');
  for (const d of opened) await d.close();
  const again = await dbmod.open(conn, { partitions: false });
  assert.strictEqual((await again.one('SELECT COUNT(*) AS n FROM schema_migrations')).n, rows.length);
  await again.close();
});

T('migrations: numbered order, and a file edited after it was applied stops the start', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('mig_order');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-mig-'));
  fs.writeFileSync(path.join(dir, '0002_second.sql'), 'ALTER TABLE t1 ADD COLUMN b INTEGER;');
  fs.writeFileSync(path.join(dir, '0001_first.sql'), 'CREATE TABLE t1 (a INTEGER);');
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration');
  const db = await dbmod.open(conn, { migrate: false, partitions: false });
  assert.deepStrictEqual(await dbmod.migrate(db, { dir }), [1, 2]);
  assert.deepStrictEqual((await db.all(`SELECT column_name FROM information_schema.columns WHERE table_name = 't1' ORDER BY ordinal_position`)).map(r => r.column_name), ['a', 'b']);
  fs.writeFileSync(path.join(dir, '0001_first.sql'), 'CREATE TABLE t1 (a BIGINT);');
  await assert.rejects(dbmod.migrate(db, { dir }), (e) => e.code === 'migration_changed');
  // A failing file leaves nothing behind: its transaction rolls back and it is not recorded.
  fs.writeFileSync(path.join(dir, '0001_first.sql'), 'CREATE TABLE t1 (a INTEGER);');
  fs.writeFileSync(path.join(dir, '0003_bad.sql'), 'CREATE TABLE t3 (x INTEGER); SELECT no_such_function();');
  await assert.rejects(dbmod.migrate(db, { dir }), /no_such_function/);
  assert.strictEqual((await db.one(`SELECT to_regclass('t3') IS NULL AS gone`)).gone, true);
  assert.deepStrictEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version), [1, 2]);
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

T('schema: no extensions; usernames unique regardless of case; telemetry/alarm_events/audit_log partitioned by range on ts', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('schema_chk');
  const db = await dbmod.open(conn, { partitions: false });
  assert.deepStrictEqual((await db.all(`SELECT extname FROM pg_extension ORDER BY 1`)).map(r => r.extname), ['plpgsql'], 'only the built-in plpgsql');
  const p = await db.all(`SELECT c.relname, pt.partstrat, a.attname FROM pg_partitioned_table pt JOIN pg_class c ON c.oid = pt.partrelid
    JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0] ORDER BY 1`);
  assert.deepStrictEqual(p.map(r => [r.relname, r.partstrat, r.attname]), [['alarm_events', 'r', 'ts'], ['audit_log', 'r', 'ts'], ['telemetry', 'r', 'ts']]);
  await db.run(`INSERT INTO users (username, role, pw_hash, pw_changed_at, created_at) VALUES ('Admin', 'admin', 'x', 1, 1)`);
  await assert.rejects(db.run(`INSERT INTO users (username, role, pw_hash, pw_changed_at, created_at) VALUES ('admin', 'admin', 'x', 1, 1)`), /users_username_lower/);
  await db.close();
});

T('partitions: this month and the next N made at start; only the advisory-lock holder works, the other skips', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('part_ahead');
  const db = await dbmod.open(conn, { partitions: false });
  const r = await parts.maintain(db, { now: () => NOW, aheadMonths: 3, retention: false });
  assert.strictEqual(r.ran, true);
  assert.deepStrictEqual(await names(db, 'telemetry'), ['telemetry_p202610', 'telemetry_p202611', 'telemetry_p202612', 'telemetry_p202701']);
  assert.deepStrictEqual(await names(db, 'audit_log'), ['audit_log_p202610', 'audit_log_p202611', 'audit_log_p202612', 'audit_log_p202701']);
  assert.strictEqual(r.created.length, 12);
  assert.deepStrictEqual((await parts.maintain(db, { now: () => NOW, aheadMonths: 3 })).created, [], 'idempotent');

  // The bounds are UTC month starts in epoch ms.
  const b = await db.one(`SELECT pg_get_expr(c.relpartbound, c.oid) AS b FROM pg_class c WHERE relname = 'telemetry_p202612'`);
  assert.strictEqual(b.b, `FOR VALUES FROM ('${Date.UTC(2026, 11, 1)}') TO ('${Date.UTC(2027, 0, 1)}')`);

  // A second instance while the first holds the lock: it skips the round instead of waiting.
  const other = await dbmod.open(conn, { migrate: false, partitions: false });
  const held = await db.withLock(dbmod.LOCKS.partitions, async () => parts.maintain(other, { now: () => NOW + 40 * 86400e3, aheadMonths: 3 }));
  assert.deepStrictEqual(held.result, { ran: false, created: [], dropped: [] });
  const next = await parts.maintain(other, { now: () => NOW + 40 * 86400e3, aheadMonths: 3, retention: false });
  assert.deepStrictEqual(next.created.filter(n => n.startsWith('telemetry')), ['telemetry_p202702', 'telemetry_p202703'], 'once free, it rolls on to December + 3');
  await other.close();
  await db.close();
});

T('partitions: a row with no month partition is stored in the default one, then moved into its month when that is made', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('part_move');
  const db = await dbmod.open(conn, { partitions: false });
  await parts.maintain(db, { now: () => NOW, aheadMonths: 1, retention: false });
  const far = Date.UTC(2027, 5, 15);   // June 2027: no partition yet
  await db.run('INSERT INTO telemetry (device_id, ts, battery_pct) VALUES (?, ?, ?)', 'd1', far, 77);
  await db.run(`INSERT INTO audit_log (ts, action) VALUES (?, 'clock_skew')`, far);
  assert.strictEqual((await db.one('SELECT COUNT(*) AS n FROM telemetry_default')).n, 1);
  const made = await parts.ensureRange(db, 'telemetry', far, far);
  assert.deepStrictEqual(made, ['telemetry_p202706']);
  assert.strictEqual((await db.one('SELECT COUNT(*) AS n FROM telemetry_default')).n, 0);
  assert.strictEqual((await db.one('SELECT battery_pct FROM telemetry_p202706 WHERE device_id = ?', 'd1')).battery_pct, 77);
  assert.strictEqual((await db.one(`SELECT COUNT(*) AS n FROM telemetry WHERE device_id = 'd1'`)).n, 1, 'nothing lost or doubled');
  // The audit trail too: moved (the append-only trigger lets only this through), still one row.
  await parts.ensureRange(db, 'audit_log', far, far);
  assert.deepStrictEqual([(await db.one('SELECT COUNT(*) AS n FROM audit_log_default')).n, (await db.one(`SELECT COUNT(*) AS n FROM audit_log_p202706 WHERE action = 'clock_skew'`)).n], [0, 1]);
  await assert.rejects(db.run(`DELETE FROM audit_log WHERE action = 'clock_skew'`), /append-only/, 'and outside the move it is append-only again');
  await db.close();
});

T('retention: raw past 3 years and events/audit past 10 years are detached then dropped; the rest stays', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('part_ret');
  const db = await dbmod.open(conn, { partitions: false });
  const day = 86400e3;
  // Months on both sides of each cutoff, with a row in each.
  for (const [table, cols] of [['telemetry', '(device_id, ts)'], ['alarm_events', '(event_id, alarm_id, ts, kind)'], ['audit_log', '(ts, action)']]) {
    for (const [y, m] of [[2016, 8], [2016, 9], [2016, 10], [2023, 8], [2023, 9], [2023, 10]]) {
      await parts.createMonth(db, table, y, m);
      const ts = Date.UTC(y, m, 10);
      const vals = table === 'telemetry' ? ['d1', ts] : table === 'alarm_events' ? [`e-${y}-${m}`, 'a1', ts, 'info'] : [ts, 'x'];
      await db.run(`INSERT INTO ${table} ${cols} VALUES (${vals.map(() => '?').join(', ')})`, ...vals);
    }
  }
  await db.run('INSERT INTO telemetry (device_id, ts) VALUES (?, ?)', 'd2', Date.UTC(2001, 0, 1));   // in default, ancient
  const r = await parts.maintain(db, { now: () => NOW, aheadMonths: 1, rawYears: 3, eventsYears: 10 });
  // Cutoffs: raw 2023-10-26, events 2016-10-26. A month goes once it has ended by then.
  // October still has days inside retention on the 26th, so October stays; September has ended.
  assert.deepStrictEqual(r.dropped.sort(), [
    'alarm_events_p201609', 'audit_log_p201609',
    'telemetry_p201609', 'telemetry_p201610', 'telemetry_p201611', 'telemetry_p202309',
  ]);
  assert.deepStrictEqual(await names(db, 'telemetry'), ['telemetry_p202310', 'telemetry_p202311', 'telemetry_p202610', 'telemetry_p202611']);
  assert.deepStrictEqual((await names(db, 'alarm_events')).slice(0, 2), ['alarm_events_p201610', 'alarm_events_p201611']);
  assert.strictEqual((await db.one(`SELECT to_regclass('telemetry_p201609') IS NULL AS gone`)).gone, true, 'dropped, not just detached');
  assert.strictEqual((await db.one(`SELECT COUNT(*) AS n FROM telemetry WHERE device_id = 'd2'`)).n, 0, 'old rows in the default partition go too');
  assert.strictEqual((await db.one(`SELECT COUNT(*) AS n FROM telemetry`)).n, 2, 'October and November 2023 are still inside 3 years');
  assert.ok(NOW - parts.cutoff(NOW, 3) < 3 * 366 * day);
  await db.close();
});

T('scheduler: rounds on start and on its timer; status() is what verify reads', async () => {
  const conn = pg.conn(); conn.url = await pg.createDatabase('part_sched');
  const db = await dbmod.open(conn, { partitions: false });
  const s = parts.schedule(db, { aheadMonths: 2, intervalMs: 3600e3 }, { log() {}, error() {} });
  const r = await s.first;
  assert.strictEqual(r.ran, true);
  s.stop();
  const st = await parts.status(db);
  assert.deepStrictEqual(Object.keys(st), ['telemetry', 'alarm_events', 'audit_log']);
  assert.ok(Object.values(st).every(x => x.current && x.next && x.count === 3), JSON.stringify(st));
  await db.close();
});

T('db.js: ? placeholders become $n outside quotes and comments; the URL may not carry a password', () => {
  assert.strictEqual(dbmod.toPg(`SELECT '?', "a?b", x -- why?\nFROM t WHERE a = ? AND b = ?`), `SELECT '?', "a?b", x -- why?\nFROM t WHERE a = $1 AND b = $2`);
  assert.throws(() => dbmod.connection({ url: 'postgres://cflex:pw@db01:5432/cflex' }), /must not carry the password/);
  assert.deepStrictEqual((({ host, port, database, user }) => ({ host, port, database, user }))(dbmod.connection({ url: 'postgres://cflex@10.138.14.69:5432/cflex' })),
    { host: '10.138.14.69', port: 5432, database: 'cflex', user: 'cflex' });
});
