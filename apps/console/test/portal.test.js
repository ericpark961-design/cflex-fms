// node --test apps/console/test/portal.test.js
//
// WO-INT-012 (D-13): the Portal sender on the FMS (src/portal.js) against the
// mTLS mock Portal, over real TLS, with the outbox in a real PostgreSQL 16
// (embedded-postgres). The rules are the ones the Collector's forwarder had
// (contract §1) — these are its tests, moved with it:
//
//   · inventory (from the devices table), telemetry and events (from what
//     collectors posted, via ingest.js) and the heartbeat, every body schema-valid,
//     node_id = app01 (header + certificate CN), collector_id on points and events
//   · mTLS refused without the right certificate; HTTPS_PROXY with Basic; NO_PROXY
//   · retry with the same Idempotency-Key, backoff to 5 min, 429 Retry-After,
//     4xx dropped (409 retried), order kept through an outage, 7-day purge
//   · replaced_by once, CLOCK_DRIFT raise/clear
//   · new here: one sender (advisory lock) of two app nodes, collector heartbeats
//     relayed, events held for local_notified, and the cross-collector merge
//     (one alarm_id; cleared by the last collector)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const dbmod = require('../src/db');
const { createPortalLink } = require('../src/portal');
const { createIngest } = require('../src/ingest');
const { createSettings } = require('../src/settings');
const { createSealer } = require('../src/seal');
const transport = require('../../../probe-agent/src/net/transport');
const schema = require('../../../probe-agent/src/contract/schema');
const { startMockPortal } = require('../../../probe-agent/test/support/mock-portal');
const { startProxy } = require('../../../probe-agent/test/support/proxy');
const { makeCerts, hasOpenssl } = require('../../../probe-agent/test/support/certs');
const pgt = require('./support/pg');

const skip = pgt.unavailable || (hasOpenssl() ? false : 'openssl CLI not available');
const T = (name, f) => test(name, { skip }, f);
const quiet = { log() {}, warn() {}, error() {} };

let pg, certs, portal, proxy, n = 0;
const open = [];
test.before(async () => {
  if (skip) return;
  pg = await pgt.start({ database: 'base' });
  certs = makeCerts({ clients: ['app02'] });
  portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  proxy = await startProxy();
});
test.after(async () => {
  if (skip) return;
  for (const x of open) await x();
  await portal.close(); await proxy.close(); certs.cleanup();
  await pg.stop();
});
test.beforeEach(() => {
  if (skip) return;
  Object.assign(portal.state, { received: [], requests: [], faults: [], legacy: [], dateOffsetMs: 0 });
  portal.state.idem.clear();
  proxy.state.tunnels.length = 0; proxy.state.refused = 0;
});

const UUID = () => crypto.randomUUID();
const iso = (ms) => new Date(ms).toISOString();

/** A fresh database, its devices, and a Portal link on it (a hand-driven clock unless realClock). */
async function rig(over = {}) {
  const conn = pg.conn();
  conn.url = await pg.createDatabase(`portal_${++n}`);
  const db = over.db || await dbmod.open(conn, { partitions: false });
  if (!over.db) open.push(() => db.close());
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const now = over.realClock ? Date.now : clock.now;
  const link = (node = 'app01', tls = certs.client, p = {}) => {
    const l = createPortalLink({
      db, now, random: () => 0.5, log: quiet, version: '2.1.0',
      config: { nodeId: node, tenant: 'TEST', defaultSite: 'HAEA-HQ',
        portal: { enabled: true, url: portal.url, nodeId: node, tls, proxy: null, noProxy: null, timeoutMs: 5000, bufferDays: 7, ...p } },
    });
    open.unshift(() => l.resign());
    return l;
  };
  const p = link(over.node, over.tls, over.portal);
  const settings = createSettings(db, { sealer: createSealer(null), tenant: 'TEST', now });
  const ingest = createIngest(db, { now, portal: p });
  return { db, p, link, settings, ingest, clock, now };
}

async function withUps(r, over = {}) {
  await r.settings.putSite('HMA-FV', { name: 'HMA Fountain Valley' });
  const { device } = await r.settings.saveDevice({ site_id: 'HMA-FV', label: 'MPOE UPS 1E-A', vendor: 'APC', model: 'SYAF16KRMT',
    serial: 'AD2248220154', nmc_ip: '10.112.5.34', ...over });
  return device;
}

const event = (dev, over = {}) => ({ event_id: UUID(), alarm_id: UUID(), device_id: dev.device_id, site_id: 'HMA-FV', ts: iso(Date.now()),
  kind: 'alarm_raise', severity: 'P1', code: 'UPS_ON_BATTERY', title: 'Output source: onBattery', detail: {}, source: 'rule', ...over });

/** What a collector's POST /collector/v1/events does on the FMS: store, (notify), release to the Portal. */
async function collectorEvents(r, collector, events, ln = {}) {
  const res = await r.ingest.events({ events }, collector);
  await r.p.releaseEvents(res.outbox, ln);
  await r.p.flush();
  return res;
}

const outbox = async (db) => (await db.one('SELECT COUNT(*) AS n FROM portal_outbox')).n;

T('E2E: inventory → telemetry → event → heartbeat over mTLS as app01, with collector_id, every body schema-valid', async () => {
  const r = await rig({ realClock: true });
  const dev = await withUps(r);
  await r.p.syncInventory();
  await r.ingest.telemetry({ node_id: 'cap01', points: [{ device_id: dev.device_id, ts: iso(Date.now()), m: { bat_pct: 62, load_pct: 37, status: 'on_battery', comm_ok: true } }] }, 'cap01');
  await collectorEvents(r, 'cap01', [event(dev)], {});
  const hb = await r.p.heartbeat();

  assert.ok(hb.ok, JSON.stringify(hb));
  assert.strictEqual(await outbox(r.db), 0, 'outbox drained');
  const inv = portal.of('PUT /api/v1/inventory');
  const tel = portal.of('POST /api/v1/telemetry');
  const ev = portal.of('POST /api/v1/events');
  const beats = portal.of('POST /api/v1/heartbeat');
  assert.deepStrictEqual([inv.length, tel.length, ev.length, beats.length], [1, 1, 1, 1]);

  // One device, one ID, across the three feeds — the FMS's devices table.
  assert.strictEqual(inv[0].devices[0].device_id, dev.device_id);
  assert.deepStrictEqual(inv[0].devices[0], { device_id: dev.device_id, site_id: 'HMA-FV', label: 'MPOE UPS 1E-A', vendor: 'APC', model: 'SYAF16KRMT',
    serial: 'AD2248220154', nmc_ip: '10.112.5.34', tags: ['ups'] });
  assert.deepStrictEqual([tel[0].node_id, tel[0].points[0].device_id, tel[0].points[0].collector_id], ['app01', dev.device_id, 'cap01']);
  assert.deepStrictEqual([ev[0].events[0].device_id, ev[0].events[0].code, ev[0].events[0].collector_id], [dev.device_id, 'UPS_ON_BATTERY', 'cap01']);
  assert.deepStrictEqual([beats[0].node_id, beats[0].role, beats[0].queue_depth, beats[0].devices_total, 'collector_id' in beats[0]], ['app01', 'app', 0, 1, false]);

  for (const x of portal.state.received) {
    assert.ok(schema.validate(x.route.split('/').pop(), x.body).ok, x.route);
    assert.strictEqual(x.headers['x-cflex-tenant'], 'TEST');
    assert.strictEqual(x.headers['x-cflex-node'], 'app01');
    assert.strictEqual(x.headers['x-cflex-api-version'], '1.2');
    assert.match(x.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  }
  assert.ok(portal.state.requests.every(q => q.peerCN === 'TEST.app01'), 'the app node presents its own certificate');
  assert.strictEqual(r.p.stats().invalid, 0);
});

T('mTLS: no client certificate, or one from another CA, is refused at the handshake; the event stays in the outbox', async () => {
  for (const tls of [{ caPath: certs.client.caPath }, certs.rogue]) {
    const r = await rig({ tls });
    const h = await r.p.heartbeat();
    assert.strictEqual(h.ok, false);
    assert.ok(h.error, 'a TLS error, not an HTTP answer');
    await r.p.postEvents([{ event_id: UUID(), alarm_id: UUID(), device_id: null, site_id: 'HAEA-HQ', ts: iso(Date.now()),
      kind: 'info', severity: 'P4', code: 'CLOCK_DRIFT', title: 't', source: 'system' }]);
    assert.strictEqual(await outbox(r.db), 1, 'kept for retry');
  }
  assert.strictEqual(portal.state.received.length, 0);
});

T('proxy: HTTPS_PROXY with Basic credentials tunnels to the Portal; wrong credentials fail without sending; NO_PROXY goes direct', async () => {
  const good = await rig({ portal: { proxy: proxy.url() } });
  const h = await good.p.heartbeat();
  assert.ok(h.ok, JSON.stringify(h));
  assert.deepStrictEqual(proxy.state.tunnels, [`localhost:${portal.port}`]);
  await new Promise(res => setTimeout(res, 50));
  assert.strictEqual(proxy.openSockets(), 0, 'tunnel closed');

  const bad = await rig({ portal: { proxy: proxy.url('probe', 'wrong') } });
  const h2 = await bad.p.heartbeat();
  assert.strictEqual(h2.ok, false);
  assert.match(h2.error, /407/);
  assert.strictEqual(proxy.state.refused, 1);

  const bypass = await rig({ portal: { proxy: proxy.url('probe', 'wrong'), noProxy: 'localhost' } });
  assert.ok((await bypass.p.heartbeat()).ok, 'NO_PROXY host goes direct');
});

T('retry: a 503 holds the outbox and the retry carries the same Idempotency-Key; the Portal stores it once', async () => {
  const r = await rig();
  await withUps(r);
  portal.state.faults.push({ status: 503 });
  await r.p.syncInventory();
  assert.strictEqual(await outbox(r.db), 1);
  const first = portal.state.requests.at(-1).headers['idempotency-key'];

  assert.strictEqual((await r.p.flush()).sent, 0, 'backoff: 1 s ±20 % (jitter pinned to the middle)');
  r.clock.advance(1000);
  assert.strictEqual((await r.p.flush()).sent, 1);
  assert.strictEqual(portal.state.requests.at(-1).headers['idempotency-key'], first);

  // The response was lost after the Portal stored it: the same key again is answered from cache.
  const body = Buffer.from(JSON.stringify(portal.of('PUT /api/v1/inventory')[0]));
  const again = await transport.request({ method: 'PUT', url: `${portal.url}/api/v1/inventory`, body, tls: transport.loadTls(certs.client),
    headers: { 'Content-Type': 'application/json', 'X-CFlex-Tenant': 'TEST', 'X-CFlex-Node': 'app01', 'Idempotency-Key': first } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(portal.of('PUT /api/v1/inventory').length, 1, 'stored once');
});

T('retry: backoff doubles to a 5-minute ceiling', async () => {
  const r = await rig();
  await withUps(r);
  for (let i = 0; i < 12; i++) portal.state.faults.push({ status: 500 });
  await r.p.syncInventory();
  const waits = [];
  for (let i = 0; i < 11; i++) {
    const w = r.p.stats().next_attempt_at - r.clock.now();
    waits.push(w);
    r.clock.advance(w);
    await r.p.flush();
  }
  assert.deepStrictEqual(waits.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
  assert.strictEqual(Math.max(...waits), 300000);
});

T('429: waits out Retry-After, and a heartbeat does not cut the wait short', async () => {
  const r = await rig();
  await withUps(r);
  portal.state.faults.push({ status: 429, headers: { 'Retry-After': '30' } });
  await r.p.syncInventory();
  assert.strictEqual(r.p.stats().next_attempt_at - r.clock.now(), 30000);
  await r.p.heartbeat();
  assert.strictEqual(await outbox(r.db), 1, 'still waiting');
  r.clock.advance(30000);
  await r.p.flush();
  assert.strictEqual(await outbox(r.db), 0);
});

T('4xx other than 409/429 is not retried: dropped, counted, and the outbox moves on; 409 is retried', async () => {
  const r = await rig();
  const dev = await withUps(r);
  portal.state.faults.push({ status: 400, body: { error: { code: 'bad', message: 'no' } } });
  await r.p.syncInventory();
  assert.strictEqual(await outbox(r.db), 0);
  assert.strictEqual(r.p.stats().rejected, 1);

  portal.state.faults.push({ status: 409 });
  await r.settings.saveDevice({ site_id: 'HMA-FV', label: 'renamed', serial: 'AD2248220154' }, { id: dev.id });
  await r.p.syncInventory();
  assert.strictEqual(await outbox(r.db), 1, '409 is retried');
});

T('outage: events queue in order and drain in order once the link is back', async () => {
  const r = await rig();
  const dev = await withUps(r);
  portal.state.faults.push({ status: 502 });
  const aid = UUID();
  const kinds = ['alarm_raise', 'alarm_update', 'alarm_update'];
  for (let i = 0; i < 3; i++) {
    await collectorEvents(r, 'cap01', [event(dev, { alarm_id: aid, kind: kinds[i], severity: 'P2', code: 'UPS_HIGH_TEMP', title: `warm ${i}`, detail: { value: 40 + i } })]);
  }
  assert.strictEqual(await outbox(r.db), 3);
  r.clock.advance(1000);
  await r.p.flush();
  const got = portal.of('POST /api/v1/events').map(b => b.events[0]);
  assert.deepStrictEqual(got.map(e => e.kind), kinds);
  assert.deepStrictEqual(got.map(e => e.detail.value), [40, 41, 42]);
});

T('7-day buffer: what could not be delivered for longer than CFLEX_PORTAL_BUFFER_DAYS is purged', async () => {
  const r = await rig();
  await withUps(r);
  portal.state.faults.push({ status: 503 });
  await r.p.syncInventory();
  r.clock.advance(6 * 86400e3);
  assert.strictEqual(await r.p.purge(), 0);
  r.clock.advance(1 * 86400e3 + 1);
  assert.strictEqual(await r.p.purge(), 1);
  assert.strictEqual(await outbox(r.db), 0);
});

T('Q-05: a provisional ID whose serial becomes known is sent once more with replaced_by', async () => {
  const r = await rig({ realClock: true });
  const bare = await withUps(r, { site_id: 'HMA-FV', label: 'IDF UPS', serial: null, model: null, vendor: null, nmc_ip: null });
  await r.p.syncInventory();
  await r.settings.saveDevice({ site_id: 'HMA-FV', label: 'IDF UPS', serial: 'AS1234' }, { id: bare.id });
  await r.p.syncInventory();
  const [first, second] = portal.of('PUT /api/v1/inventory');
  assert.deepStrictEqual([first.devices[0].provisional, first.devices[0].id_basis], [true, 'ledger']);
  const [now, link] = second.devices;
  assert.strictEqual(now.serial, 'AS1234');
  assert.ok(!now.provisional);
  assert.deepStrictEqual(link, { device_id: first.devices[0].device_id, site_id: 'HMA-FV', replaced_by: now.device_id });
  await r.settings.saveDevice({ site_id: 'HMA-FV', label: 'renamed', serial: 'AS1234' }, { id: bare.id });
  await r.p.syncInventory();
  assert.strictEqual(portal.of('PUT /api/v1/inventory')[2].devices.length, 1, 'the link is sent once, not forever');
});

T('clock: a Portal Date more than 60 s away raises CLOCK_DRIFT once, and clears it when back', async () => {
  const r = await rig({ realClock: true });
  portal.state.dateOffsetMs = 120_000;
  await r.p.heartbeat();
  await r.p.heartbeat();
  portal.state.dateOffsetMs = 0;
  await r.p.heartbeat();
  const ev = portal.of('POST /api/v1/events').map(b => b.events[0]);
  assert.deepStrictEqual(ev.map(e => [e.code, e.kind]), [['CLOCK_DRIFT', 'alarm_raise'], ['CLOCK_DRIFT', 'alarm_clear']]);
  assert.strictEqual(ev[0].alarm_id, ev[1].alarm_id);
  assert.strictEqual(ev[0].detail.node_id, 'app01');
});

T('local_notified: events wait in the outbox while the console notifies, and go with what it delivered', async () => {
  const r = await rig();
  const dev = await withUps(r);
  const ev = event(dev);
  const res = await r.ingest.events({ events: [ev] }, 'cap01');
  assert.deepStrictEqual((await r.p.flush()), { sent: 0, held: res.outbox }, 'held: the notifier has not answered yet');
  await r.p.releaseEvents(res.outbox, { [ev.event_id]: { email: true, teams: false, itsm: 'INC0012001' } });
  await r.p.flush();
  const [got] = portal.of('POST /api/v1/events').map(b => b.events[0]);
  assert.deepStrictEqual(got.local_notified, { email: true, teams: false, itsm: 'INC0012001' });

  // A notifier that never answers (a crash between the two) costs 30 s, not the event.
  const ev2 = event(dev, { kind: 'alarm_update' , alarm_id: ev.alarm_id });
  await r.ingest.events({ events: [ev2] }, 'cap01');
  assert.strictEqual((await r.p.flush()).sent, 0);
  r.clock.advance(30_001);
  assert.strictEqual((await r.p.flush()).sent, 1);
  assert.ok(!('local_notified' in portal.of('POST /api/v1/events')[1].events[0]), 'sent without it: nobody here was told');
});

T('two app nodes: one sender (advisory lock); the other enqueues and stands by, and takes over when the sender lets go', async () => {
  const r = await rig();
  const dev = await withUps(r);
  const app02 = r.link('app02', certs.clients.app02);
  const ing02 = createIngest(r.db, { now: r.now, portal: app02 });

  assert.strictEqual((await r.p.flush()).sent, 0);
  assert.ok(r.p.isSender(), 'app01 took the lock first');
  // A collector posting to app02: app02 stores and enqueues, but does not send.
  await ing02.events({ events: [event(dev)] }, 'cap01').then(x => app02.releaseEvents(x.outbox, {}));
  assert.deepStrictEqual(await app02.flush(), { sent: 0, standby: true });
  assert.ok(!app02.isSender());
  assert.strictEqual(await outbox(r.db), 1);
  // app01 sends it.
  assert.strictEqual((await r.p.flush()).sent, 1);

  // Both send their own heartbeat; only the sender relays collectors.
  await r.db.run(`INSERT INTO collectors (node_id, key_hash, created_at, last_seen, heartbeat) VALUES ('cap01', 'x', 0, ?, ?)`,
    r.now(), JSON.stringify({ version: '2.1.0', uptime_s: 99, queue_depth: 0, devices_total: 1, devices_unreachable: 0, last_poll_ok_ratio: 1, clock: iso(r.now()), profile: 'container', os: 'RHEL 8.10' }));
  await r.db.run(`INSERT INTO collectors (node_id, key_hash, created_at, last_seen, heartbeat) VALUES ('cap09', 'x', 0, ?, NULL)`, r.now() - 10 * 60e3);
  assert.strictEqual((await app02.heartbeat()).collectors, undefined);
  assert.strictEqual((await r.p.heartbeat()).collectors, 1, 'cap01 only: cap09 has not reported for 10 minutes');
  const beats = portal.of('POST /api/v1/heartbeat');
  assert.deepStrictEqual(beats.map(b => [b.node_id, b.role, b.collector_id ?? null]),
    [['app02', 'app', null], ['app01', 'app', null], ['app01', 'collector', 'cap01']]);
  assert.deepStrictEqual([beats[2].uptime_s, beats[2].profile, beats[2].last_poll_ok_ratio], [99, 'container', 1]);

  // app01 goes away (its connection, and so its lock, with it): app02 takes over on its next tick.
  await r.p.resign();
  await ing02.events({ events: [event(dev, { code: 'UPS_OVERLOAD', severity: 'P2' })] }, 'cap01').then(x => app02.releaseEvents(x.outbox, {}));
  assert.strictEqual(await outbox(r.db), 1);
  assert.strictEqual((await app02.flush()).sent, 1);
  assert.ok(app02.isSender());
  assert.strictEqual(portal.state.requests.at(-1).peerCN, 'TEST.app02');

  // Each node's view of the link, for Settings → status.
  const links = await r.p.links();
  assert.deepStrictEqual(links.map(l => [l.node_id, l.enabled]), [['app01', true], ['app02', true]]);
});

T('two collectors, one device: one alarm, one alarm_id at the Portal; it clears when the last collector clears it', async () => {
  const r = await rig();
  const dev = await withUps(r);
  const a1 = event(dev);                                         // cap01 sees it first
  const a2 = event(dev, { ts: iso(Date.now() + 1000) });         // cap02, its own alarm_id for the same fault
  await collectorEvents(r, 'cap01', [a1]);
  const second = await collectorEvents(r, 'cap02', [a2]);
  assert.deepStrictEqual([second.accepted, second.merged, second.fresh.length], [1, 1, 0], 'stored as history, not a second alarm');

  const alarms = await r.db.all('SELECT alarm_id, state FROM alarms WHERE device_id = ?', dev.device_id);
  assert.deepStrictEqual(alarms, [{ alarm_id: a1.alarm_id, state: 'open' }]);
  const srcs = await r.db.all('SELECT source_alarm_id, alarm_id, collector_id, state FROM alarm_sources ORDER BY collector_id');
  assert.deepStrictEqual(srcs.map(s => [s.collector_id, s.alarm_id, s.state]), [['cap01', a1.alarm_id, 'open'], ['cap02', a1.alarm_id, 'open']]);

  // An update from cap02 is an update of the one alarm.
  await collectorEvents(r, 'cap02', [{ ...a2, event_id: UUID(), kind: 'alarm_update', detail: { bat_pct: 80 } }]);
  // cap01 clears: cap02 still sees it — the alarm stays open, the Portal hears nothing.
  await collectorEvents(r, 'cap01', [{ ...a1, event_id: UUID(), kind: 'alarm_clear' }]);
  assert.strictEqual((await r.db.one('SELECT state FROM alarms WHERE alarm_id = ?', a1.alarm_id)).state, 'open');
  // cap02 clears: now it is clear.
  await collectorEvents(r, 'cap02', [{ ...a2, event_id: UUID(), kind: 'alarm_clear' }]);
  assert.strictEqual((await r.db.one('SELECT state FROM alarms WHERE alarm_id = ?', a1.alarm_id)).state, 'cleared');

  const sent = portal.of('POST /api/v1/events').flatMap(b => b.events);
  assert.deepStrictEqual(sent.map(e => [e.kind, e.alarm_id, e.collector_id]),
    [['alarm_raise', a1.alarm_id, 'cap01'], ['alarm_update', a1.alarm_id, 'cap02'], ['alarm_clear', a1.alarm_id, 'cap02']]);
  const hist = await r.db.all('SELECT kind, collector_id FROM alarm_events WHERE alarm_id = ? ORDER BY ts, kind', a1.alarm_id);
  assert.strictEqual(hist.length, 5, 'every collector event is in the history, under the one alarm');
});

T('Portal off (CFLEX_PORTAL_ENABLED=0): nothing is enqueued or sent', async () => {
  const r = await rig({ portal: { enabled: false } });
  const dev = await withUps(r);
  await collectorEvents(r, 'cap01', [event(dev)]);
  await r.p.syncInventory();
  assert.deepStrictEqual(await r.p.heartbeat(), { ok: false, disabled: true });
  assert.strictEqual(await outbox(r.db), 0);
  assert.strictEqual(portal.state.requests.length, 0);
});
