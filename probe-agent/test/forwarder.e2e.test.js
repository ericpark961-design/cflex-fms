// node --test probe-agent/test/forwarder.e2e.test.js
//
// The forwarder against a local mock Portal over real TLS: mTLS with a
// throwaway CA, through a CONNECT proxy with credentials, and the retry rules
// of contract §1. No network beyond 127.0.0.1, no real certificate.
const test = require('node:test');
const assert = require('node:assert');
const { createForwarder } = require('../src/forwarder');
const transport = require('../src/portal/transport');
const schema = require('../src/contract/schema');
const { startMockPortal } = require('./support/mock-portal');
const { startProxy } = require('./support/proxy');
const { memQueue } = require('./support/memqueue');
const { makeCerts, hasOpenssl } = require('./support/certs');

const skip = hasOpenssl() ? false : 'openssl CLI not available';
const quiet = { log() {}, warn() {}, error() {} };

let certs, portal, proxy;
test.before(async () => {
  if (skip) return;
  certs = makeCerts();
  portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  proxy = await startProxy();
});
test.after(async () => {
  if (skip) return;
  await portal.close(); await proxy.close(); certs.cleanup();
});
test.beforeEach(() => {
  if (skip) return;
  Object.assign(portal.state, { received: [], requests: [], faults: [], legacy: [], dateOffsetMs: 0 });
  portal.state.idem.clear();
  proxy.state.tunnels.length = 0; proxy.state.refused = 0;
});

function fwd(over = {}) {
  // A hand-driven clock, started at the real time so the Portal's Date header
  // does not look like drift.
  let t = Date.now();
  const clock = over.clock || { now: () => t, advance: (ms) => { t += ms; } };
  const queue = over.queue || memQueue();
  const f = createForwarder({
    portal: {
      enabled: true, url: portal.url, tenant: 'TEST', nodeId: 'cap01', role: 'collector', siteId: 'HAEA-HQ',
      tls: transport.loadTls(over.tls || certs.client), proxy: over.proxy || '', timeoutMs: 5000,
      ...(over.portal || {}),
    },
    legacy: over.legacy,
    queue, now: over.realClock ? Date.now : clock.now, random: () => 0.5, log: quiet, version: '2.1.0',
  });
  return { f, queue, clock };
}

const UPS = { id: 41, name: 'MPOE UPS 1E-A', site_id: 'HMA-FV', serial: 'AD2248220154', vendor: 'APC', model: 'SYAF16KRMT', ip: '10.112.5.34', kind: 'ups' };

test('E2E: inventory → telemetry → event → heartbeat, over mTLS, every body schema-valid', { skip }, async () => {
  const { f, queue } = fwd({ realClock: true });
  await f.syncInventory([UPS]);
  await f.sendEvent('telemetry', { device_id: 41, kind: 'ups', ts: Date.now(), ok: true, took_ms: 700,
    metrics: { battery_pct: 62, load_pct: 37, temp_c: 22, runtime_min: 7, output_source: 'onBattery', battery_status: 'normal' } });
  await f.sendEvent('alert', { device_id: 41, severity: 'P1', metric: 'output_source', value: 'onBattery', message: 'Output source: onBattery', ts: Date.now() });
  f.flushTelemetry();
  await f.flush();
  const hb = await f.heartbeat({ devices_total: 1, devices_unreachable: 0, last_poll_ok_ratio: 1 });

  assert.ok(hb.ok, JSON.stringify(hb));
  assert.strictEqual(queue.rows.length, 0, 'queue drained');
  const inv = portal.of('PUT /api/v1/inventory');
  const tel = portal.of('POST /api/v1/telemetry');
  const ev = portal.of('POST /api/v1/events');
  const beats = portal.of('POST /api/v1/heartbeat');
  assert.strictEqual(inv.length, 1); assert.strictEqual(tel.length, 1); assert.strictEqual(ev.length, 1); assert.strictEqual(beats.length, 1);

  // One device, one ID, across all three feeds.
  const id = inv[0].devices[0].device_id;
  assert.strictEqual(tel[0].points[0].device_id, id);
  assert.strictEqual(ev[0].events[0].device_id, id);
  assert.strictEqual(ev[0].events[0].code, 'UPS_ON_BATTERY');
  assert.strictEqual(tel[0].points[0].m.status, 'on_battery');
  assert.strictEqual(beats[0].queue_depth, 0);

  for (const r of portal.state.received) {
    const name = r.route.split('/').pop();
    assert.ok(schema.validate(name, r.body).ok, r.route);
    assert.strictEqual(r.headers['x-cflex-tenant'], 'TEST');
    assert.strictEqual(r.headers['x-cflex-node'], 'cap01');
    assert.match(r.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  }
  assert.ok(portal.state.requests.every(r => r.peerCN === 'TEST.cap01'), 'client cert presented');
  assert.strictEqual(portal.state.legacy.length, 0, 'old /v1/probe/* path not used by default');
  assert.strictEqual(f.stats().invalid, 0);
});

test('mTLS: no client certificate, or one from another CA, is refused at the handshake', { skip }, async () => {
  for (const tls of [{ caPath: certs.client.caPath }, certs.rogue]) {
    const { f, queue } = fwd({ tls });
    const r = await f.heartbeat({});
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, 'a TLS error, not an HTTP answer');
    await f.postEvents([{ event_id: crypto.randomUUID(), alarm_id: crypto.randomUUID(), device_id: null, site_id: 'HAEA-HQ',
      ts: new Date().toISOString(), kind: 'info', severity: 'P4', code: 'CLOCK_DRIFT', title: 't', source: 'system' }]);
    assert.strictEqual(queue.rows.length, 1, 'kept for retry');
  }
  assert.strictEqual(portal.state.received.length, 0);
});

test('proxy: HTTPS_PROXY with Basic credentials tunnels to the Portal; wrong credentials fail without sending', { skip }, async () => {
  const good = fwd({ proxy: proxy.url() });
  const r = await good.f.heartbeat({});
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(proxy.state.tunnels, [`localhost:${portal.port}`]);
  assert.strictEqual(portal.of('POST /api/v1/heartbeat').length, 1);
  // The tunnel is closed after the response — one leaked socket per request
  // would exhaust a proxy within the hour.
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(proxy.openSockets(), 0, 'tunnel closed');

  const bad = fwd({ proxy: proxy.url('probe', 'wrong') });
  const r2 = await bad.f.heartbeat({});
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /407/);
  assert.strictEqual(proxy.state.refused, 1);

  const bypass = fwd({ proxy: proxy.url('probe', 'wrong'), portal: { noProxy: 'localhost' } });
  assert.ok((await bypass.f.heartbeat({})).ok, 'NO_PROXY host goes direct');
});

test('retry: a 503 holds the queue and the retry carries the same Idempotency-Key; the Portal stores it once', { skip }, async () => {
  const { f, queue, clock } = fwd();
  portal.state.faults.push({ status: 503 });
  await f.syncInventory([UPS]);
  assert.strictEqual(queue.rows.length, 1);
  const first = portal.state.requests.at(-1).headers['idempotency-key'];

  // Backoff: 1 s ±20 % (jitter pinned to the middle here) — not before.
  assert.strictEqual((await f.flush()).sent, 0);
  clock.advance(1000);
  assert.strictEqual((await f.flush()).sent, 1);
  assert.strictEqual(portal.state.requests.at(-1).headers['idempotency-key'], first);

  // The response was lost after the Portal stored it: the same key again is answered from cache.
  const { request } = transport;
  const body = Buffer.from(JSON.stringify(portal.of('PUT /api/v1/inventory')[0]));
  const again = await request({ method: 'PUT', url: `${portal.url}/api/v1/inventory`, body, tls: transport.loadTls(certs.client),
    headers: { 'Content-Type': 'application/json', 'X-CFlex-Tenant': 'TEST', 'X-CFlex-Node': 'cap01', 'Idempotency-Key': first } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(portal.of('PUT /api/v1/inventory').length, 1, 'stored once');
});

test('retry: backoff doubles to a 5-minute ceiling', { skip }, async () => {
  const { f, clock } = fwd();
  for (let i = 0; i < 12; i++) portal.state.faults.push({ status: 500 });
  await f.syncInventory([UPS]);
  const waits = [];
  for (let i = 0; i < 11; i++) {
    const w = f.stats().next_attempt_at - clock.now();
    waits.push(w);
    clock.advance(w);
    await f.flush();
  }
  assert.deepStrictEqual(waits.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
  assert.strictEqual(Math.max(...waits), 300000);
});

test('429: waits out Retry-After, and a heartbeat does not cut the wait short', { skip }, async () => {
  const { f, queue, clock } = fwd();
  portal.state.faults.push({ status: 429, headers: { 'Retry-After': '30' } });
  await f.syncInventory([UPS]);
  assert.strictEqual(f.stats().next_attempt_at - clock.now(), 30000);
  await f.heartbeat({});
  assert.strictEqual(queue.rows.length, 1, 'still waiting');
  clock.advance(30000);
  await f.flush();
  assert.strictEqual(queue.rows.length, 0);
});

test('4xx other than 409/429 is not retried: dropped, counted, and the queue moves on', { skip }, async () => {
  const { f, queue } = fwd();
  portal.state.faults.push({ status: 400, body: { error: { code: 'bad', message: 'no' } } });
  await f.syncInventory([UPS]);
  assert.strictEqual(queue.rows.length, 0);
  assert.strictEqual(f.stats().rejected, 1);

  portal.state.faults.push({ status: 409 });
  await f.syncInventory([{ ...UPS, name: 'renamed' }]);
  assert.strictEqual(queue.rows.length, 1, '409 is retried');
});

test('outage: events queue in order and drain in order once the link is back', { skip }, async () => {
  const { f, queue, clock } = fwd();
  const ids = [];
  portal.state.faults.push({ status: 502 });
  for (let i = 0; i < 3; i++) {
    const r = await f.sendEvent('alert', { device_id: 41, severity: 'P2', metric: 'temp_c', value: 40 + i, threshold: 38, message: `warm ${i}`, ts: Date.now() });
    ids.push(r);
  }
  assert.strictEqual(queue.rows.length, 3);
  clock.advance(1000);
  await f.flush();
  const got = portal.of('POST /api/v1/events').map(b => b.events[0]);
  assert.deepStrictEqual(got.map(e => e.kind), ['alarm_raise', 'alarm_update', 'alarm_update']);
  assert.deepStrictEqual(got.map(e => e.detail.value), [40, 41, 42]);
});

test('clock: a Portal Date more than 60 s away raises CLOCK_DRIFT once, and clears it when back', { skip }, async () => {
  const { f } = fwd({ realClock: true });
  portal.state.dateOffsetMs = 120_000;
  await f.heartbeat({});
  await f.heartbeat({});
  portal.state.dateOffsetMs = 0;
  await f.heartbeat({});
  const ev = portal.of('POST /api/v1/events').map(b => b.events[0]);
  assert.deepStrictEqual(ev.map(e => [e.code, e.kind]), [['CLOCK_DRIFT', 'alarm_raise'], ['CLOCK_DRIFT', 'alarm_clear']]);
  assert.strictEqual(ev[0].alarm_id, ev[1].alarm_id);
});

test('telemetry is batched at 500 points', { skip }, async () => {
  const { f } = fwd({ realClock: true });
  for (let i = 0; i < 1001; i++) {
    await f.sendEvent('telemetry', { device_id: i, kind: 'ups', ts: Date.now(), ok: false, error: 'timeout', took_ms: 1 });
  }
  await f.flush();
  assert.deepStrictEqual(portal.of('POST /api/v1/telemetry').map(b => b.points.length), [500, 500]);
  f.flushTelemetry(); await f.flush();
  assert.deepStrictEqual(portal.of('POST /api/v1/telemetry').map(b => b.points.length), [500, 500, 1]);
});

test('legacy path: CFLEX_LEGACY_FORWARD keeps /v1/probe/event and /v1/probe/heartbeat working', { skip }, async () => {
  const { f, queue } = fwd({
    portal: { enabled: false },
    legacy: { enabled: true, url: portal.url, token: 'test-token', probeId: 'p1', tenantId: 'TEST' },
  });
  await f.sendEvent('alert', { device_id: 41, severity: 'P2', metric: 'temp_c', value: 40, message: 'warm' });
  await f.heartbeat({});
  assert.deepStrictEqual(portal.state.legacy.map(x => x.route), ['POST /v1/probe/event', 'POST /v1/probe/heartbeat']);
  assert.deepStrictEqual(JSON.parse(portal.state.legacy[0].raw).kind, 'alert');
  assert.strictEqual(portal.state.received.length, 0, 'contract path off when the Portal is disabled');
  assert.strictEqual(queue.rows.length, 0);

  // Rows buffered by the previous version ({kind} in the row, bare payload)
  // are old-cloud events: delivered on the legacy path, never to /api/v1.
  queue.enqueue('telemetry', { device_id: 41, ok: true });
  await f.flush();
  assert.strictEqual(portal.state.legacy.length, 3);
  assert.strictEqual(JSON.parse(portal.state.legacy[2].raw).kind, 'telemetry');
});

test('legacy rows left from the previous version are discarded, not sent to /api/v1, when legacy is off', { skip }, async () => {
  const { f, queue } = fwd();
  queue.enqueue('alert', { device_id: 41, severity: 'P2', message: 'old' });
  await f.flush();
  assert.strictEqual(queue.rows.length, 0);
  assert.strictEqual(portal.state.requests.length, 0);
  assert.strictEqual(portal.state.legacy.length, 0);
});
