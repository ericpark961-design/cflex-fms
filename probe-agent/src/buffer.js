// buffer.js — local sqlite buffer for events when cflex is unreachable
// Drained as soon as cflex returns 200. Retention enforced on insert.
//
// Two queues in the one file: `events` for the Portal (and the old cloud),
// and a channel per further destination — today the Local Console
// (channel('console')). Each drains in its own order, so an outage of one
// destination never holds up the other.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(path.dirname(cfg.bufferDbPath), { recursive: true });
const db = new Database(cfg.bufferDbPath);

/** One FIFO table with the enqueue/dequeue/ack/fail/stats interface the senders take. */
function sqliteQueue(table) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_ts ON ${table}(ts);
  `);
  return {
    enqueue(kind, payload) {
      db.prepare(`INSERT INTO ${table} (ts, kind, payload) VALUES (?, ?, ?)`).run(Date.now(), kind, JSON.stringify(payload));
    },
    dequeue(limit = 100) {
      return db.prepare(`SELECT id, ts, kind, payload FROM ${table} ORDER BY id ASC LIMIT ?`).all(limit);
    },
    ack(ids) {
      if (!ids || !ids.length) return;
      db.prepare(`DELETE FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    },
    fail(id, error) {
      db.prepare(`UPDATE ${table} SET attempts = attempts + 1, last_error = ? WHERE id = ?`).run(String(error).slice(0, 500), id);
    },
    purgeOld() {
      const cutoff = Date.now() - cfg.bufferRetentionDays * 86400000;
      return db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoff).changes;
    },
    stats() {
      const total = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      const oldest = db.prepare(`SELECT MIN(ts) AS t FROM ${table}`).get().t;
      return { pending: total, oldest_ts: oldest };
    },
  };
}

const main = sqliteQueue('events');
const channels = new Map();

/** A named queue of its own (table `q_<name>`). */
function channel(name) {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`buffer channel name: ${name}`);
  if (!channels.has(name)) channels.set(name, sqliteQueue(`q_${name}`));
  return channels.get(name);
}

function purgeOld() {
  let n = main.purgeOld();
  for (const q of channels.values()) n += q.purgeOld();
  return n;
}

/** Named state in the same file — the alarm engine's open alarms (alarms/persist.js). */
const state = (name) => require('./alarms/persist').sqliteState(db, name);

module.exports = {
  enqueue: main.enqueue, dequeue: main.dequeue, ack: main.ack, fail: main.fail, stats: main.stats,
  purgeOld, state, channel,
};
