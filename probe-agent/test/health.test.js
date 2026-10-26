// health.test.js — the collector's HEALTHCHECK stamp (images/collector).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const health = require('../src/health');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-health-')), 'h.json');

test('no stamp yet is unhealthy', () => {
  const r = health.check({ file: tmp() });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no cycle/);
});

test('fresh stamp is healthy, stale stamp is not', () => {
  const file = tmp();
  health.mark({ ok: 3, fail: 1, took: 900 }, { file });
  assert.strictEqual(health.check({ file }).ok, true);
  const later = Date.now() + 6 * 60 * 1000;
  assert.strictEqual(health.check({ file, now: later }).ok, false, '6 min > max(3×60s, 5 min)');
  // A slow interval widens the window.
  assert.strictEqual(health.check({ file, now: later, pollIntervalMs: 180000 }).ok, true);
});

test('mark never throws on an unwritable path', () => {
  assert.doesNotThrow(() => health.mark({ ok: 0, fail: 0 }, { file: '/nonexistent-dir/x/h.json' }));
});

test('bin/cflex-healthcheck exit codes', () => {
  const file = tmp();
  const bin = path.join(__dirname, '../bin/cflex-healthcheck.js');
  const run = () => {
    try { execFileSync(process.execPath, [bin], { env: { ...process.env, CFLEX_HEALTH_FILE: file }, stdio: 'pipe' }); return 0; }
    catch (e) { return e.status; }
  };
  assert.strictEqual(run(), 1);
  health.mark({ ok: 1, fail: 0, took: 10 }, { file });
  assert.strictEqual(run(), 0);
});
