// buffer.js — local sqlite buffer for events when cflex is unreachable
// Drained as soon as cflex returns 200. Retention enforced on insert.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(path.dirname(cfg.bufferDbPath), { recursive: true });
const db = new Database(cfg.bufferDbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`);

function enqueue(kind, payload) {
  db.prepare('INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)')
    .run(Date.now(), kind, JSON.stringify(payload));
}

function dequeue(limit = 100) {
  return db.prepare('SELECT id, ts, kind, payload FROM events ORDER BY id ASC LIMIT ?').all(limit);
}

function ack(ids) {
  if (!ids || !ids.length) return;
  const stmt = db.prepare(`DELETE FROM events WHERE id IN (${ids.map(() => '?').join(',')})`);
  stmt.run(...ids);
}

function fail(id, error) {
  db.prepare('UPDATE events SET attempts = attempts + 1, last_error = ? WHERE id = ?')
    .run(String(error).slice(0, 500), id);
}

function purgeOld() {
  const cutoff = Date.now() - cfg.bufferRetentionDays * 86400000;
  const r = db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  return r.changes;
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  const oldest = db.prepare('SELECT MIN(ts) AS t FROM events').get().t;
  return { pending: total, oldest_ts: oldest };
}

module.exports = { enqueue, dequeue, ack, fail, purgeOld, stats };
