// node probe-agent/test/cycle.test.js
//
// Two defects this covers, both of which made the collector lie about itself:
//
//   · pollDevice returned undefined whether the device answered or timed out,
//     so the cycle counted every attempt as a success. The agent logged
//     "41 ok, 0 fail" for six weeks while all 41 devices were unreachable.
//   · the cycle was serial, so 41 devices at a 9 s effective SNMP timeout took
//     420 s against a 60 s interval — every tick skipped, and nothing could
//     ever be fresh within the cloud's 5-minute gate.
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

// Stub the network before anything requires it.
const sent = [];
let answered = new Set();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/forwarder$/.test(request) || /forwarder\.js$/.test(request)) {
    return {
      sendEvent: async (kind, payload) => { sent.push({ kind, payload }); },
      heartbeat: async (body) => { sent.push({ kind: 'heartbeat', payload: body }); },
      fetchDeviceConfig: async () => [],
      drain: async () => ({ drained: 0 }),
    };
  }
  if (/ups-metrics$/.test(request) || /ups-metrics\.js$/.test(request)) {
    return {
      pollMetrics: async (device) => {
        // A timeout arrives as an exception here, as the real engine throws it.
        if (!answered.has(device.id)) throw new Error('Request timed out');
        return { ok: true, battery_pct: 100, load_pct: 40, temp_c: 24, runtime_min: 30 };
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const ups = require('../src/pollers/ups');

let fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); }
};

(async () => {
  await t('a device that times out reports a failure, not a success', async () => {
    sent.length = 0; answered = new Set();
    const r = await ups.pollDevice({ id: 1, name: 'IDF UPS 5W-A' });
    assert.equal(r.ok, false, 'the outcome is reported');
    assert.match(r.error, /timed out/);
    assert.equal(sent.find(s => s.kind === 'telemetry').payload.ok, false);
  });

  await t('a device that answers reports a success', async () => {
    sent.length = 0; answered = new Set([2]);
    const r = await ups.pollDevice({ id: 2, name: 'OK UPS' });
    assert.equal(r.ok, true);
    assert.equal(sent.find(s => s.kind === 'telemetry').payload.ok, true);
  });

  await t('an unreachable device alarms on the transition, not every cycle', async () => {
    sent.length = 0; answered = new Set();
    ups.unreachableSince.clear();
    for (let i = 0; i < 20; i++) await ups.pollDevice({ id: 3, name: 'DOWN UPS' });
    const alerts = sent.filter(s => s.kind === 'alert' && s.payload.metric === 'reachability');
    assert.equal(alerts.length, 1,
      `20 cycles of a device that is still down produced ${alerts.length} alarms`);
    assert.equal(alerts[0].payload.severity, 'P2');

    answered = new Set([3]);
    await ups.pollDevice({ id: 3, name: 'DOWN UPS' });
    assert.equal(sent.filter(s => /reachable again/.test(s.payload.message || '')).length, 1,
      'coming back says so');
    answered = new Set();
    await ups.pollDevice({ id: 3, name: 'DOWN UPS' });
    assert.equal(sent.filter(s => s.kind === 'alert' && s.payload.severity === 'P2').length, 2,
      'and the next outage alarms again');
  });

  await t('the cycle is concurrent enough to finish inside the interval', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(src, /Promise\.all\(Array\.from\(\{ length: Math\.min\(cfg\.pollConcurrency/,
      'devices are polled in parallel, bounded');
    assert.ok(!/for \(const d of devices\) \{\s*try \{\s*await upsPoller\.pollDevice/.test(src),
      'the serial loop is gone');
    assert.match(src, /if \(r && r\.ok === false\) \{ fail\+\+;/,
      'the counters come from the reported outcome');
    assert.match(src, /cycle \(\$\{took\}ms\) exceeded the poll interval/,
      'a cycle that still overruns says so rather than silently skipping');
    const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
    const m = /POLL_CONCURRENCY \|\| '(\d+)'/.exec(cfgSrc);
    assert.ok(m, 'POLL_CONCURRENCY has a default');
    const concurrency = parseInt(m[1], 10);
    assert.ok(concurrency >= 4, `concurrency ${concurrency} is too low for 41 devices in 60 s`);
    const parallel = Math.ceil(41 / concurrency) * 9;   // 3 s x (2 retries + 1)
    assert.ok(parallel < 300,
      `${parallel}s must fit the cloud's 5-minute freshness gate (serial was ${41 * 9}s)`);
  });

  await t('the heartbeat carries the cycle, not just liveness', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    for (const field of ['poll_ok', 'poll_fail', 'cycle_ms', 'last_error']) {
      assert.match(src, new RegExp(field), `the heartbeat sends ${field}`);
    }
    // devices_count is what the cloud has always received; both names are sent,
    // because reading only the new one pinned every probe's count at 0.
    assert.match(src, /devices_count: devices\.length/);
    assert.match(src, /devices: devices\.length/);
  });

  console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the collector reports what actually happened');
  process.exit(fail ? 1 : 0);
})();
