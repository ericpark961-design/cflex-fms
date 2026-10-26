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
const { createAlarmEngine } = require('../src/alarms/engine');

const ctx = { tenant: 'HAEA', siteId: 'HMA-FV' };
const TS = '2026-10-23T18:05:12.345Z';
const UUID = '0b8a3f62-5d1e-4c2a-9f7b-1e2d3c4b5a69';

test('all eight appendix-C schema files exist, parse, and carry version 1.2', () => {
  assert.deepStrictEqual(schema.NAMES.length, 8);
  for (const n of schema.NAMES) {
    const s = schema.load(n);
    assert.strictEqual(s.$schema, 'https://json-schema.org/draft/2020-12/schema', n);
    assert.strictEqual(s['x-contract-version'], '1.2', n);
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

// v1.2 (D-13, WO-INT-012): collector_id — and nothing else — is new.
const V11 = {
  heartbeat: { node_id: 'cap01', role: 'collector', version: '2.1.0', uptime_s: 86400, queue_depth: 0,
    last_poll_ok_ratio: 0.998, devices_total: 48, devices_unreachable: 1, clock: TS, profile: 'container', os: 'RHEL 8.10' },
  telemetry: { node_id: 'cap01', points: [{ device_id: '3f9c0a1b2c3d4e5f', ts: TS, m: { bat_pct: 100, status: 'online' } }] },
  events: { events: [{ event_id: UUID, alarm_id: UUID, device_id: '3f9c0a1b2c3d4e5f', site_id: 'HMA-FV', ts: TS,
    kind: 'alarm_raise', severity: 'P1', code: 'UPS_ON_BATTERY', title: 'UPS on battery', source: 'trap' }] },
};

test('v1.2: collector_id on a heartbeat, a telemetry point and an event validates, and survives the §5 whitelist', () => {
  const v12 = {
    heartbeat: { ...V11.heartbeat, node_id: 'app01', collector_id: 'cap02' },
    telemetry: { node_id: 'app01', points: [{ ...V11.telemetry.points[0], collector_id: 'cap02' }] },
    events: { events: [{ ...V11.events.events[0], collector_id: 'cap02' }] },
  };
  for (const [name, body] of Object.entries(v12)) {
    const v = schema.validate(name, body);
    assert.ok(v.ok, `${name}: ${v.errors.join('; ')}`);
    const { value, blocked } = schema.prune(name, body);
    assert.deepStrictEqual(blocked, [], name);
    assert.ok(JSON.stringify(value).includes('"collector_id":"cap02"'), name);
  }
  // The app's own heartbeat: role app, no collector_id.
  assert.ok(schema.validate('heartbeat', { ...V11.heartbeat, node_id: 'app01', role: 'app' }).ok);
});

test('v1.1 → v1.2 is backward compatible: every v1.1 payload (no collector_id) still validates, unchanged by the whitelist', () => {
  for (const [name, body] of Object.entries(V11)) {
    const v = schema.validate(name, body);
    assert.ok(v.ok, `${name}: ${v.errors.join('; ')}`);
    const { value, blocked } = schema.prune(name, body);
    assert.deepStrictEqual([value, blocked], [body, []], name);
  }
});

test('v1.2 adds collector_id only: a bad collector_id is refused, and appendix A keys / appendix B codes are as in v1.1', () => {
  for (const bad of ['CAP01', '', 'cap 01', 'c'.repeat(33), 7]) {
    assert.ok(!schema.validate('events', { events: [{ ...V11.events.events[0], collector_id: bad }] }).ok, JSON.stringify(bad));
    assert.ok(!schema.validate('telemetry', { node_id: 'app01', points: [{ ...V11.telemetry.points[0], collector_id: bad }] }).ok, JSON.stringify(bad));
  }
  // The fields each schema names: v1.1's plus collector_id where the contract adds it.
  const props = (name, at) => Object.keys(at(schema.load(name))).sort();
  assert.deepStrictEqual(props('heartbeat', s => s.properties), ['clock', 'collector_id', 'devices_total', 'devices_unreachable',
    'last_poll_ok_ratio', 'node_id', 'os', 'profile', 'queue_depth', 'role', 'uptime_s', 'version']);
  assert.deepStrictEqual(props('telemetry', s => s.$defs.point.properties), ['collector_id', 'device_id', 'm', 'ts']);
  assert.deepStrictEqual(props('events', s => s.$defs.event.properties), ['alarm_id', 'code', 'collector_id', 'detail', 'device_id',
    'event_id', 'kind', 'local_notified', 'severity', 'site_id', 'source', 'title', 'ts']);
  // Appendix A (27 keys) and appendix B (22 codes) unchanged (Q-2026-10-26-05/14: decided with the HAEA scope, not here).
  assert.strictEqual(Object.keys(schema.load('telemetry').$defs.metrics.properties).length, 27);
  assert.strictEqual(schema.load('events').$defs.code.enum.length, 22);
  assert.deepStrictEqual([...schema.load('events').$defs.code.enum].sort(), Object.keys(require('../src/alarms/codes').SEVERITY).sort());
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

test('local_notified (§3.4): every shape the local notifier returns is schema-valid; wrong types are not', async () => {
  const { createLocalNotifier } = require('../src/alarms/local-notify');
  const ok = { ok: true, status: 201, json: { result: { sys_id: 'a'.repeat(32), number: 'INC0012345' } } };
  const http = async () => ok;
  const n = createLocalNotifier({
    config: {
      email: { to: ['noc@x.y'], from: 'f@x.y' }, teams: { webhook: 'https://h.webhook.office.com/webhookb2/x' },
      servicenow: { instanceUrl: 'https://sn.example', auth: 'Basic x' }, policy: { email_min: 'P4', teams_min: 'P4', itsm_min: 'P4' },
    },
    deps: { http, smtpSend: async () => ({ messageId: '<m@x.y>' }) }, log: { warn() {}, error() {}, log() {} },
  });
  const base = { event_id: UUID, alarm_id: UUID, device_id: '3f9c0a1b2c3d4e5f', site_id: 'HMA-FV', ts: TS,
    severity: 'P1', code: 'UPS_ON_BATTERY', title: 'UPS on battery', detail: {}, source: 'rule' };
  const shapes = [];
  for (const kind of ['alarm_raise', 'alarm_update', 'alarm_clear', 'info']) {
    for (const suppressed of [null, 'maintenance']) {
      shapes.push(await n.handle({ event: { ...base, kind }, suppressed, alarm: { title: 't', label: 'UPS' } }));
    }
  }
  assert.deepStrictEqual(shapes[0], { email: true, teams: true, itsm: 'INC0012345' });
  for (const ln of shapes) {
    const v = schema.validate('events', { events: [{ ...base, kind: 'alarm_raise', local_notified: ln }] });
    assert.ok(v.ok, `${JSON.stringify(ln)}: ${v.errors.join('; ')}`);
  }
  for (const bad of [{ email: 'yes' }, { itsm: 12345 }, { itsm: 'I'.repeat(65) }]) {
    assert.ok(!schema.validate('events', { events: [{ ...base, kind: 'alarm_raise', local_notified: bad }] }).ok, JSON.stringify(bad));
  }
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
  let t = Date.parse(TS);
  const eng = createAlarmEngine({ ctx, now: () => t, opts: { updateEveryMs: 0 } });
  const d = { id: 1, site_id: 'HMA-FV', serial: 'S1' };
  const ev = (items) => items.map(i => i.event);
  t += 31 * 60 * 1000;
  const [e1] = ev(eng.commStatus(d, false, Date.parse(TS)).concat(eng.commStatus(d, false, t)));
  const [e2] = ev(eng.commStatus(d, false, t));
  const [e3] = ev(eng.commStatus(d, true, t));
  assert.deepStrictEqual([e1.kind, e2.kind, e3.kind], ['alarm_raise', 'alarm_update', 'alarm_clear']);
  assert.strictEqual(e1.code, 'UPS_COMM_LOST');
  assert.ok(e1.alarm_id === e2.alarm_id && e2.alarm_id === e3.alarm_id);
  assert.notStrictEqual(e1.event_id, e2.event_id);

  assert.deepStrictEqual(eng.beginCycle(d), []);
  const [hot] = ev(eng.fromAlert(d, { metric: 'temp_c', severity: 'P2', value: 40, threshold: 38, message: 'warm' }).items);
  assert.strictEqual(hot.code, 'UPS_HIGH_TEMP');
  assert.deepStrictEqual(eng.beginCycle(d), []);              // next cycle starts; not yet known to be quiet
  const clears = ev(eng.beginCycle(d));                         // a whole cycle went by without it
  assert.strictEqual(clears.length, 1);
  assert.strictEqual(clears[0].alarm_id, hot.alarm_id);
  assert.strictEqual(clears[0].kind, 'alarm_clear');

  for (const e of [e1, e2, e3, hot, ...clears]) {
    const v = schema.validate('events', { events: [e] });
    assert.ok(v.ok, v.errors.join('; '));
  }
  assert.strictEqual(eng.fromAlert(d, { metric: 'humidity', severity: 'P3' }).code, null);
});

test('Q-05: a device without a serial is inventoried as provisional, keyed on the ledger', () => {
  const noSerial = adapt.inventoryDevice({ id: 77, name: 'IDF UPS', site_id: 'KUS-IRV', kind: 'ups' }, ctx);
  assert.strictEqual(noSerial.provisional, true);
  assert.strictEqual(noSerial.id_basis, 'ledger');
  assert.strictEqual(noSerial.device_id, adapt.deviceId(ctx.tenant, 'KUS-IRV', 'ledger:77'));
  const withSerial = adapt.inventoryDevice({ id: 77, name: 'IDF UPS', site_id: 'KUS-IRV', serial: 'AS1234', kind: 'ups' }, ctx);
  assert.ok(!('provisional' in withSerial) && !('id_basis' in withSerial));
  const v = schema.validate('inventory', { full: true, devices: [noSerial, withSerial,
    { device_id: noSerial.device_id, site_id: 'KUS-IRV', replaced_by: withSerial.device_id }] });
  assert.ok(v.ok, v.errors.join('; '));
});
