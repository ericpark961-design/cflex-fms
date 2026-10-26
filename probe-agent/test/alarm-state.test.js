// node --test probe-agent/test/alarm-state.test.js
//
// WO-INT-004b: the v1.1 capacity warning and its 2-hour hold after a
// discharge, and open alarms surviving a restart in the buffer's SQLite file.
// The file is real, opened with better-sqlite3 — the driver the buffer uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAlarmEngine } = require('../src/alarms/engine');
const { sqliteState } = require('../src/alarms/persist');
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
const quiet = { warn() {}, error() {}, log() {} };
const T0 = Date.parse('2026-10-25T16:00:00.000Z');

const capLow = (pct) => ({ metric: 'battery_pct', severity: 'P2', value: pct, threshold: 60, message: `Battery low (${pct}%)` });
const onBat = { metric: 'output_source', severity: 'P2', value: 'onBattery', message: 'Output source: onBattery' };
const kinds = (items) => items.map(i => i.event.kind);

function clockAt(t) { return { now: () => t, advance: (ms) => (t += ms) }; }

test('UPS_BATTERY_CAPACITY_LOW: P3 under 60 %, schema-valid, clears when capacity is back', () => {
  const c = clockAt(T0);
  const eng = createAlarmEngine({ ctx, now: c.now });
  const r = eng.fromAlert(UPS, capLow(55));
  assert.strictEqual(r.code, 'UPS_BATTERY_CAPACITY_LOW');
  assert.deepStrictEqual([r.items[0].event.kind, r.items[0].event.severity], ['alarm_raise', 'P3']);
  assert.ok(schema.validate('events', { events: [r.items[0].event] }).ok);
  c.advance(MIN); eng.beginCycle(UPS);
  c.advance(MIN);
  const [clr] = eng.beginCycle(UPS);
  assert.strictEqual(clr.event.kind, 'alarm_clear');
  // Under 30 % is still the P1 low battery, not this.
  assert.strictEqual(eng.fromAlert(UPS, { ...capLow(20), severity: 'P1' }).code, 'UPS_LOW_BATTERY');
});

test('capacity hold: nothing while on battery nor for 2 h after the return; raised after that if still low', () => {
  const c = clockAt(T0);
  const eng = createAlarmEngine({ ctx, now: c.now });
  const out = [];
  // The alerts as the UPS poller produces them, in its order.
  const cycle = (metrics) => {
    out.push(...eng.beginCycle(UPS, c.now()));
    for (const a of evaluateAlerts(UPS, metrics)) out.push(...eng.fromAlert(UPS, { ...a, ts: c.now() }).items);
    c.advance(MIN);
  };
  // 10 minutes on battery, from an already part-charged 58 % down to 40 %.
  for (let i = 0; i < 10; i++) cycle({ output_source: 'onBattery', battery_pct: 58 - i * 2, runtime_min: 30 });
  // Back on line, recharging from 40 % — below 60 % for the next 3 hours.
  for (let i = 0; i < 180; i++) cycle({ output_source: 'onLine', battery_pct: 41 });
  const codes = out.map(i => `${i.event.kind}:${i.event.code}`);
  assert.strictEqual(codes[0], 'alarm_raise:UPS_ON_BATTERY');
  assert.ok(codes.includes('alarm_clear:UPS_ON_BATTERY'));
  const capRaises = out.filter(i => i.event.code === 'UPS_BATTERY_CAPACITY_LOW' && i.event.kind === 'alarm_raise');
  assert.strictEqual(capRaises.length, 1, 'one raise, after the hold');
  const back = out.find(i => i.event.code === 'UPS_ON_BATTERY' && i.event.kind === 'alarm_clear').event.ts;
  const held = Date.parse(capRaises[0].event.ts) - Date.parse(back);
  assert.ok(held >= 2 * 60 * MIN && held < 2 * 60 * MIN + 2 * MIN, `raised ${held / MIN} min after the return`);
});

test('capacity hold: a UPS that never went on battery is not held', () => {
  const eng = createAlarmEngine({ ctx, now: () => T0 });
  assert.deepStrictEqual(kinds(eng.fromAlert(UPS, capLow(50)).items), ['alarm_raise']);
});

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-alarm-state-'));
  return path.join(dir, 'buffer.db');
}

test('restart: open alarms come back from the buffer DB and keep their alarm_id', () => {
  const file = tmpDb();
  const c = clockAt(T0);
  let db = new Database(file);
  const first = createAlarmEngine({ ctx, now: c.now, persist: sqliteState(db, 'alarm_engine'), log: quiet });
  const [raise] = first.fromAlert(UPS, { metric: 'temp_c', severity: 'P2', value: 40, threshold: 38, message: 'warm' }).items;
  const [gone] = first.fromAlert({ ...UPS, id: 7, serial: 'Z7' }, { metric: 'load_pct', value: 80, message: 'load' }).items;
  db.close();

  // The process restarts: a new handle on the same file, a new engine.
  c.advance(5 * MIN);
  db = new Database(file);
  const second = createAlarmEngine({ ctx, now: c.now, persist: sqliteState(db, 'alarm_engine'), log: quiet });
  assert.deepStrictEqual(second.openAlarms().map(a => a.alarm_id).sort(), [raise.event.alarm_id, gone.event.alarm_id].sort());

  // Still hot: an update under the old alarm_id, not a second raise.
  second.beginCycle(UPS);
  const again = second.fromAlert(UPS, { metric: 'temp_c', severity: 'P2', value: 41, threshold: 38, message: 'warm', ts: c.advance(20 * MIN) }).items;
  assert.deepStrictEqual(kinds(again), ['alarm_update']);
  assert.strictEqual(again[0].event.alarm_id, raise.event.alarm_id);

  // The other one went away while the Probe was down: cleared after one quiet cycle, same alarm_id.
  const other = { ...UPS, id: 7, serial: 'Z7' };
  assert.deepStrictEqual(second.beginCycle(other), []);
  const [clr] = second.beginCycle(other);
  assert.strictEqual(clr.event.kind, 'alarm_clear');
  assert.strictEqual(clr.event.alarm_id, gone.event.alarm_id);
  db.close();

  // And the clear itself was saved.
  db = new Database(file);
  const third = createAlarmEngine({ ctx, now: c.now, persist: sqliteState(db, 'alarm_engine'), log: quiet });
  assert.deepStrictEqual(third.openAlarms().map(a => a.alarm_id), [raise.event.alarm_id]);
  db.close();
});

test('restart: the capacity hold survives it', () => {
  const file = tmpDb();
  const c = clockAt(T0);
  let db = new Database(file);
  const first = createAlarmEngine({ ctx, now: c.now, persist: sqliteState(db, 'alarm_engine'), log: quiet });
  first.fromAlert(UPS, onBat);
  c.advance(MIN); first.beginCycle(UPS);
  c.advance(MIN); first.beginCycle(UPS);                   // on battery cleared → hold starts
  assert.strictEqual(first.openAlarms().length, 0);
  db.close();

  c.advance(30 * MIN);
  db = new Database(file);
  const second = createAlarmEngine({ ctx, now: c.now, persist: sqliteState(db, 'alarm_engine'), log: quiet });
  assert.deepStrictEqual(second.fromAlert(UPS, capLow(45)).items, [], 'still inside the 2 h hold');
  c.advance(2 * 60 * MIN);
  assert.deepStrictEqual(kinds(second.fromAlert(UPS, capLow(45)).items), ['alarm_raise']);
  db.close();
});

test('restart: an unreadable state row starts empty instead of stopping the Probe', () => {
  const file = tmpDb();
  const db = new Database(file);
  const st = sqliteState(db, 'alarm_engine');
  db.prepare("INSERT OR REPLACE INTO state (name, value, updated) VALUES ('alarm_engine', '{not json', 0)").run();
  const errors = [];
  const eng = createAlarmEngine({ ctx, now: () => T0, persist: st, log: { ...quiet, error: (m) => errors.push(m) } });
  assert.deepStrictEqual(eng.openAlarms(), []);
  assert.match(errors[0], /unreadable/);
  // And it writes a good row over the bad one.
  eng.fromAlert(UPS, capLow(50));
  assert.strictEqual(st.load().open.length, 1);
  db.close();
});
