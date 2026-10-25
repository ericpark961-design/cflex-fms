// node --test probe-agent/test/alarms.test.js
//
// WO-INT-003 unit tests for the alarm engine: appendix-B classification,
// de-duplication, flapping, maintenance mode and the 30-minute comm-loss hold.
// No network, a hand-driven clock.
const test = require('node:test');
const assert = require('node:assert');
const { createAlarmEngine } = require('../src/alarms/engine');
const codes = require('../src/alarms/codes');
const schema = require('../src/contract/schema');
// The poller's evaluateAlerts is pure; its SNMP engine (net-snmp) is not needed.
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request) {
  if (/ups-metrics(\.js)?$/.test(request)) return { pollMetrics: async () => { throw new Error('not in this test'); } };
  return origLoad.apply(this, arguments);
};
const { evaluateAlerts } = require('../src/pollers/ups');
Module._load = origLoad;

const ctx = { tenant: 'HAEA', siteId: 'HMA-FV' };
const MIN = 60 * 1000;
const UPS = { id: 41, name: 'MPOE UPS 1E-A', site_id: 'HMA-FV', serial: 'AD2248220154' };

function engine(opts = {}, maintenance = []) {
  let t = Date.parse('2026-10-25T16:00:00.000Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; return t; } };
  const eng = createAlarmEngine({ ctx, now: clock.now, opts, maintenance });
  return { eng, clock };
}
const kinds = (items) => items.map(i => i.event.kind);
const validAll = (items) => {
  for (const i of items) {
    const v = schema.validate('events', { events: [i.event] });
    assert.ok(v.ok, v.errors.join('; '));
  }
};

test('codes: the dictionary is appendix B exactly, and the events schema enum is the same set', () => {
  const byP = { P1: 5, P2: 6, P3: 5, P4: 6 };
  for (const [p, n] of Object.entries(byP)) assert.strictEqual(Object.values(codes.SEVERITY).filter(s => s === p).length, n, p);
  const en = schema.load('events').$defs.code.enum;
  assert.deepStrictEqual([...en].sort(), [...codes.CODES].sort());
});

test('classification: severity comes from the code, never from the poller', () => {
  const { eng } = engine();
  // The poller calls on-battery P2; appendix B says UPS_ON_BATTERY is P1.
  const r = eng.fromAlert(UPS, { severity: 'P2', metric: 'output_source', value: 'onBattery', message: 'Output source: onBattery' });
  assert.strictEqual(r.code, 'UPS_ON_BATTERY');
  assert.strictEqual(r.items[0].event.severity, 'P1');
  // And temperature the poller calls P1 is UPS_HIGH_TEMP, P2.
  const hot = eng.fromAlert(UPS, { severity: 'P1', metric: 'temp_c', value: 50, threshold: 45, message: 'hot' });
  assert.strictEqual(hot.items[0].event.severity, 'P2');
  validAll([...r.items, ...hot.items]);
});

test('classification: every alert the UPS poller can produce maps to a code or is counted as unmapped', () => {
  const { eng } = engine();
  const cases = [
    [{ battery_pct: 20 }, 'battery_pct', 'UPS_LOW_BATTERY'],
    [{ battery_pct: 50 }, 'battery_pct', 'UPS_BATTERY_CAPACITY_LOW'],     // warning floor only — v1.1, Q-2026-10-25-07
    [{ temp_c: 50 }, 'temp_c', 'UPS_HIGH_TEMP'],
    [{ temp_c: 40 }, 'temp_c', 'UPS_HIGH_TEMP'],
    [{ load_pct: 95 }, 'load_pct', 'UPS_OVERLOAD'],
    [{ load_pct: 80 }, 'load_pct', 'UPS_OVERLOAD'],
    [{ runtime_min: 3, output_source: 'onLine' }, 'runtime_min', undefined], // not on battery: no runtime alert at all
    [{ output_source: 'onBattery', runtime_min: 3 }, 'runtime_min', 'UPS_LOW_BATTERY'],
    [{ output_source: 'onBattery', runtime_min: 10 }, 'runtime_min', 'UPS_RUNTIME_LOW_WARN'],
    [{ output_source: 'onBattery' }, 'output_source', 'UPS_ON_BATTERY'],
    [{ output_source: 'bypass' }, 'output_source', 'UPS_ON_BYPASS'],
    [{ output_source: 'off' }, 'output_source', 'UPS_OUTPUT_OFF'],
    [{ output_source: 'onSmartBoost' }, 'output_source', null],
    // ups-metrics names upsBasicBatteryStatus normal | low | depleted | unknown.
    [{ battery_status: 'low' }, 'battery_status', 'UPS_LOW_BATTERY'],
    [{ battery_status: 'depleted' }, 'battery_status', 'UPS_LOW_BATTERY'],
    [{ battery_status: 'normal' }, 'battery_status', undefined],
  ];
  for (const [metrics, metric, want] of cases) {
    const a = evaluateAlerts(UPS, metrics).find(x => x.metric === metric);
    if (want === undefined) { assert.strictEqual(a, undefined, JSON.stringify(metrics)); continue; }
    assert.ok(a, `poller produced no ${metric} alert for ${JSON.stringify(metrics)}`);
    assert.strictEqual(eng.fromAlert(UPS, a).code, want, JSON.stringify(metrics));
  }
});

test('de-duplication: a condition seen every minute for an hour is one raise and an update per 15 minutes', () => {
  const { eng, clock } = engine();
  const out = [];
  const a = { metric: 'output_source', value: 'onBattery', message: 'on battery' };
  for (let i = 0; i < 60; i++) {
    out.push(...eng.beginCycle(UPS, clock.now()));
    out.push(...eng.fromAlert(UPS, { ...a, ts: clock.now() }).items);
    clock.advance(MIN);
  }
  assert.deepStrictEqual(kinds(out), ['alarm_raise', 'alarm_update', 'alarm_update', 'alarm_update']);
  assert.strictEqual(new Set(out.map(i => i.event.alarm_id)).size, 1);
  // A second device's same condition is a separate alarm.
  const other = eng.fromAlert({ ...UPS, id: 42, serial: 'X2' }, a).items;
  assert.deepStrictEqual(kinds(other), ['alarm_raise']);
  assert.notStrictEqual(other[0].event.alarm_id, out[0].event.alarm_id);
});

test('flapping: the third raise inside the window holds the alarm open until 15 minutes of quiet', () => {
  const { eng, clock } = engine();
  const a = { metric: 'load_pct', value: 92, threshold: 90, message: 'load' };
  const out = [];
  // Up one cycle, down two (a clear needs a whole quiet cycle), repeated.
  const cycleUp = () => { out.push(...eng.beginCycle(UPS, clock.now())); out.push(...eng.fromAlert(UPS, { ...a, ts: clock.now() }).items); clock.advance(MIN); };
  const cycleDown = () => { out.push(...eng.beginCycle(UPS, clock.now())); clock.advance(MIN); };
  for (let i = 0; i < 6; i++) { cycleUp(); cycleDown(); cycleDown(); }
  // Raise/clear twice, then the third raise is flapping and never clears while it keeps flapping.
  assert.deepStrictEqual(kinds(out), ['alarm_raise', 'alarm_clear', 'alarm_raise', 'alarm_clear', 'alarm_raise']);
  const flap = out[4];
  assert.strictEqual(flap.event.detail.flapping, true);
  validAll(out);

  // Quiet: still open at 14 min, cleared at 15.
  const quiet = [];
  for (let i = 0; i < 16; i++) { quiet.push(...eng.beginCycle(UPS, clock.now())); clock.advance(MIN); }
  assert.deepStrictEqual(kinds(quiet), ['alarm_clear']);
  assert.strictEqual(quiet[0].event.alarm_id, flap.event.alarm_id);
  assert.strictEqual(quiet[0].event.detail.flapping, true);
});

test('flapping: raises spread wider than the window are not flapping', () => {
  const { eng, clock } = engine();
  const a = { metric: 'load_pct', value: 92, message: 'load' };
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(...eng.fromAlert(UPS, { ...a, ts: clock.now() }).items);
    clock.advance(MIN); out.push(...eng.beginCycle(UPS, clock.now()));
    clock.advance(MIN); out.push(...eng.beginCycle(UPS, clock.now()));
    clock.advance(10 * MIN);
  }
  assert.ok(out.every(i => !i.event.detail.flapping));
  assert.strictEqual(kinds(out).filter(k => k === 'alarm_clear').length, 4);
});

test('maintenance: events still go to the Portal, marked, and flagged suppressed; the window ending re-notifies', () => {
  const t0 = Date.parse('2026-10-25T16:00:00.000Z');
  const { eng, clock } = engine({}, [{ ledger_id: 41, until: t0 + 30 * MIN, reason: 'battery swap' }]);
  const a = { metric: 'output_source', value: 'onBattery', message: 'on battery' };
  const [raise] = eng.fromAlert(UPS, { ...a, ts: clock.now() }).items;
  assert.strictEqual(raise.suppressed, 'maintenance');
  assert.strictEqual(raise.event.detail.maintenance, true);
  validAll([raise]);
  // Another device is not in the window.
  const [other] = eng.fromAlert({ ...UPS, id: 7, serial: 'Z' }, a).items;
  assert.strictEqual(other.suppressed, null);

  clock.advance(31 * MIN);
  const [after] = eng.fromAlert(UPS, { ...a, ts: clock.now() }).items;
  assert.strictEqual(after.event.kind, 'alarm_update');
  assert.strictEqual(after.notifyAs, 'raise', 'nobody was told during the window; tell them now');
  assert.strictEqual(after.suppressed, null);
  assert.strictEqual(after.event.detail.maintenance_ended, true);
  assert.strictEqual(after.event.alarm_id, raise.event.alarm_id);
});

test('maintenance: site- and node-wide windows, and expired windows are dropped', () => {
  const t0 = Date.parse('2026-10-25T16:00:00.000Z');
  const { eng, clock } = engine({}, [{ site_id: 'HMA-FV', until: t0 + 10 * MIN }]);
  assert.strictEqual(eng.inMaintenance(UPS), true);
  assert.strictEqual(eng.inMaintenance({ ...UPS, site_id: 'KUS-IRV' }), false);
  clock.advance(11 * MIN);
  assert.strictEqual(eng.inMaintenance(UPS), false);
  assert.deepStrictEqual(eng.maintenanceWindows(), []);
  eng.setMaintenance([{ until: new Date(clock.now() + MIN).toISOString() }]);
  assert.strictEqual(eng.inMaintenance({ ...UPS, site_id: 'KUS-IRV' }), true);
});

test('comm loss: nothing for 29 minutes of silence, UPS_COMM_LOST (P3) at 30, clear on the first answer', () => {
  const { eng, clock } = engine();
  const out = [];
  for (let i = 0; i < 30; i++) { out.push(...eng.commStatus(UPS, false, clock.now(), 'timeout')); clock.advance(MIN); }
  assert.deepStrictEqual(out, []);
  out.push(...eng.commStatus(UPS, false, clock.now(), 'timeout'));
  assert.deepStrictEqual(kinds(out), ['alarm_raise']);
  assert.deepStrictEqual([out[0].event.code, out[0].event.severity, out[0].event.source], ['UPS_COMM_LOST', 'P3', 'poll']);
  assert.strictEqual(out[0].event.detail.down_min, 30);
  clock.advance(MIN);
  out.push(...eng.commStatus(UPS, true, clock.now()));
  assert.deepStrictEqual(kinds(out), ['alarm_raise', 'alarm_clear']);
  validAll(out);

  // A short outage is never an alarm.
  const brief = [];
  for (let i = 0; i < 10; i++) { brief.push(...eng.commStatus(UPS, false, clock.now())); clock.advance(MIN); }
  brief.push(...eng.commStatus(UPS, true, clock.now()));
  assert.deepStrictEqual(brief, []);
});
