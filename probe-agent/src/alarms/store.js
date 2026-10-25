// alarms/store.js — a small persistent map, one JSON file, atomic replace.
//
// Used for alarm_id ↔ ServiceNow INC (so a clear resolves the ticket its raise
// opened, across a restart) and for provisional device IDs (so the inventory
// can link an old ID to its successor). Both are a few hundred rows; SQLite
// would be heavier than the data. `path: null` keeps it in memory, for tests.
const fs = require('fs');
const path = require('path');

function jsonStore(file, { maxEntries = 10_000 } = {}) {
  let data = {};
  if (file) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`store ${file}: ${e.message}`);
    }
  }

  function save() {
    if (!file) return;
    // Oldest out first when it grows past the cap; insertion order is age.
    const keys = Object.keys(data);
    if (keys.length > maxEntries) for (const k of keys.slice(0, keys.length - maxEntries)) delete data[k];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    get: (k) => data[k],
    set(k, v) { delete data[k]; data[k] = v; save(); return v; },
    patch(k, v) { data[k] = { ...(data[k] || {}), ...v }; save(); return data[k]; },
    delete(k) { delete data[k]; save(); },
    entries: () => Object.entries(data),
    get size() { return Object.keys(data).length; },
  };
}

module.exports = { jsonStore };
