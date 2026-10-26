#!/usr/bin/env node
// cflex-migrate-sqlite — move a Local Console's SQLite store (before WO-INT-008)
// into PostgreSQL 16 on db01. Run once on the active app node during the upgrade
// (docs/install/PG_BACKUP_RESTORE.md §5), after db01 is up and before the
// console starts on the new version.
//
//   node bin/cflex-migrate-sqlite.js [--sqlite <file>] [--dry-run] [--events-days N] [--json]
//
//   --sqlite        the old file; default $CONSOLE_DB, else /opt/app/cflex/data/console.db
//   --dry-run       everything inside one transaction, then ROLLBACK: the counts are exact, nothing is written
//   --events-days   alarm history to bring over (default 90); events of open alarms always come
//
// The target is the console's own setting (CFLEX_DB_URL or CFLEX_DB_HOST/…, password
// from CFLEX_DB_PASSWORD_FILE) — the same app.env the console runs with.
//
// What moves: sites, users, settings (thresholds, notify — secrets stay sealed
// with the same console.key), collectors, devices, SNMP credentials (sealed),
// active maintenance windows, open alarms with their comments and ServiceNow
// mapping, recent alarm events, and the whole audit log (append-only, 10 years).
// Telemetry does not: trends start again on the new store.
//
// Idempotent: every row is INSERT … ON CONFLICT DO NOTHING with its original id,
// so a second run inserts nothing and reports every row as skipped. Ids are kept
// (twin links by device id; sessions name the user id) and the id sequences are
// moved past them.
//
// Exit: 0 done (or dry run), 1 failed (nothing written: one transaction), 2 usage.
const fs = require('fs');
const path = require('path');

const DAY = 86400e3;

function args(argv) {
  const o = { sqlite: process.env.CONSOLE_DB || '/opt/app/cflex/data/console.db', dryRun: false, eventsDays: 90, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--sqlite') o.sqlite = argv[++i];
    else if (a === '--events-days') o.eventsDays = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') o.help = true;
    else throw Object.assign(new Error(`unknown argument ${a}`), { usage: true });
  }
  if (!o.sqlite) throw Object.assign(new Error('--sqlite <file>'), { usage: true });
  if (!Number.isFinite(o.eventsDays) || o.eventsDays < 0) throw Object.assign(new Error('--events-days N (N >= 0)'), { usage: true });
  return o;
}

/**
 * Each table: which rows of the SQLite file, and the identity sequence to move on.
 * `where` is SQLite SQL over the source; `seq` the PostgreSQL sequence behind its id.
 */
function plan(now, eventsDays) {
  const since = now - eventsDays * DAY;
  const openAlarms = `alarm_id IN (SELECT alarm_id FROM alarms WHERE state = 'open')`;
  return [
    { table: 'sites' },
    { table: 'users', seq: 'users' },
    { table: 'settings' },
    { table: 'collectors' },
    { table: 'devices', seq: 'devices' },
    { table: 'credentials', seq: 'credentials' },
    { table: 'maintenance', where: 'ends_at > ?', args: [now], seq: 'maintenance' },
    { table: 'alarms', where: `state = 'open'`, seq: 'alarms' },
    { table: 'alarm_comments', where: openAlarms, seq: 'alarm_comments' },
    { table: 'itsm_map', where: openAlarms },
    { table: 'alarm_events', where: `ts >= ? OR ${openAlarms}`, args: [since], partitioned: true },
    { table: 'audit_log', partitioned: true, seqName: 'audit_log_id_seq' },
  ];
}

async function migrate({ sqlite, dryRun = false, eventsDays = 90, db, now = Date.now() }) {
  if (!fs.existsSync(sqlite)) throw new Error(`${sqlite}: no such file`);
  const Database = require('better-sqlite3');
  const src = new Database(sqlite, { readonly: true, fileMustExist: true });
  const report = [];
  try {
    const srcTables = new Set(src.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name));
    const steps = plan(now, eventsDays);
    const rowsOf = {};
    for (const s of steps) {
      if (!srcTables.has(s.table)) { rowsOf[s.table] = { cols: [], rows: [] }; continue; }
      const srcCols = src.prepare(`PRAGMA table_info(${s.table})`).all().map(c => c.name);
      const dstCols = (await db.all(`SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema() ORDER BY ordinal_position`, s.table)).map(r => r.column_name);
      const cols = dstCols.filter(c => srcCols.includes(c));
      const rows = src.prepare(`SELECT ${cols.join(', ')} FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ''}`).all(...(s.args || []));
      rowsOf[s.table] = { cols, rows };
    }

    // Month partitions for the history being brought over (outside the transaction: DDL
    // that stays even on a dry run would be a write, so a dry run lets them land in default).
    if (!dryRun) {
      const parts = require('../src/partitions');
      for (const s of steps.filter(x => x.partitioned)) {
        const ts = rowsOf[s.table].rows.map(r => r.ts).filter(Number.isFinite);
        if (ts.length) await parts.ensureRange(db, s.table, Math.min(...ts), now);
      }
    }

    const rollback = Object.assign(new Error('dry run'), { dryRun: true });
    try {
      await db.tx(async (t) => {
        for (const s of steps) {
          const { cols, rows } = rowsOf[s.table];
          let inserted = 0;
          for (let i = 0; i < rows.length; i += 200) {
            const chunk = rows.slice(i, i + 200);
            const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
            const r = await t.run(`INSERT INTO ${s.table} (${cols.join(', ')}) VALUES ${values} ON CONFLICT DO NOTHING`,
              ...chunk.flatMap(row => cols.map(c => row[c])));
            inserted += r.changes;
          }
          if (s.seq || s.seqName) {
            const seq = s.seqName ? `'${s.seqName}'` : `pg_get_serial_sequence('${s.seq}', 'id')`;
            await t.one(`SELECT setval(${seq}, GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${s.table}), 1), (SELECT COUNT(*) > 0 FROM ${s.table}))`);
          }
          report.push({ table: s.table, source: rows.length, inserted, skipped: rows.length - inserted });
        }
        if (dryRun) throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
  } finally {
    src.close();
  }
  return { dry_run: !!dryRun, sqlite, tables: report, total: report.reduce((a, r) => ({ source: a.source + r.source, inserted: a.inserted + r.inserted, skipped: a.skipped + r.skipped }), { source: 0, inserted: 0, skipped: 0 }) };
}

function format(r, target) {
  const lines = [`# cflex-migrate-sqlite  ${r.sqlite} → ${target}${r.dry_run ? '  (dry run)' : ''}`,
    `${'table'.padEnd(16)}${'source'.padStart(8)}${'inserted'.padStart(10)}${'skipped'.padStart(9)}`];
  for (const t of [...r.tables, { table: 'total', ...r.total }]) {
    lines.push(`${t.table.padEnd(16)}${String(t.source).padStart(8)}${String(t.inserted).padStart(10)}${String(t.skipped).padStart(9)}`);
  }
  lines.push(r.dry_run ? 'dry run: rolled back, nothing written' : 'done (skipped = already in PostgreSQL)');
  return lines.join('\n');
}

async function main() {
  let o;
  try { o = args(process.argv.slice(2)); } catch (e) { console.error(`usage: cflex-migrate-sqlite [--sqlite <file>] [--dry-run] [--events-days N] [--json]\n${e.message}`); return 2; }
  if (o.help) { console.log('usage: cflex-migrate-sqlite [--sqlite <file>] [--dry-run] [--events-days N] [--json]'); return 0; }
  const config = require('../src/config').load();
  const dbmod = require('../src/db');
  const db = await dbmod.open(config.db, { partitionOpts: { ...config.retention, aheadMonths: config.partitions.aheadMonths } });
  try {
    const r = await migrate({ sqlite: path.resolve(o.sqlite), dryRun: o.dryRun, eventsDays: o.eventsDays, db });
    const c = dbmod.connection(config.db);
    console.log(o.json ? JSON.stringify(r) : format(r, `${c.host}:${c.port}/${c.database}`));
    return 0;
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`cflex-migrate-sqlite: ${e.message}`); process.exitCode = 1; });
}

module.exports = { migrate, plan, format };
