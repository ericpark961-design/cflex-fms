#!/usr/bin/env node
// cli.js — the two things that have to happen before anyone can log in, and
// the SOW test ticket for the installer's `verify --send-test`.
//
//   node src/cli.js create-user <username> <admin|operator|viewer>   password on stdin
//   node src/cli.js collector-key <node-id>                          prints the key once
//   node src/cli.js test-ticket [--keep-open]                        ServiceNow create → update → resolve
//                                                                    with the channels in Settings (exit 0 ok, 1 failed)
//   node src/cli.js db-status                                        JSON for `cflex-install verify`: schema version,
//                                                                    this month's partitions, WAL archiving (exit 0 ok)
//
// The password is read from stdin (no echo when it is a terminal), never from
// argv — argv is visible in `ps` and in shell history.
const readline = require('readline');
const config = require('./config').load();
const { createSettings } = require('./settings');
const { createSealer } = require('./seal');

function readSecret(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let s = '';
      process.stdin.on('data', (c) => { s += c; });
      process.stdin.on('end', () => resolve(s.replace(/\r?\n$/, '')));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main(db) {
  const [cmd, a, b] = process.argv.slice(2);
  const settings = createSettings(db, { sealer: createSealer(config.secretKey), tenant: config.tenant });
  const audit = (action, target, detail) => db.run('INSERT INTO audit_log (ts, actor, action, target, detail, ip, node) VALUES (?, ?, ?, ?, ?, ?, ?)',
    Date.now(), `cli:${require('os').userInfo().username}`, action, target, detail ? JSON.stringify(detail) : null, null, config.nodeId);

  if (cmd === 'create-user') {
    if (!a || !b) throw new Error('usage: create-user <username> <admin|operator|viewer>');
    const password = await readSecret('password: ');
    const u = await settings.createUser({ username: a, role: b, password, must_change: true });
    await audit('user_create', u.username, { role: u.role });
    console.log(`created ${u.username} (${u.role}); the password must be changed at first login`);
  } else if (cmd === 'collector-key') {
    if (!a) throw new Error('usage: collector-key <node-id>');
    const k = await settings.issueCollectorKey(a);
    await audit('collector_key_issued', k.node_id);
    process.stdout.write(`${k.key}\n`);
  } else if (cmd === 'test-ticket') {
    // The Settings button's code path (notify.js), from a shell on the app node.
    const { createConsoleNotify, netFrom } = require('./notify');
    const quiet = { log() {}, warn() {}, error() {} };
    const n = createConsoleNotify({ db, settings, net: netFrom(config.notify), log: quiet });
    const r = await n.testTicket({ resolve: a !== '--keep-open' });
    await audit('test_ticket', r.number || null, { ok: !!r.ok, step: r.step || null });
    console.log(r.ok
      ? `OK  ServiceNow test ticket ${r.number} created, updated${r.resolved ? ' and resolved' : ' (left open)'}`
      : `FAIL ServiceNow test ticket at ${r.step || 'config'}: ${r.error}`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'db-status') {
    // The installer's `verify` on an app node: what this node sees of db01.
    const s = await dbStatus(db);
    console.log(JSON.stringify(s));
    process.exitCode = s.ok ? 0 : 1;
  } else {
    console.log('commands: create-user <username> <role> | collector-key <node-id> | test-ticket [--keep-open] | db-status');
    process.exitCode = 2;
  }
}

/** Schema version, partitions for this month and the next, WAL archiving as PostgreSQL reports it. */
async function dbStatus(db) {
  const { migrationFiles } = require('./db');
  const files = migrationFiles();
  const applied = (await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version);
  const latest = files.length ? files[files.length - 1].version : 0;
  const parts = await require('./partitions').status(db);
  const arch = await db.one(`SELECT archived_count, failed_count, last_archived_time, last_failed_time,
    EXTRACT(EPOCH FROM last_archived_time) * 1000 AS last_archived_ms FROM pg_stat_archiver`);
  const settingsOf = await db.all(`SELECT name, setting FROM pg_settings WHERE name IN ('wal_level', 'archive_mode', 'server_version')`);
  const pgs = Object.fromEntries(settingsOf.map(r => [r.name, r.setting]));
  const partsOk = Object.values(parts).every(p => p.current && p.next);
  return {
    ok: applied.includes(latest) && partsOk,
    schema: { applied: applied[applied.length - 1] || 0, expected: latest, pending: files.filter(f => !applied.includes(f.version)).map(f => f.file) },
    partitions: parts,
    server: pgs,
    archiver: { archived: arch?.archived_count ?? null, failed: arch?.failed_count ?? null, last_archived_ms: arch?.last_archived_ms ?? null },
  };
}

(async () => {
  // db-status reports on the schema as it is; every other command brings it up to date first, as the server does.
  const db = await require('./db').open(config.db, { migrate: process.argv[2] !== 'db-status', partitions: process.argv[2] !== 'db-status' });
  try { await main(db); } finally { await db.close(); }
})().catch((e) => { console.error(e.code ? `${e.code}: ${e.message}` : e.message); process.exit(1); });
