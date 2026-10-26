// node --test probe-agent/test/console-link.test.js
//
// WO-INT-004c, the Collector side of the Local Console link without sockets:
// the console's device rows become what the pollers read, alarm events take
// the console's local_notified to the Portal, and an unreachable console
// costs neither the Portal its events nor the console its history.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createConsoleClient, pollerDevice } = require('../src/console/client');
const { createForwarder } = require('../src/forwarder');
const { DEFAULT_THRESHOLDS } = require('../src/pollers/thresholds');
const { memQueue } = require('./support/memqueue');

const quiet = { log() {}, warn() {}, error() {} };

test('pollerDevice: console rows → the poller fields (SNMP v2c/v3, thresholds console-wide then per device)', () => {
  const v2 = pollerDevice({ id: 7, device_id: 'abc', name: 'UPS-1', site_id: 'HMA-FV', ip: '10.0.0.5', vendor: 'APC', serial: 'AS1',
    snmp_version: '2c', snmp_community: 'ro', thresholds: { battery_pct: { critical: 25, warn: 50 } } },
  { thresholds: { battery_pct: { critical: 30, warn: 60 }, load_pct: { critical: 85, warn: 70 } } });
  assert.deepStrictEqual([v2.snmp_version, v2.snmp_community, v2.ip, v2.snmp_port], ['v2c', 'ro', '10.0.0.5', undefined]);
  assert.deepStrictEqual(v2.thresholds, { ...DEFAULT_THRESHOLDS, battery_critical_pct: 25, battery_warn_pct: 50, load_critical_pct: 85, load_warn_pct: 70 });
  const v3 = pollerDevice({ id: 8, snmp_version: '3', snmp_v3: { user: 'cflexro', auth_proto: 'SHA', auth_key: 'a', priv_proto: 'AES', priv_key: 'p' }, thresholds: null }, { snmpPort: 16161 });
  assert.deepStrictEqual([v3.snmp_version, v3.snmp_v3_user, v3.snmp_v3_auth_protocol, v3.snmp_v3_auth_password, v3.snmp_v3_priv_protocol, v3.snmp_v3_priv_password, v3.snmp_port],
    ['v3', 'cflexro', 'SHA', 'a', 'AES', 'p', 16161]);
  assert.deepStrictEqual(v3.thresholds, DEFAULT_THRESHOLDS, 'no override: the poller defaults, never null');
});

/** A console that can be taken down; records what it was sent. */
function fakeConsole() {
  const st = { up: true, calls: [], ln: { email: true, teams: false, itsm: 'INC0012001' } };
  st.request = async ({ method, url, headers, body, proxy, tls }) => {
    const b = body ? JSON.parse(body) : null;
    st.calls.push({ method, path: new URL(url).pathname, headers, body: b, proxy, tls });
    if (!st.up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (url.endsWith('/collector/v1/events')) {
      const replay = headers['X-CFlex-Replay'] === '1';
      return { status: 200, headers: {}, json: { accepted: b.events.length, duplicate: 0, local_notified: replay ? {} : Object.fromEntries(b.events.map(e => [e.event_id, st.ln])) } };
    }
    return { status: 200, headers: {}, json: { ok: true } };
  };
  return st;
}

function rig() {
  const con = fakeConsole();
  const portalSent = [];
  const portalReq = async ({ url, body }) => { portalSent.push({ path: new URL(url).pathname, body: JSON.parse(body) }); return { status: 200, headers: {}, json: { accepted: 1 } }; };
  let t = Date.parse('2026-10-26T10:00:00Z');
  const now = () => t;
  const cq = memQueue();
  const link = createConsoleClient({ url: 'https://console.haea.example/', nodeId: 'cap01', key: 'k3y', queue: cq, request: con.request, now, random: () => 0.5, log: quiet, tls: { ca: ['CA'] } });
  const fwd = createForwarder({
    portal: { enabled: true, url: 'https://portal.example', tenant: 'TEST', nodeId: 'cap01', siteId: 'HMA-FV', tls: {} },
    queue: memQueue(), request: portalReq, now, log: quiet, console: link,
  });
  return { con, link, fwd, cq, portalSent, tick: (ms) => { t += ms; } };
}

const ups = { id: 1, name: 'HMA-UPS-1W-B', site_id: 'HMA-FV', serial: 'AS2535281781', kind: 'ups' };
const onBattery = { device_id: 1, metric: 'output_source', value: 'onBattery', severity: 'P2', message: 'Output source: onBattery' };

test('event push: the console answers local_notified and the Portal event carries it; the key and the CA are the console\'s, no proxy', async () => {
  const { con, fwd, portalSent } = rig();
  await fwd.syncInventory([ups]);
  await fwd.sendEvent('alert', { ...onBattery, ts: Date.parse('2026-10-26T10:00:00Z') });
  const sentEvents = con.calls.filter(c => c.path === '/collector/v1/events');
  assert.strictEqual(sentEvents.length, 1);
  assert.deepStrictEqual([sentEvents[0].headers.Authorization, sentEvents[0].headers['X-CFlex-Node'], sentEvents[0].proxy, sentEvents[0].tls.ca],
    ['Bearer k3y', 'cap01', null, ['CA']]);
  assert.strictEqual(sentEvents[0].headers['X-CFlex-Replay'], undefined, 'live, not a replay');
  const ev = portalSent.find(p => p.path === '/api/v1/events').body.events[0];
  assert.strictEqual(ev.code, 'UPS_ON_BATTERY');
  assert.deepStrictEqual(ev.local_notified, { email: true, teams: false, itsm: 'INC0012001' });
});

test('console down: the Portal still gets the event now (without local_notified); the console gets it later, marked as a replay, in order', async () => {
  const { con, fwd, link, cq, portalSent, tick } = rig();
  await fwd.syncInventory([ups]);
  con.up = false;
  await fwd.sendEvent('alert', { ...onBattery, ts: Date.parse('2026-10-26T10:00:00Z') });
  const raise = portalSent.find(p => p.path === '/api/v1/events').body.events[0];
  assert.strictEqual(raise.kind, 'alarm_raise');
  assert.strictEqual(raise.local_notified, undefined, 'not notified locally — the Portal routes it itself');
  assert.strictEqual(cq.rows.length, 1, 'queued for the console');

  // While it is down (and backing off), telemetry and a second event wait behind the first, without a call.
  const calls = con.calls.length;
  fwd.sendEvent('telemetry', { device_id: 1, kind: 'ups', ts: Date.parse('2026-10-26T10:00:30Z'), ok: true, metrics: { battery_pct: 99 } });
  fwd.flushTelemetry();
  const second = { event_id: crypto.randomUUID(), kind: 'info' };
  assert.strictEqual(await link.events([second]), null);
  assert.strictEqual(con.calls.length, calls, 'in backoff: no hammering of a console that is down');
  assert.strictEqual(cq.rows.length, 3);

  con.up = true;
  tick(5000);
  const r = await fwd.drain();
  assert.strictEqual(cq.rows.length, 0);
  assert.strictEqual(r.console.sent, 3, JSON.stringify(r));
  const delivered = con.calls.slice(calls);
  assert.deepStrictEqual(delivered.map(c => c.path), ['/collector/v1/events', '/collector/v1/telemetry', '/collector/v1/events'], 'in the order they happened');
  assert.strictEqual(delivered[0].headers['X-CFlex-Replay'], '1');
  assert.strictEqual(delivered[0].body.events[0].event_id, raise.event_id, 'the same event, so the console stores it once');
  assert.strictEqual(delivered[2].body.events[0].event_id, second.event_id);
});

test('console rejects a payload (4xx): dropped, not queued or retried forever', async () => {
  const cq = memQueue();
  const link = createConsoleClient({ url: 'https://c', nodeId: 'cap01', key: 'k', queue: cq, log: quiet,
    request: async () => ({ status: 400, headers: {}, json: { error: 'invalid_payload' } }) });
  assert.strictEqual(await link.events([{ event_id: crypto.randomUUID() }]), null);
  assert.strictEqual(cq.rows.length, 0);
  assert.strictEqual(link.stats().rejected, 1);
});

test('inventory: config then devices; maintenance windows and thresholds come along; unreachable → null (keep the old list)', async () => {
  const calls = [];
  const request = async ({ url }) => {
    const p = new URL(url).pathname;
    calls.push(p);
    if (p === '/collector/v1/config') return { status: 200, headers: {}, json: { ok: true, thresholds: { temp_c: { critical: 40, warn: 35 } }, maintenance: [{ device_id: 'x', until: '2026-10-26T12:00:00Z' }] } };
    return { status: 200, headers: {}, json: { ok: true, devices: [{ id: 3, device_id: 'x', name: 'U3', snmp_version: '2c', snmp_community: 'c' }] } };
  };
  const link = createConsoleClient({ url: 'https://c', nodeId: 'cap01', key: 'k', queue: memQueue(), request, log: quiet });
  const inv = await link.inventory();
  assert.deepStrictEqual(calls, ['/collector/v1/config', '/collector/v1/devices']);
  assert.strictEqual(inv.devices[0].thresholds.temp_critical_c, 40);
  assert.strictEqual(inv.maintenance.length, 1);
  const down = createConsoleClient({ url: 'https://c', nodeId: 'cap01', key: 'k', queue: memQueue(), request: async () => { throw new Error('ECONNREFUSED'); }, log: quiet });
  assert.strictEqual(await down.inventory(), null);
});
