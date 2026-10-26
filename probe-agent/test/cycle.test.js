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

  await t('a device that stays down backs off instead of alarming forever', async () => {
    // 41 devices unreachable for six weeks at one alert an hour each is 41 an
    // hour, forever, for a condition nobody can act on until a probe is placed
    // inside the customer network. The interval doubles instead.
    sent.length = 0; answered = new Set();
    ups.unreachableSince.clear();
    const id = 42;
    await ups.pollDevice({ id, name: 'LONG DOWN' });              // the transition
    const first = ups.unreachableSince.get(id);
    assert.equal(first.interval, 60 * 60 * 1000, 'the next one is an hour away');

    // Pretend an hour passed, and keep pretending.
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const st = ups.unreachableSince.get(id);
      ups.unreachableSince.set(id, { ...st, lastAlert: Date.now() - st.interval });
      await ups.pollDevice({ id, name: 'LONG DOWN' });
      seen.push(ups.unreachableSince.get(id).interval / 3600000);
    }
    assert.deepEqual(seen, [2, 4, 8, 16, 24, 24], 'doubling, capped at a day');
    // 7 alerts over what would have been 55 hours, instead of 55.
    assert.equal(sent.filter(s => s.kind === 'alert' && s.payload.severity === 'P2').length, 7);
    const lastAlert = sent.filter(x => x.kind === 'alert').at(-1);
    assert.match(lastAlert.payload.message, /다음 알림 \d+분 후/,
      'and the message says when it will speak again');
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
    // The contract fields (§3.1) the FMS keeps and relays to the Portal as this
    // collector's (D-13). The old cloud's extra names (poll_ok, devices_count …)
    // went with the old-cloud path.
    for (const field of ['devices_total', 'devices_unreachable: lastCycle.fail', 'last_poll_ok_ratio']) {
      assert.match(src, new RegExp(field.replace('.', '\\.')), `the heartbeat sends ${field}`);
    }
    assert.match(src, /devices_total: devices\.length \+ objects\.length/);
  });

  console.log(fail ? `\nFAIL: ${fail} check(s)` : '\nok - the collector reports what actually happened');
  process.exit(fail ? 1 : 0);
})();
