// db.js — the Local Console's store: PostgreSQL 16 on db01 (spec 01 §2.3,
// WO-INT-008). app01 and app02 point at the same database; the app process
// keeps nothing of its own.
//
// One driver, `pg` (pure JS). Every query goes through the handle open()
// returns:
//
//   db.one(sql, ...args)   first row or undefined
//   db.all(sql, ...args)   rows
//   db.run(sql, ...args)   { changes, rows }   (rows: what RETURNING gave)
//   db.tx(async (t) => …)  BEGIN … COMMIT on one connection, ROLLBACK if it throws;
//                          t has one/all/run (and tx, which nests as itself)
//   db.close()
//
// The SQL keeps SQLite's `?` placeholders; they become $1, $2 … here (outside
// quotes), so the call sites read as they did. BIGINT and NUMERIC come back as
// JS numbers — epoch ms, row ids and averages are all far below 2^53.
//
// Schema: numbered files in ../migrations (0001_init.sql, …), applied in order
// at open() and recorded in schema_migrations. Two instances starting at once
// take the same advisory lock, so each file runs exactly once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pg = require('pg');

pg.types.setTypeParser(20, (v) => (v == null ? v : Number(v)));     // int8: COUNT(*), BIGINT columns
pg.types.setTypeParser(1700, (v) => (v == null ? v : Number(v)));   // numeric: AVG over integers

const MIGRATIONS = path.resolve(__dirname, '../migrations');

// pg_advisory_lock(LOCK_NS, <key>): one namespace for everything the console serialises.
const LOCK_NS = 0x43464c58;   // 'CFLX'
// portal: held for as long as a node is the Portal sender (portal.js, WO-INT-012).
const LOCKS = Object.freeze({ migrate: 1, partitions: 2, events: 3, portal: 4 });

/** `?` → `$n`, leaving quoted strings, quoted identifiers and comments alone. */
const converted = new Map();
function toPg(sql) {
  let out = converted.get(sql);
  if (out) return out;
  out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const j = sql.indexOf(c, i + 1);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end + 1);
      i = end;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (c === '?') {
      out += `$${++n}`;
    } else out += c;
  }
  if (converted.size < 2000) converted.set(sql, out);
  return out;
}

/**
 * Connection settings from the environment (config.js passes them through):
 *   CFLEX_DB_URL               postgres://user@host:port/db — no password in it
 *   or CFLEX_DB_HOST/PORT/NAME/USER
 *   CFLEX_DB_PASSWORD_FILE     the password, in a 0600 file (Podman secret / systemd credential)
 * The password is never taken from the URL's own environment variable, argv or a log line.
 */
function connection(o = {}) {
  const c = { max: o.poolMax || 10, application_name: o.appName || 'cflex-app', connectionTimeoutMillis: o.connectTimeoutMs || 10000 };
  if (o.url) {
    // Taken apart here: given as connectionString, pg would let the URL's (absent) password override the file's.
    const u = new URL(o.url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('CFLEX_DB_URL must be postgres://user@host:port/db');
    if (u.password) throw new Error('CFLEX_DB_URL must not carry the password — use CFLEX_DB_PASSWORD_FILE');
    Object.assign(c, { host: u.hostname || '127.0.0.1', port: +u.port || 5432, database: decodeURIComponent(u.pathname.slice(1)) || 'cflex', user: decodeURIComponent(u.username) || 'cflex' });
  } else Object.assign(c, { host: o.host || '127.0.0.1', port: o.port || 5432, database: o.database || 'cflex', user: o.user || 'cflex' });
  if (o.passwordFile) c.password = fs.readFileSync(o.passwordFile, 'utf8').replace(/\r?\n$/, '');
  else if (o.password != null) c.password = o.password;
  return c;
}

function wrap(q) {
  const run = async (sql, ...args) => { const r = await q(toPg(sql), args); return { changes: r.rowCount ?? 0, rows: r.rows }; };
  return {
    one: async (sql, ...args) => (await q(toPg(sql), args)).rows[0],
    all: async (sql, ...args) => (await q(toPg(sql), args)).rows,
    run,
    /** Several statements, no parameters (DDL, migration files). */
    exec: async (sql) => { await q(sql, undefined); },
  };
}

function makeHandle(pool) {
  const h = wrap((text, values) => pool.query(text, values));
  h.pool = pool;

  /** fn(t) inside one transaction on one connection. */
  h.tx = async (fn) => {
    const client = await pool.connect();
    const t = wrap((text, values) => client.query(text, values));
    t.tx = (f) => f(t);   // already inside one
    t.client = client;
    try {
      await client.query('BEGIN');
      const r = await fn(t);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  /**
   * fn(t) on a dedicated connection holding session advisory lock `key`.
   * wait=false: answers {locked:false} at once when another session holds it.
   */
  h.withLock = async (key, fn, { wait = true } = {}) => {
    const client = await pool.connect();
    const t = wrap((text, values) => client.query(text, values));
    t.client = client;
    t.tx = async (f) => {
      await client.query('BEGIN');
      try { const r = await f(t); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    };
    try {
      if (wait) await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NS, key]);
      else if (!(await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_NS, key])).rows[0].ok) return { locked: false };
      try { return { locked: true, result: await fn(t) }; } finally { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NS, key]).catch(() => {}); }
    } finally {
      client.release();
    }
  };

  h.close = () => pool.end();
  return h;
}

/** The migration files, in order: [{version, name, file, sql, checksum}]. */
function migrationFiles(dir = MIGRATIONS) {
  return fs.readdirSync(dir).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map(f => {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return { version: parseInt(f.slice(0, 4), 10), name: f.replace(/\.sql$/, ''), file: f, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * Apply the migrations not yet in schema_migrations, each in its own
 * transaction, under the migrate advisory lock. Returns the versions applied
 * now. A file that changed after it was applied stops the start: the schema
 * on db01 would no longer be what the code expects.
 */
async function migrate(db, { dir = MIGRATIONS, now = Date.now, log = null } = {}) {
  const files = migrationFiles(dir);
  const { result } = await db.withLock(LOCKS.migrate, async (t) => {
    await t.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL, applied_by TEXT)`);
    const done = new Map((await t.all('SELECT version, checksum FROM schema_migrations')).map(r => [r.version, r.checksum]));
    const applied = [];
    for (const m of files) {
      if (done.has(m.version)) {
        if (done.get(m.version) !== m.checksum) {
          throw Object.assign(new Error(`migration ${m.file} was changed after it was applied (checksum differs)`), { code: 'migration_changed' });
        }
        continue;
      }
      await t.tx(async () => {
        await t.exec(m.sql);
        await t.run('INSERT INTO schema_migrations (version, name, checksum, applied_at, applied_by) VALUES (?, ?, ?, ?, ?)',
          m.version, m.name, m.checksum, now(), require('os').hostname());
      });
      applied.push(m.version);
      log?.log?.(`[db] migration ${m.file} applied`);
    }
    return applied;
  });
  return result;
}

/**
 * Open the pool, bring the schema up to date and make sure this month's and
 * the next months' partitions exist (partitions.js; the scheduler keeps them
 * coming after that).
 */
async function open(conn = {}, { migrate: doMigrate = true, partitions = true, partitionOpts = {}, log = null } = {}) {
  const db = makeHandle(new pg.Pool(connection(conn)));
  db.pool.on('error', (e) => log?.error?.(`[db] idle connection: ${e.message}`));
  try {
    if (doMigrate) await migrate(db, { log });
    if (partitions) await require('./partitions').maintain(db, { ...partitionOpts, retention: false, wait: true });
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  return db;
}

/** db.tx(fn), for the call sites that took (db, fn) before. */
const tx = (db, fn) => db.tx(fn);

module.exports = { open, migrate, migrationFiles, connection, tx, toPg, LOCK_NS, LOCKS };
