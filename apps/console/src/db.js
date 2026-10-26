// db.js — the Local Console's store. SQLite until WO-INT-008 moves it to
// PostgreSQL 16 on db01; every query goes through this file's handle with the
// better-sqlite3 API (prepare/get/all/run/exec). better-sqlite3 is the only
// driver, in production and in the tests alike (WO-INT-007): Node 20, the
// version the images and the bare profile run, has no node:sqlite.
//
// app01 and app02 point at the same database (today: the same file on one
// host for the integration test; in production: db01 after WO-INT-008). The
// app process keeps nothing of its own.
const fs = require('fs');
const path = require('path');

function openSqlite(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function migrate(db) {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Columns added after a table first shipped: CREATE TABLE IF NOT EXISTS
  // leaves an existing table alone, so they are added here.
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!has('alarm_events', 'local_notified')) db.exec('ALTER TABLE alarm_events ADD COLUMN local_notified TEXT');
}

/** BEGIN … COMMIT around fn; ROLLBACK if it throws. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function open(file) {
  const db = openSqlite(file);
  migrate(db);
  return db;
}

module.exports = { open, tx };
