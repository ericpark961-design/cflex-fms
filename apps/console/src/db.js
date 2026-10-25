// db.js — the Local Console's store. SQLite until WO-INT-008 moves it to
// PostgreSQL 16 on db01; every query goes through this file's handle with the
// better-sqlite3 API (prepare/get/all/run/exec), which node:sqlite's
// DatabaseSync shares — the tests use that, production better-sqlite3.
//
// app01 and app02 point at the same database (today: the same file on one
// host for the integration test; in production: db01 after WO-INT-008). The
// app process keeps nothing of its own.
const fs = require('fs');
const path = require('path');

function openSqlite(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function migrate(db) {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

/** BEGIN … COMMIT around fn; ROLLBACK if it throws. Works on both drivers. */
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
