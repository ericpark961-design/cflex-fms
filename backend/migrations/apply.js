#!/usr/bin/env node
// Apply FMS SQLite migrations idempotently.
//
//   node backend/migrations/apply.js [--db <path>] [--only 004]
//
// SQLite has no "ALTER TABLE ... ADD COLUMN IF NOT EXISTS", so re-running a
// migration that adds a column raises "duplicate column name". That one error is
// swallowed; everything else aborts, so a genuinely broken statement is not
// mistaken for a replay.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const DB_PATH = arg('--db', process.env.FMS_DB || '/opt/cflex-v2/cflex-api/data/cflex.db');
const ONLY = arg('--only', null);

function openDb(file) {
  try {
    const Better = require('better-sqlite3');          // what the server uses
    return new Better(file);
  } catch {
    const { DatabaseSync } = require('node:sqlite');    // Node 22 fallback, for local runs
    const d = new DatabaseSync(file);
    return { exec: (sql) => d.exec(sql), close: () => d.close() };
  }
}

// Split on semicolons that end a statement. The migrations here contain no
// semicolons inside string literals or triggers; assert that stays true.
function statements(sql) {
  if (/BEGIN\s*;|CREATE\s+TRIGGER/i.test(sql)) throw new Error('apply.js cannot split transactions or triggers — run that migration by hand');
  return sql
    .split('\n')
    .filter(l => !/^\s*--/.test(l))
    // Trailing `-- ...` comments are stripped too: a semicolon inside one used
    // to split the statement it was attached to, which surfaces as a baffling
    // "incomplete input" from SQLite. Only done on lines with no quotes, so a
    // string literal containing `--` is never touched.
    .map(l => (l.includes("'") || l.includes('"')) ? l : l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.sql'))
  .filter(f => !ONLY || f.startsWith(ONLY))
  .sort();

if (!fs.existsSync(DB_PATH)) { console.error(`database not found: ${DB_PATH}`); process.exit(1); }
const db = openDb(DB_PATH);
let ran = 0, skipped = 0;

for (const f of files) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  let stmts;
  try { stmts = statements(sql); } catch (e) { console.log(`- ${f}: SKIPPED (${e.message})`); continue; }
  let applied = 0, already = 0;
  for (const s of stmts) {
    try { db.exec(s); applied++; }
    catch (e) {
      if (/duplicate column name/i.test(e.message)) { already++; continue; }
      console.error(`\n${f}\n  statement: ${s.slice(0, 120)}\n  error: ${e.message}`);
      process.exit(1);
    }
  }
  ran += applied; skipped += already;
  console.log(`- ${f}: ${applied} applied, ${already} already present`);
}
console.log(`\n${files.length} file(s), ${ran} statement(s) applied, ${skipped} already present`);
db.close?.();
