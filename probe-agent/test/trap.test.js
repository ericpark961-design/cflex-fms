// node --test probe-agent/test/trap.test.js
//
// WO-INT-006: the SNMP trap listener. Real UDP on 127.0.0.1 with the
// simulator (sim/sim-trap.js) for v1, v2c and v3 authPriv; the handler
// directly for what one loopback address cannot show (an unknown sender).
const test = require('node:test');
const assert = require('node:assert');
const { createAlarmEngine } = require('../src/alarms/engine');
const { createForwarder } = require('../src/forwarder');
const { createConsoleClient } = require('../src/console/client');
const codes = require('../src/alarms/codes');
const schema = require('../src/contract/schema');
const apc = require('../src/trap/apc-mib');
const { createTrapHandler, decode } = require('../src/trap/handler');
const { createTrapListener, credentialsOf } = require('../src/trap/listener');
const sim = require('../sim/sim-trap');
const { memQueue } = require('./support/memqueue');

const ctx = { tenant: 'HAEA', siteId: 'HMA-FV' };
const MIN = 60 * 1000;
const quiet = { log() {}, info() {}, warn() {}, error() {} };
// Test-only credentials, not any site's.
const USER = { name: 'cflex-trap-test', authKey: 'test-auth-key-0001', privKey: 'test-priv-key-0001' };
const COMMUNITY = 'trap-test-community';
const UPS = {
  id: 41, name: 'MPOE UPS 1E-A', site_id: 'HMA-FV', serial: 'AD2248220154', kind: 'ups', ip: '127.0.0.1',
  snmp_version: 'v3', snmp_community: COMMUNITY,
  snmp_v3_user: USER.name, snmp_v3_auth_protocol: 'sha', snmp_v3_auth_password: USER.authKey,
  snmp_v3_priv_protocol: 'aes', snmp_v3_priv_password: USER.privKey,
};

function clock() {
  let t = Date.parse('2026-10-26T16:00:00.000Z');
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

/** A listener on a random loopback port with UPS as the inventory. */
function rig({ devices = [UPS], engine, emit } = {}) {
  const c = clock();
  const eng = engine || createAlarmEngine({ ctx, now: c.now, log: quiet });
  const out = [];
  const handler = createTrapHandler({ engine: eng, emit: emit || (async (items) => { out.push(...items); }), now: c.now, log: quiet });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const listener = createTrapListener({ handler, port, bind: '127.0.0.1', log: quiet }).start();
  listener.setInventory(devices);
  const send = (s) => sim.send({ host: '127.0.0.1', port, community: COMMUNITY, user: USER, ...s });
  return { eng, out, handler, listener, send, clock: c };
}

async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting for traps');
    await new Promise(r => setTimeout(r, 10));
  }
}

const validAll = (items) => {
  for (const i of items) {
    const v = schema.validate('events', { events: [i.event] });
    assert.ok(v.ok, v.errors.join('; '));
  }
};

test('apc-mib: every mapped code is appendix B, every raise has a clear, nothing else is mapped', () => {
  const byCode = {};
  for (const [n, t] of Object.entries(apc.TRAPS)) {
    assert.ok(codes.SEVERITY[t.code], `${t.name} → ${t.code} is not in appendix B`);
    (byCode[t.code] ||= new Set()).add(t.action);
    assert.strictEqual(apc.lookup(`1.3.6.1.4.1.318.0.${n}`).name, t.name);
  }
  for (const [code, acts] of Object.entries(byCode)) assert.ok(acts.has('raise') && acts.has('clear'), code);
  assert.strictEqual(apc.lookup('1.3.6.1.4.1.318.0.9999'), null);
  assert.strictEqual(apc.lookup('1.3.6.1.4.1.5528.100.10.2.1'), null, 'NetBotz has no appendix-B code');
  assert.strictEqual(apc.lookup('1.3.6.1.6.3.1.1.5.1'), null);
  // Poll-observed codes are not latched; trap-only ones are.
  assert.strictEqual(apc.lookup('1.3.6.1.4.1.318.0.5').latched, false);
  assert.strictEqual(apc.lookup('1.3.6.1.4.1.318.0.3').latched, true);
});

test('decode: v1 enterprise-specific and generic, v2c snmpTrapOID (RFC 3584)', () => {
  assert.strictEqual(decode({ type: 164, enterprise: '1.3.6.1.4.1.318', generic: 6, specific: 5, agentAddr: '10.1.1.1', varbinds: [] }).trapOid,
    '1.3.6.1.4.1.318.0.5');
  assert.strictEqual(decode({ type: 164, enterprise: '1.3.6.1.4.1', generic: 0, specific: 0, varbinds: [] }).trapOid, '1.3.6.1.6.3.1.1.5.1');
  const v2 = decode({ type: 167, community: 'x', varbinds: [
    { oid: '1.3.6.1.2.1.1.3.0', value: 1 }, { oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.4.1.318.0.7' }, { oid: '1.3.6.1.4.1.318.2.3.10.0', value: 'x' }] });
  assert.deepStrictEqual([v2.version, v2.trapOid, v2.varbinds.length], ['v2c', '1.3.6.1.4.1.318.0.7', 1]);
  assert.strictEqual(decode({ type: 167, user: 'u', varbinds: [] }).version, 'v3');
});

test('credentials: one community per v2c device, v3 users with keys, no implied "public" for v3', () => {
  const c = credentialsOf([
    UPS,
    { id: 2, ip: '10.0.0.2', snmp_version: 'v2c', snmp_community: 'c2' },
    { id: 3, ip: '10.0.0.3', snmp_version: 'v2c' },
    { id: 4, ip: '10.0.0.4', snmp_version: 'v3', snmp_v3_user: 'other', snmp_v3_auth_protocol: 'sha', snmp_v3_auth_password: 'a'.repeat(10) },
  ], { log: quiet });
  assert.deepStrictEqual(c.communities.sort(), [COMMUNITY, 'c2', 'public'].sort());
  assert.deepStrictEqual(c.users.map(u => u.name).sort(), [USER.name, 'other'].sort());
});

test('scenario: 13 trap kinds over v1, v2c and v3 authPriv → appendix-B alarms; unknown OIDs recorded only', async () => {
  const r = rig();
  try {
    for (const s of sim.SCENARIO) await r.send(s);
    await until(() => r.handler.stats().received === sim.SCENARIO.length);
    const st = r.listener.stats();
    assert.deepStrictEqual(st.by_version, { v1: 4, v2c: 8, v3: 3 });
    assert.ok(new Set(sim.SCENARIO.map(sim.oidOf)).size >= 10, 'at least 10 kinds');
    assert.strictEqual(st.unknown_oid, 2);
    assert.strictEqual(st.discarded.auth, 0);
    assert.deepStrictEqual(r.out.map(i => `${i.event.kind} ${i.event.code}`), [
      'alarm_raise UPS_ON_BATTERY', 'alarm_raise UPS_LOW_BATTERY', 'alarm_clear UPS_LOW_BATTERY', 'alarm_clear UPS_ON_BATTERY',
      'alarm_raise UPS_OVERLOAD', 'alarm_clear UPS_OVERLOAD',
      'alarm_raise UPS_BATTERY_REPLACE',
      'alarm_raise UPS_SELFTEST_FAIL', 'alarm_clear UPS_SELFTEST_FAIL',
      // communicationLost then Established inside 30 min: nothing (appendix B hold).
      'alarm_raise UPS_ON_BYPASS', 'alarm_clear UPS_ON_BYPASS',
    ]);
    for (const i of r.out) assert.strictEqual(i.event.source, 'trap');
    assert.strictEqual(r.out[0].event.severity, 'P1', 'severity is the code\'s');
    assert.strictEqual(r.out[0].event.detail.snmp_version, 'v1');
    assert.strictEqual(r.out[4].event.detail.snmp_version, 'v3');
    // A raise and its clear are one alarm.
    assert.strictEqual(r.out[0].event.alarm_id, r.out[3].event.alarm_id);
    validAll(r.out);
    assert.deepStrictEqual(r.handler.recent().map(x => x.kind), ['unknown_oid', 'unknown_oid']);
  } finally { await r.listener.stop(); }
});

test('wrong community and failed v3 authentication: dropped and counted, nothing raised', async () => {
  const r = rig();
  try {
    await r.send({ trap: 'upsOnBattery', version: 'v2c', community: 'not-the-community' });
    await r.send({ trap: 'upsOnBattery', version: 'v1', community: 'not-the-community' });
    await r.send({ trap: 'upsOnBattery', version: 'v3', user: { ...USER, authKey: 'wrong-auth-key-000' } });
    await r.send({ trap: 'upsOnBattery', version: 'v3', user: { ...USER, name: 'nobody' } });
    await until(() => r.handler.stats().discarded.auth === 4);
    assert.strictEqual(r.handler.stats().received, 0);
    assert.strictEqual(r.out.length, 0);
    assert.strictEqual(r.eng.openAlarms().length, 0);
  } finally { await r.listener.stop(); }
});

test('a credential valid for another device is not good enough', async () => {
  // 127.0.0.1 is a v2c device with community A; device B's community is also accepted by the receiver.
  const a = { ...UPS, snmp_version: 'v2c', snmp_community: 'community-a' };
  const b = { id: 42, name: 'UPS B', serial: 'B1', ip: '10.9.9.9', snmp_version: 'v2c', snmp_community: 'community-b' };
  const r = rig({ devices: [a, b] });
  try {
    await r.send({ trap: 'upsOnBattery', version: 'v2c', community: 'community-b' });
    await until(() => r.handler.stats().discarded.wrong_device_credential === 1);
    assert.strictEqual(r.out.length, 0);
    await r.send({ trap: 'upsOnBattery', version: 'v2c', community: 'community-a' });
    await until(() => r.out.length === 1);
    assert.strictEqual(r.out[0].event.code, 'UPS_ON_BATTERY');
  } finally { await r.listener.stop(); }
});

test('unknown sender: SNMP_TRAP_UNKNOWN recorded, no alarm, no event', async () => {
  const c = clock();
  const eng = createAlarmEngine({ ctx, now: c.now, log: quiet });
  const out = [];
  const h = createTrapHandler({ engine: eng, emit: async (i) => out.push(...i), now: c.now, log: quiet });
  h.setInventory([UPS]);
  const pdu = { type: 167, community: COMMUNITY, varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.4.1.318.0.5' }] };
  const res = await h.handle({ pdu, rinfo: { address: '10.200.0.99' } });
  assert.strictEqual(res.status, 'unknown_source');
  assert.strictEqual(h.stats().unknown_source, 1);
  assert.deepStrictEqual(h.recent()[0], { at: '2026-10-26T16:00:00.000Z', kind: 'unknown_source', source: '10.200.0.99',
    trap_oid: '1.3.6.1.4.1.318.0.5', version: 'v2c' });
  assert.strictEqual(out.length, 0);
  assert.strictEqual(eng.openAlarms().length, 0);
  // SNMP_TRAP_UNKNOWN is not an appendix-B code, so it can never become an event.
  assert.strictEqual(codes.severityOf('SNMP_TRAP_UNKNOWN'), null);
});

test('communicationLost: UPS_COMM_LOST only after 30 minutes (appendix B), cleared by communicationEstablished', async () => {
  const c = clock();
  const eng = createAlarmEngine({ ctx, now: c.now, log: quiet });
  const out = [];
  const h = createTrapHandler({ engine: eng, emit: async (i) => out.push(...i), now: c.now, log: quiet });
  h.setInventory([UPS]);
  const trap = (n) => h.handle({ pdu: { type: 167, community: COMMUNITY,
    varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', value: `1.3.6.1.4.1.318.0.${n}` }] }, rinfo: { address: UPS.ip } });
  assert.strictEqual((await trap(1)).status, 'held');
  c.advance(29 * MIN); await h.tick();
  assert.strictEqual(out.length, 0);
  c.advance(1 * MIN); await h.tick();
  assert.deepStrictEqual(out.map(i => `${i.event.kind} ${i.event.code} ${i.event.severity}`), ['alarm_raise UPS_COMM_LOST P3']);
  assert.strictEqual(out[0].event.detail.down_min, 30);
  await trap(8);
  assert.strictEqual(out[1].event.kind, 'alarm_clear');
  assert.strictEqual(out[1].event.alarm_id, out[0].event.alarm_id);
  validAll(out);
});

test('trap-only alarms are latched: a poll cycle does not clear UPS_SELFTEST_FAIL, its clear trap does', async () => {
  const c = clock();
  const eng = createAlarmEngine({ ctx, now: c.now, log: quiet });
  const out = [];
  const h = createTrapHandler({ engine: eng, emit: async (i) => out.push(...i), now: c.now, log: quiet });
  h.setInventory([UPS]);
  const trap = (n) => h.handle({ pdu: { type: 167, community: COMMUNITY,
    varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', value: `1.3.6.1.4.1.318.0.${n}` }] }, rinfo: { address: UPS.ip } });
  await trap(3);   // upsDiagnosticsFailed
  await trap(5);   // upsOnBattery — the poller sees this one too, so the poll judges it
  for (let i = 0; i < 3; i++) { c.advance(MIN); out.push(...eng.beginCycle(UPS, c.now())); }
  assert.deepStrictEqual(out.map(i => `${i.event.kind} ${i.event.code}`),
    ['alarm_raise UPS_SELFTEST_FAIL', 'alarm_raise UPS_ON_BATTERY', 'alarm_clear UPS_ON_BATTERY']);
  await trap(10);  // upsDiagnosticsPassed
  assert.strictEqual(out.at(-1).event.kind, 'alarm_clear');
  assert.strictEqual(out.at(-1).event.code, 'UPS_SELFTEST_FAIL');
});

/** A forwarder whose console (its only destination, D-13) is a stub that records every event body. */
function forwarder(c) {
  const posted = [];
  const request = async ({ url, body }) => {
    if (url.endsWith('/collector/v1/events')) posted.push(...JSON.parse(body).events);
    return { status: 200, headers: {}, json: { accepted: 1, local_notified: {} } };
  };
  const link = createConsoleClient({ url: 'https://app01.test', nodeId: 'cap01', key: 'k', queue: memQueue(), request, now: c.now, random: () => 0.5, log: quiet });
  const f = createForwarder({ node: { tenant: 'HAEA', nodeId: 'cap01', siteId: 'HMA-FV' }, console: link, now: c.now, log: quiet, version: '0.1.0' });
  return { f, posted };
}

test('poll and trap see the same fault: one alarm, one alarm_id, one raise to the FMS (poll first)', async () => {
  const c = clock();
  const { f, posted } = forwarder(c);
  await f.syncInventory([UPS]);
  const r = rig({ engine: f.alarms, emit: (items) => f.emitAlarms(items) });
  try {
    // The poller sees on-battery first...
    await f.sendEvent('alert', { device_id: 41, metric: 'output_source', value: 'onBattery', severity: 'P2', message: 'Output source: onBattery', ts: c.now() });
    // ...then the NMC's trap for the same fault arrives.
    await r.send({ trap: 'upsOnBattery', version: 'v2c' });
    await until(() => r.handler.stats().received === 1);
    assert.strictEqual(r.handler.stats().duplicates, 1);
    const raises = posted.filter(e => e.kind === 'alarm_raise' && e.code === 'UPS_ON_BATTERY');
    assert.strictEqual(raises.length, 1);
    assert.strictEqual(f.alarms.openAlarms().length, 1);
    // The trap's clear closes the poll's alarm.
    await r.send({ trap: 'powerRestored', version: 'v2c' });
    await until(() => posted.some(e => e.kind === 'alarm_clear'));
    const clr = posted.find(e => e.kind === 'alarm_clear');
    assert.strictEqual(clr.alarm_id, raises[0].alarm_id);
    assert.strictEqual(clr.source, 'trap');
  } finally { await r.listener.stop(); }
});

test('poll and trap see the same fault: one alarm_id (trap first, the poll confirms it)', async () => {
  const c = clock();
  const { f, posted } = forwarder(c);
  await f.syncInventory([UPS]);
  const r = rig({ engine: f.alarms, emit: (items) => f.emitAlarms(items) });
  try {
    await r.send({ trap: 'lowBattery', version: 'v3' });
    await until(() => posted.length === 1);
    c.advance(MIN);
    await f.sendEvent('alert', { device_id: 41, metric: 'battery_pct', value: 20, threshold: 30, severity: 'P1', message: 'low', ts: c.now() });
    assert.strictEqual(posted.length, 1, 'the poll adds no second raise');
    assert.strictEqual(f.alarms.openAlarms().length, 1);
    assert.strictEqual(f.alarms.openAlarms()[0].alarm_id, posted[0].alarm_id);
    assert.strictEqual(posted[0].code, 'UPS_LOW_BATTERY');
  } finally { await r.listener.stop(); }
});

test('maintenance window: a trap alarm goes to the Portal marked, and is suppressed locally', async () => {
  const c = clock();
  const eng = createAlarmEngine({ ctx, now: c.now, log: quiet,
    maintenance: [{ device_id: null, until: c.now() + 60 * MIN }] });
  const out = [];
  const h = createTrapHandler({ engine: eng, emit: async (i) => out.push(...i), now: c.now, log: quiet });
  h.setInventory([UPS]);
  await h.handle({ pdu: { type: 164, community: COMMUNITY, enterprise: '1.3.6.1.4.1.318', generic: 6, specific: 5, varbinds: [] },
    rinfo: { address: UPS.ip } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].suppressed, 'maintenance');
  assert.strictEqual(out[0].event.detail.maintenance, true);
});
