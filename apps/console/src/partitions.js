// partitions.js — month partitions for the tables that grow with time
// (spec 01 §2.3: native declarative partitioning, no pg_partman; the app
// creates them ahead of time and drops them past retention).
//
//   telemetry      raw readings          retention raw_years    (default 3)
//   alarm_events   alarm history         retention events_years (default 10)
//   audit_log      the audit trail       retention events_years (default 10)
//
// Aggregates (aggregate_years, default 10) have a setting and no table: the
// console has no aggregate table today and this WO adds none.
//
// A month is [first day 00:00 UTC, next first day) in epoch ms — ts is BIGINT
// epoch ms. Partition names: <table>_pYYYYMM. Only one instance does the work:
// whoever holds the partitions advisory lock (db.js LOCKS.partitions); the
// other skips that round.
//
// A row whose month has no partition yet lands in <table>_default. Creating
// that month later moves those rows into the new partition in the same
// transaction (PostgreSQL refuses to attach a range the default still holds).
const { LOCKS } = require('./db');

const TABLES = Object.freeze({ telemetry: 'raw', alarm_events: 'events', audit_log: 'events' });
const DEFAULTS = Object.freeze({ rawYears: 3, aggregateYears: 10, eventsYears: 10, aheadMonths: 3 });

const monthStart = (y, m) => Date.UTC(y, m, 1);   // m 0-based, may overflow (Date.UTC normalises)
function monthOf(ms) { const d = new Date(ms); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; }
const partName = (table, y, m) => `${table}_p${y}${String(m + 1).padStart(2, '0')}`;
const NAME_RE = /^(.+)_p(\d{4})(\d{2})$/;

/** The partitions a table has now: [{name, y, m, from, to}] (default partition excluded). */
async function list(db, table) {
  const rows = await db.all(`SELECT c.relname AS name FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ? AND pg_table_is_visible(p.oid) ORDER BY c.relname`, table);
  return rows.map(r => NAME_RE.exec(r.name)).filter(m => m && m[1] === table)
    .map(m => { const y = +m[2], mo = +m[3] - 1; return { name: m[0], y, m: mo, from: monthStart(y, mo), to: monthStart(y, mo + 1) }; });
}

/** Create the month partition holding `y-m` if it is not there. → name created, or null. */
async function createMonth(db, table, y, m) {
  const d = new Date(monthStart(y, m));
  y = d.getUTCFullYear(); m = d.getUTCMonth();
  const name = partName(table, y, m);
  const from = monthStart(y, m), to = monthStart(y, m + 1);
  return db.tx(async (t) => {
    if ((await t.one('SELECT to_regclass(?) IS NOT NULL AS e', name)).e) return null;
    const stray = await t.one(`SELECT COUNT(*) AS n FROM ${table}_default WHERE ts >= ? AND ts < ?`, from, to);
    if (!stray.n) {
      await t.exec(`CREATE TABLE ${name} PARTITION OF ${table} FOR VALUES FROM (${from}) TO (${to})`);
      return name;
    }
    // Rows for this month already sit in the default partition: move them over, then attach.
    await t.exec(`SET LOCAL cflex.partition_move = 'on'`);
    await t.exec(`CREATE TABLE ${name} (LIKE ${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    await t.run(`INSERT INTO ${name} SELECT * FROM ${table}_default WHERE ts >= ? AND ts < ?`, from, to);
    await t.run(`DELETE FROM ${table}_default WHERE ts >= ? AND ts < ?`, from, to);
    await t.exec(`ALTER TABLE ${table} ATTACH PARTITION ${name} FOR VALUES FROM (${from}) TO (${to})`);
    return name;
  });
}

/** Partitions for every month from `fromMs` to `toMs` (inclusive). → names created. */
async function ensureRange(db, table, fromMs, toMs) {
  const made = [];
  const a = monthOf(fromMs), b = monthOf(toMs);
  for (let y = a.y, m = a.m; y < b.y || (y === b.y && m <= b.m); m === 11 ? (y++, m = 0) : m++) {
    const n = await createMonth(db, table, y, m);
    if (n) made.push(n);
  }
  return made;
}

/** The first ms still inside retention: the same calendar day `years` ago (UTC). */
function cutoff(now, years) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear() - years, d.getUTCMonth(), d.getUTCDate());
}

/**
 * Drop what is past retention: every month partition that ends at or before
 * the cutoff is DETACHed, then DROPped; rows older than the cutoff in the
 * default partition are deleted. → names dropped.
 */
async function expire(db, table, years, now) {
  const cut = cutoff(now, years);
  const dropped = [];
  for (const p of await list(db, table)) {
    if (p.to > cut) continue;
    await db.exec(`ALTER TABLE ${table} DETACH PARTITION ${p.name}`);
    await db.exec(`DROP TABLE ${p.name}`);
    dropped.push(p.name);
  }
  await db.tx(async (t) => {
    await t.exec(`SET LOCAL cflex.partition_move = 'on'`);
    await t.run(`DELETE FROM ${table}_default WHERE ts < ?`, cut);
  });
  return dropped;
}

function years(o, kind) {
  const v = Number(kind === 'raw' ? o.rawYears : o.eventsYears);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULTS[kind === 'raw' ? 'rawYears' : 'eventsYears'];
}

/**
 * One maintenance round: this month and the next `aheadMonths` exist for
 * every table; with retention on, what is past it is dropped.
 *
 * @param {object} o  {now, aheadMonths, rawYears, eventsYears, retention=true, wait=false}
 *                    wait: block for the lock (start-up) instead of skipping when the other node has it
 * @returns {{ran: boolean, created: string[], dropped: string[]}}
 */
async function maintain(db, o = {}) {
  const now = (o.now || Date.now)();
  const ahead = Number.isFinite(+o.aheadMonths) && +o.aheadMonths >= 1 ? Math.floor(+o.aheadMonths) : DEFAULTS.aheadMonths;
  const r = await db.withLock(LOCKS.partitions, async (t) => {
    const created = [], dropped = [];
    const { y, m } = monthOf(now);
    for (const [table, kind] of Object.entries(TABLES)) {
      created.push(...await ensureRange(t, table, now, monthStart(y, m + ahead)));
      if (o.retention !== false) dropped.push(...await expire(t, table, years(o, kind), now));
    }
    return { created, dropped };
  }, { wait: !!o.wait });
  return r.locked ? { ran: true, ...r.result } : { ran: false, created: [], dropped: [] };
}

/**
 * Run maintain() now and every `intervalMs` (default 6 h). Both nodes run the
 * timer; the advisory lock lets one of them do the round. → {stop()}.
 */
function schedule(db, o = {}, log = console) {
  const every = o.intervalMs || 6 * 3600e3;
  let running = null;
  const round = () => {
    if (running) return running;
    running = maintain(db, o).then((r) => {
      if (r.created.length || r.dropped.length) log.log(`[partitions] created ${r.created.join(', ') || '-'}; dropped ${r.dropped.join(', ') || '-'}`);
      return r;
    }).catch((e) => { log.error(`[partitions] ${e.message}`); return null; }).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(round, every);
  timer.unref();
  const first = round();
  return { stop: () => clearInterval(timer), round, first };
}

/** For `verify`: is there a partition for the current month (and the next), per table? */
async function status(db, now = Date.now()) {
  const { y, m } = monthOf(now);
  const nx = monthOf(monthStart(y, m + 1));
  const out = {};
  for (const table of Object.keys(TABLES)) {
    const names = new Set((await list(db, table)).map(p => p.name));
    out[table] = { current: names.has(partName(table, y, m)), next: names.has(partName(table, nx.y, nx.m)), count: names.size };
  }
  return out;
}

module.exports = { TABLES, DEFAULTS, maintain, schedule, ensureRange, createMonth, expire, list, status, cutoff, partName, monthStart, monthOf };
