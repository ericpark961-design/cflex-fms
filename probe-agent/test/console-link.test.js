// node --test probe-agent/test/console-link.test.js
//
// WO-INT-004c / WO-INT-012, the Collector side of the Local Console link
// without sockets: the console's device rows become what the pollers read,
// the collector asks only for its own sites, alarm events and telemetry go to
// the console — the collector's only destination (D-13) — and an unreachable
// console costs it no history: queued, then re-sent in order.
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
  let t = Date.parse('2026-10-26T10:00:00Z');
  const now = () => t;
  const cq = memQueue();
  const link = createConsoleClient({ url: 'https://console.haea.example/', nodeId: 'cap01', key: 'k3y', queue: cq, request: con.request, now, random: () => 0.5, log: quiet, tls: { ca: ['CA'] } });
  const fwd = createForwarder({ node: { tenant: 'TEST', nodeId: 'cap01', siteId: 'HMA-FV' }, now, log: quiet, console: link });
  return { con, link, fwd, cq, tick: (ms) => { t += ms; } };
}

const ups = { id: 1, name: 'HMA-UPS-1W-B', site_id: 'HMA-FV', serial: 'AS2535281781', kind: 'ups' };
const onBattery = { device_id: 1, metric: 'output_source', value: 'onBattery', severity: 'P2', message: 'Output source: onBattery' };

test('event push: to the console only — the key and the CA are the console\'s, no proxy, no client certificate', async () => {
  const { con, fwd } = rig();
  await fwd.syncInventory([ups]);
  await fwd.sendEvent('alert', { ...onBattery, ts: Date.parse('2026-10-26T10:00:00Z') });
  const sentEvents = con.calls.filter(c => c.path === '/collector/v1/events');
  assert.strictEqual(sentEvents.length, 1);
  assert.deepStrictEqual([sentEvents[0].headers.Authorization, sentEvents[0].headers['X-CFlex-Node'], sentEvents[0].proxy, sentEvents[0].tls.ca],
    ['Bearer k3y', 'cap01', null, ['CA']]);
  assert.strictEqual(sentEvents[0].headers['X-CFlex-Replay'], undefined, 'live, not a replay');
  assert.deepStrictEqual(Object.keys(sentEvents[0].tls), ['ca'], 'no client certificate on the console link');
  const ev = sentEvents[0].body.events[0];
  assert.strictEqual(ev.code, 'UPS_ON_BATTERY');
  assert.ok(!('local_notified' in ev), 'the console notifies; the collector reports what it saw');
  assert.ok(con.calls.every(c => c.path.startsWith('/collector/v1/')), 'nothing but the console API');
});

test('console down: the event waits in the collector\'s queue and reaches the console later, marked as a replay, in order', async () => {
  const { con, fwd, link, cq, tick } = rig();
  await fwd.syncInventory([ups]);
  con.up = false;
  await fwd.sendEvent('alert', { ...onBattery, ts: Date.parse('2026-10-26T10:00:00Z') });
  assert.strictEqual(cq.rows.length, 1, 'queued for the console');
  const raise = JSON.parse(cq.rows[0].payload).body.events[0];
  assert.strictEqual(raise.kind, 'alarm_raise');

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

test('two app nodes (SAT 6): app01 unreachable → the same call goes to app02, and stays there; an HTTP error does not switch', async () => {
  const hits = [];
  let app01Up = false;
  const request = async ({ url }) => {
    const u = new URL(url);
    hits.push(u.host);
    if (u.host === 'app01.haea' && !app01Up) throw Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
    if (u.pathname === '/collector/v1/heartbeat' && u.host === 'app02.haea') return { status: 503, headers: {}, json: { error: 'session_store_unavailable' } };
    return { status: 200, headers: {}, json: { ok: true, local_notified: {} } };
  };
  const link = createConsoleClient({ url: 'https://app01.haea, https://app02.haea/', nodeId: 'cap01', key: 'k', queue: memQueue(), request, log: quiet });
  assert.deepStrictEqual(await link.events([{ event_id: crypto.randomUUID() }]), {});
  assert.deepStrictEqual(hits, ['app01.haea', 'app02.haea']);
  assert.strictEqual(link.stats().url, 'https://app02.haea');
  assert.strictEqual(link.stats().failovers, 1);
  app01Up = true;
  hits.length = 0;
  assert.deepStrictEqual(await link.heartbeat({}), { ok: false, error: 'POST /collector/v1/heartbeat → HTTP 503 session_store_unavailable' });
  assert.deepStrictEqual(hits, ['app02.haea'], 'an answer, even an error, is not a reason to switch');
});

test('site scope (D-13): a collector with CFLEX_COLLECTOR_SITES asks for those sites only; without, for every site', async () => {
  const urls = [];
  const request = async ({ url }) => { urls.push(url); return { status: 200, headers: {}, json: { ok: true, devices: [] } }; };
  await createConsoleClient({ url: 'https://c', nodeId: 'cap02', key: 'k', queue: memQueue(), request, log: quiet, sites: ['HMA-FV', 'KUS-IRV'] }).inventory();
  await createConsoleClient({ url: 'https://c', nodeId: 'cap01', key: 'k', queue: memQueue(), request, log: quiet }).inventory();
  assert.deepStrictEqual(urls.filter(u => u.includes('/devices')), ['https://c/collector/v1/devices?sites=HMA-FV%2CKUS-IRV', 'https://c/collector/v1/devices']);
});

test('heartbeat: to the console, with the contract fields and the site scope', async () => {
  const { con, fwd } = rig();
  const r = await fwd.heartbeat({ devices_total: 2, devices_unreachable: 0, last_poll_ok_ratio: 1 });
  assert.ok(r.ok);
  const hb = con.calls.find(c => c.path === '/collector/v1/heartbeat').body;
  assert.deepStrictEqual([hb.node_id, hb.role, hb.devices_total, hb.last_poll_ok_ratio, hb.sites], ['cap01', 'collector', 2, 1, null]);
  assert.ok(!('portal' in hb), 'a collector has no Portal link to report');
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
