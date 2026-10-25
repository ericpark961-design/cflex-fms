// alarms/persist.js — the alarm engine's open alarms, kept in the buffer's
// SQLite file so they survive a restart (WO-INT-004b).
//
// One row per named state, a JSON value, replaced whole. The engine's state is
// a few hundred alarms at most; a table per field would be more schema than
// data. Takes any handle with the better-sqlite3 API (exec/prepare/get/run) —
// node:sqlite's DatabaseSync has the same shape, which is what the tests use.
function sqliteState(db, name) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      name     TEXT PRIMARY KEY,
      value    TEXT NOT NULL,
      updated  INTEGER NOT NULL
    );
  `);
  const get = db.prepare('SELECT value FROM state WHERE name = ?');
  const put = db.prepare(`INSERT INTO state (name, value, updated) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated = excluded.updated`);
  return {
    load() {
      const r = get.get(name);
      return r ? JSON.parse(r.value) : null;
    },
    save(value) { put.run(name, JSON.stringify(value), Date.now()); },
  };
}

module.exports = { sqliteState };
