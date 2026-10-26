// health.js — the collector's liveness mark for the container HEALTHCHECK.
//
// The collector has no listener of its own (trap 162 comes with WO-INT-006),
// so "is it healthy" cannot be an HTTP probe. What matters is that the poll
// loop still turns: each finished cycle stamps a small file, and
// bin/cflex-healthcheck.js fails when the stamp is older than a few intervals.
// A process that is up but wedged therefore goes unhealthy, which is the case
// a plain "is PID 1 alive" check misses.
//
// The file lives in /tmp — a tmpfs in the read-only container — so it is
// never on the data volume and never survives a restart.
const fs = require('fs');
const path = require('path');

const FILE = process.env.CFLEX_HEALTH_FILE || path.join(require('os').tmpdir(), 'cflex-collector-health.json');

function mark(cycle, { file = FILE } = {}) {
  const body = JSON.stringify({ at: Date.now(), ok: cycle.ok, fail: cycle.fail, took: cycle.took });
  try {
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    // Health is advisory: never let it take the collector down.
    console.warn(`[probe] health mark failed: ${e.message}`);
  }
}

/** { ok, reason, ageMs } — stale after max(3 × poll interval, 5 min). */
function check({ file = FILE, pollIntervalMs = 60000, now = Date.now() } = {}) {
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'no cycle finished yet' : `unreadable: ${e.message}`, ageMs: null };
  }
  const limit = Math.max(3 * pollIntervalMs, 5 * 60 * 1000);
  const ageMs = now - Number(st.at);
  if (!Number.isFinite(ageMs)) return { ok: false, reason: 'bad timestamp', ageMs: null };
  if (ageMs > limit) return { ok: false, reason: `last cycle ${Math.round(ageMs / 1000)}s ago (limit ${limit / 1000}s)`, ageMs };
  return { ok: true, reason: `last cycle ${Math.round(ageMs / 1000)}s ago`, ageMs };
}

module.exports = { mark, check, FILE };
