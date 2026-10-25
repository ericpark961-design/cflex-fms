// node --test probe-agent/test/contract.test.js
//
// Contract §7: the Probe validates what it generates against the shared
// schema files. Three things this pins down:
//
//   · the contract's own examples pass the schemas (or the schemas are wrong),
//   · every payload the adapters build from real poller output passes,
//   · the §5 whitelist strips anything the contract does not name — a user's
//     e-mail riding along in an alert never leaves the node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const schema = require('../src/contract/schema');
const adapt = require('../src/contract/adapt');

const ctx = { tenant: 'HAEA', siteId: 'HMA-FV' };
const TS = '2026-10-23T18:05:12.345Z';
const UUID = '0b8a3f62-5d1e-4c2a-9f7b-1e2d3c4b5a69';

test('all eight appendix-C schema files exist, parse, and carry version 1.0', () => {
  assert.deepStrictEqual(schema.NAMES.length, 8);
  for (const n of schema.NAMES) {
    const s = schema.load(n);
    assert.strictEqual(s.$schema, 'https://json-schema.org/draft/2020-12/schema', n);
    assert.strictEqual(s['x-contract-version'], '1.0', n);
  }
  assert.deepStrictEqual(
    fs.readdirSync(schema.SCHEMA_DIR).filter(f => f.endsWith('.schema.json')).sort(),
    schema.NAMES.map(n => `${n}.schema.json`).sort(),
  );
});

test('the contract document examples validate', () => {
  const cases = [
    ['heartbeat', { node_id: 'cap01', role: 'collector', version: '2.1.0', uptime_s: 86400, queue_depth: 0,
      last_poll_ok_ratio: 0.998, devices_total: 48, devices_unreachable: 1, clock: TS, profile: 'container', os: 'RHEL 8.10' }],
    ['heartbeat#/$defs/response', { ack: true, commands_pending: 2, config_version: 17 }],
    ['inventory', { full: true, devices: [{ device_id: '3f9c0a1b2c3d4e5f', site_id: 'HMA-FV', label: 'MPOE UPS 1E-A',
      vendor: 'APC', model: 'SYAF16KRMT', serial: 'AD2248220154', serial_alt: ['5D2249T04846'], nmc_ip: '10.112.5.34',
      location: { building: 'HMA FV', floor: '1E', room: 'IE Info Room', rack: '4' }, in_sow: true, mfg_date: '2022-11',
      mfg_date_source: 'serial', firmware: 'v7.0.4', battery: { installed: '2022-11', due: '2027-05', strings: 4 }, tags: ['symmetra'] }] }],
    ['telemetry', { node_id: 'cap01', points: [{ device_id: '3f9c0a1b2c3d4e5f', ts: '2026-10-23T18:05:00.000Z',
      m: { in_v: [124.5, 121.9], out_v: [120.2, 119.4], out_a: [20, 19], load_pct: 37, load_kw: 4.7, bat_pct: 100,
        runtime_s: 1500, bat_temp_c: 21.0, bat_v: 138, status: 'online', selftest: 'ok', alarm_bits: '0x0000' } }] }],
    ['events', { events: [{ event_id: UUID, alarm_id: UUID, device_id: '3f9c0a1b2c3d4e5f', site_id: 'HMA-FV', ts: TS,
      kind: 'alarm_raise', severity: 'P1', code: 'UPS_ON_BATTERY', title: 'UPS on battery',
      detail: { runtime_s: 420, bat_pct: 62 }, source: 'trap', local_notified: { email: true, teams: false, itsm: 'INC0012345' } }] }],
    ['files', { kind: 'pm_report', site_id: 'HMA-FV', ts: TS, sha256: 'a'.repeat(64) }],
    ['commands', { commands: [{ cmd_id: UUID, type: 'poll_now', issued: TS, expires: TS, payload: {} }] }],
    ['commands#/$defs/result', { status: 'ok', detail: {} }],
    ['config', { config_version: 18, config: { poll_interval_s: 60 } }],
    ['error', { error: { code: 'rate_limited', message: 'slow down', details: {} } }],
  ];
  for (const [name, body] of cases) {
    const v = schema.validate(name, body);
    assert.ok(v.ok, `${name}: ${v.errors.join('; ')}`);
  }
});

test('schemas refuse what the contract forbids', () => {
  const bad = [
    ['events', { events: [{ event_id: UUID, alarm_id: UUID, device_id: 'x', site_id: 'HMA-FV', ts: TS, kind: 'alarm_raise',
      severity: 'P1', code: 'UPS_ON_BATTERY', title: 't', source: 'poll' }] }, /device_id/],
    ['events', { events: [{ event_id: UUID, alarm_id: UUID, device_id: null, site_id: 'HMA-FV', ts: TS, kind: 'alarm_raise',
      severity: 'P1', code: 'UPS_SMOKING', title: 't', source: 'poll' }] }, /code/],
    ['heartbeat', { node_id: 'cap01', role: 'collector', version: '1', uptime_s: 1, queue_depth: 0, clock: '2026-10-23T18:05:12Z' }, /clock/],
    ['commands', { commands: [{ cmd_id: UUID, type: 'shell', issued: TS, expires: TS }] }, /type/],
    ['telemetry', { node_id: 'cap01', points: [{ device_id: '3f9c0a1b2c3d4e5f', ts: TS, m: { nested: { a: 1 } } }] }, /nested/],
    ['heartbeat', { node_id: 'cap01', role: 'collector', version: '1', uptime_s: 1, queue_depth: 0, clock: TS, operator_email: 'a@b.c' }, /operator_email/],
  ];
  for (const [name, body, where] of bad) {
    const v = schema.validate(name, body);
    assert.ok(!v.ok, `${name} should fail`);
    assert.match(v.errors.join(' '), where);
  }
});

test('the validator fails loudly on a keyword it does not implement', () => {
  const root = schema.load('error');
  const saved = root.properties.error.properties.code;
  root.properties.error.properties.code = { type: 'string', format: 'email' };
  try {
    assert.throws(() => schema.validate('error', { error: { code: 'x', message: 'y' } }), /not supported.*format/);
  } finally { root.properties.error.properties.code = saved; }
});

test('§5 whitelist: keys outside the contract are dropped and reported', () => {
  const { value, blocked } = schema.prune('events', { events: [{
    event_id: UUID, alarm_id: UUID, device_id: null, site_id: 'HAEA-HQ', ts: TS, kind: 'info', severity: 'P4',
    code: 'CLOCK_DRIFT', title: 't', source: 'system', acked_by: 'jane.doe@haea.example', user_ip: '10.1.2.3',
    local_notified: { email: true, recipients: ['jane.doe@haea.example'] },
  }] });
  assert.deepStrictEqual(blocked.sort(), ['$.events[0].acked_by', '$.events[0].local_notified.recipients', '$.events[0].user_ip']);
  assert.ok(!JSON.stringify(value).includes('jane.doe'));
  assert.ok(schema.validate('events', value).ok);
});

test('device_id is sha1(tenant|site|serial)[:16]', () => {
  // sha1("HAEA|HMA-FV|AD2248220154")
  const id = adapt.deviceId('HAEA', 'HMA-FV', 'AD2248220154');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.strictEqual(id, require('crypto').createHash('sha1').update('HAEA|HMA-FV|AD2248220154').digest('hex').slice(0, 16));
  // Telemetry, events and inventory derive the same ID for the same ledger row.
  const d = { id: 7, site_id: 'hma-fv', serial: 'AD2248220154', name: 'UPS', kind: 'ups', ip: '10.112.5.34' };
  assert.strictEqual(adapt.deviceIdFor(d, ctx), id);
  assert.strictEqual(adapt.inventoryDevice(d, ctx).device_id, id);
});

test('adapters turn real poller output into valid contract payloads', () => {
  const ups = { id: 1, name: 'UPS 1E-A', site_id: 'HMA-FV', serial: 'AD2248220154', model: 'SYAF16KRMT', vendor: 'APC', ip: '10.112.5.34', kind: 'ups' };
  const ok = adapt.upsPoint(ups, { ts: Date.parse(TS), ok: true, took_ms: 812, metrics: {
    ok: true, battery_pct: 100, load_pct: 37, temp_c: 21, runtime_min: 25, output_v: 120.2, input_v: 124.5,
    output_source: 'onLine', battery_status: 'normal', status: 'ok', health_score: 100, firmware: 'UPS 09.3',
  } }, ctx);
  const down = adapt.upsPoint({ id: 2, site_id: 'HMA-FV' }, { ts: Date.parse(TS), ok: false, error: 'Request timed out', took_ms: 9000 }, ctx);
  const pdu = adapt.collectorPoint({ id: 3, site_id: 'HMA-FV', kind: 'pdu' }, { ts: Date.parse(TS), metrics: [
    { metric: 'phase_current_a', value: 12.4, unit: 'A' }, { metric: 'Load State', value: null, str_value: 'normal' },
  ] }, ctx);
  const t = { node_id: 'cap01', points: [ok, down, pdu] };
  const v = schema.validate('telemetry', t);
  assert.ok(v.ok, v.errors.join('; '));
  assert.strictEqual(ok.m.runtime_s, 1500);
  assert.strictEqual(ok.m.status, 'online');
  assert.strictEqual(down.m.comm_ok, false);
  assert.strictEqual(pdu.m.load_state, 'normal');

  const inv = { full: true, devices: [adapt.inventoryDevice(ups, ctx), adapt.inventoryDevice({ id: 9, name: 'Patch', kind: 'patch', ip: 'n/a' }, ctx)] };
  const vi = schema.validate('inventory', inv);
  assert.ok(vi.ok, vi.errors.join('; '));
});

test('alarm lifecycle: raise → update → clear on recovery, and a threshold clears after a quiet cycle', () => {
  const book = new adapt.AlarmBook();
  const d = { id: 1, site_id: 'HMA-FV', serial: 'S1' };
  const down = { metric: 'reachability', severity: 'P2', message: 'UPS unreachable: timeout', ts: Date.parse(TS) };
  const e1 = book.fromAlert(d, down, ctx);
  const e2 = book.fromAlert(d, down, ctx);
  const e3 = book.fromAlert(d, { metric: 'reachability', severity: 'P4', message: 'UPS reachable again' }, ctx);
  assert.deepStrictEqual([e1.kind, e2.kind, e3.kind], ['alarm_raise', 'alarm_update', 'alarm_clear']);
  assert.strictEqual(e1.code, 'UPS_COMM_LOST');
  assert.ok(e1.alarm_id === e2.alarm_id && e2.alarm_id === e3.alarm_id);
  assert.notStrictEqual(e1.event_id, e2.event_id);

  assert.deepStrictEqual(book.onPoll(d, ctx), []);
  const hot = book.fromAlert(d, { metric: 'temp_c', severity: 'P2', value: 40, threshold: 38, message: 'warm' }, ctx);
  assert.strictEqual(hot.code, 'UPS_HIGH_TEMP');
  assert.deepStrictEqual(book.onPoll(d, ctx), []);           // next cycle starts; not yet known to be quiet
  const clears = book.onPoll(d, ctx);                           // a whole cycle went by without it
  assert.strictEqual(clears.length, 1);
  assert.strictEqual(clears[0].alarm_id, hot.alarm_id);
  assert.strictEqual(clears[0].kind, 'alarm_clear');

  for (const e of [e1, e2, e3, hot, ...clears]) {
    const v = schema.validate('events', { events: [e] });
    assert.ok(v.ok, v.errors.join('; '));
  }
  assert.strictEqual(book.fromAlert(d, { metric: 'humidity', severity: 'P3' }, ctx), null);
});
