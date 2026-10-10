#!/usr/bin/env node
// Import a ledger JSON through the same code path as POST /v1/fms/topology/import.
//
//   node backend/seed/import_topology.js kmx_ccr_topology.json --tenant 10 --cbu KMX [--replace] [--db <path>] [--dry-run]
//
// The route and the seed share backend/services/fms-topology.js on purpose: a
// seeded ledger and an imported one must not be able to drift.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
const tenant = parseInt(arg('--tenant', ''), 10);
const cbu = arg('--cbu', null);
const dbPath = arg('--db', process.env.FMS_DB || '/opt/cflex-v2/cflex-api/data/cflex.db');
const mode = flag('--replace') ? 'replace' : 'merge';

if (!file || !Number.isFinite(tenant)) {
  console.error('usage: import_topology.js <ledger.json> --tenant <id> [--cbu KMX] [--replace] [--db <path>] [--dry-run]');
  process.exit(2);
}

const resolved = fs.existsSync(file) ? file : path.join(__dirname, file);
const doc = JSON.parse(fs.readFileSync(resolved, 'utf8'));

function openDb(f) {
  try { return new (require('better-sqlite3'))(f); }
  catch {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(f);
    return {
      prepare: (q) => { const st = d.prepare(q); return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) }; },
      exec: (q) => d.exec(q), close: () => d.close(),
    };
  }
}

if (!fs.existsSync(dbPath)) { console.error(`database not found: ${dbPath}`); process.exit(1); }
const db = openDb(dbPath);
const T = require('../services/fms-topology');

if (flag('--dry-run')) {
  // Import into a throwaway copy so a bad ledger is caught before it touches the real DB.
  const tmp = `/tmp/ledger-dryrun-${Date.now()}.db`;
  fs.copyFileSync(dbPath, tmp);
  const t = openDb(tmp);
  try {
    const r = T.importTopology(t, tenant, doc, { mode, cbu });
    console.log('DRY RUN —', JSON.stringify(r, null, 2));
  } finally { t.close?.(); fs.unlinkSync(tmp); }
  process.exit(0);
}

const r = T.importTopology(db, tenant, doc, { mode, cbu });
console.log(JSON.stringify({ mode, tenant, cbu: cbu || doc.cbu, ...r }, null, 2));
db.close?.();
