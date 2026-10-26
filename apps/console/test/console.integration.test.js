// node --test apps/console/test/console.integration.test.js
//
// WO-INT-004 integration test. Two console instances (app01, app02) on one
// database and one Redis, real HTTP on 0.0.0.0, the real RESP client against
// a RESP server. What it pins down:
//
//   · stateless: a session made on app01 works on app02, and keeps working with app01 gone
//   · local accounts: password policy, forced change, lockout shared across nodes
//   · roles: Viewer reads, Operator ACKs / comments / sets maintenance, Admin configures
//   · the Collector path: inventory import → device pull → telemetry/events in → alarms, ACK, trend
//   · secrets never come back out, the audit log cannot be edited
//   · nothing the console serves points off this origin
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startMiniRedis } = require('./support/mini-redis');
const { createApp } = require('../src/server');
const { createRedis } = require('../src/redis');
const dbmod = require('../src/db');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-console-'));
const KEY = crypto.randomBytes(32).toString('hex');
const ADMIN_PW = 'Initial-Root-2026!';
const quiet = { log() {}, warn() {}, error() {} };
const UUID = () => crypto.randomUUID();

function configFor(nodeId, redisUrl, extra = {}) {
  const base = require('../src/config').load();
  return {
    ...base, nodeId, redisUrl, dbPath: path.join(tmp, 'console.db'), secretKey: KEY, cookieSecure: false,
    twinDir: path.join(tmp, 'twin'), tenant: 'HAEA', tenantName: 'HAEA', ...extra,
  };
}

/** A tiny client: keeps the cookie it is given, sends JSON. */
function client(base) {
  let cookie = '';
  return {
    set base(b) { base = b; },
    get cookie() { return cookie; },
    useCookie(c) { cookie = c; },
    async req(method, p, body, headers = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      let data;
      if (body !== undefined) {
        if (typeof body === 'string' && h['content-type']) data = body;
        else { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
      }
      const r = await fetch(base + p, { method, headers: h, body: data, redirect: 'manual' });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text, headers: r.headers };
    },
  };
}

let redisSrv, A, B, dbA, dbB, rA, rB, urlA, urlB;

async function start(nodeId, redisUrl) {
  const config = configFor(nodeId, redisUrl);
  const db = dbmod.open(config.dbPath);
  const redis = createRedis(config.redisUrl);
  const tickets = [];
  const mails = [];
  const notifyDeps = {
    // Teams and ServiceNow both go through http; a webhook answers 200, ServiceNow its incident.
    http: async (url, body, o = {}) => {
      tickets.push({ url, body, method: o.method || 'POST' });
      return { ok: true, status: 201, json: { result: { sys_id: 'a'.repeat(32), number: 'INC0099001' } } };
    },
    smtpSend: async (m) => { mails.push(m); return { messageId: `<${mails.length}@test>` }; },
  };
  const app = createApp({ config, db, redis, notifyDeps, log: quiet });
  // The production bind: every interface. The test then talks to it on loopback.
  await new Promise((r) => app.server.listen(0, config.bind, r));
  return { app, db, redis, config, tickets, mails, url: `http://127.0.0.1:${app.server.address().port}` };
}

test.before(async () => {
  fs.mkdirSync(path.join(tmp, 'twin', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'twin', 'index.html'), '<!doctype html><title>twin</title><script type="module" src="/twin/assets/index.js"></script>');
  fs.writeFileSync(path.join(tmp, 'twin', 'assets', 'index.js'), 'console.log(1)');
  redisSrv = await startMiniRedis();
  const a = await start('app01', redisSrv.url);
  const b = await start('app02', redisSrv.url);
  A = a; B = b; dbA = a.db; dbB = b.db; rA = a.redis; rB = b.redis; urlA = a.url; urlB = b.url;
  // Bootstrap admin, as `node src/cli.js create-user admin admin` does.
  A.app.settings.createUser({ username: 'admin', role: 'admin', password: ADMIN_PW, display_name: 'HAEA Admin' });
});

test.after(async () => {
  for (const x of [A, B]) { if (x.app.server.listening) await new Promise(r => x.app.server.close(r)); x.redis.close(); }
  await redisSrv.close();
});

const ADMIN_PW2 = 'Changed-Root-2026#';
let admin;

test('config: the console binds every interface by default (no more 127.0.0.1-only)', () => {
  assert.strictEqual(require('../src/config').load().bind, '0.0.0.0');
  assert.strictEqual(A.app.server.address().address, '0.0.0.0');
});

test('auth: a new account must change its password before it can read anything; policy is enforced', async () => {
  admin = client(urlA);
  assert.strictEqual((await admin.req('POST', '/v1/auth/login', { username: 'admin', password: 'wrong-password-1A' })).status, 401);
  const r = await admin.req('POST', '/v1/auth/login', { username: 'admin', password: ADMIN_PW });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.must_change, true);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.strictEqual((await admin.req('GET', '/v1/fms/summary')).json.error, 'password_change_required');
  assert.strictEqual((await admin.req('GET', '/v1/me')).status, 200, '/v1/me stays reachable so the UI can send the user to change it');
  for (const weak of ['short1A!', 'alllowercaseletters', 'admin-Password-123']) {
    const w = await admin.req('POST', '/v1/auth/password', { current: ADMIN_PW, next: weak });
    assert.strictEqual(w.json.error, 'weak_password', weak);
  }
  assert.strictEqual((await admin.req('POST', '/v1/auth/password', { current: ADMIN_PW, next: ADMIN_PW2 })).status, 200);
  assert.strictEqual((await admin.req('GET', '/v1/fms/summary')).status, 200);
});

test('stateless: the session from app01 works on app02; Redis holds only its hash', async () => {
  const onB = client(urlB);
  onB.useCookie(admin.cookie);
  const me = await onB.req('GET', '/v1/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.username, 'admin');
  assert.strictEqual(me.json.console.node, 'app02');
  const token = admin.cookie.split('=')[1];
  const keys = [...redisSrv.data.keys()];
  assert.ok(keys.some(k => k === `cflex:console:sess:${crypto.createHash('sha256').update(token).digest('hex')}`));
  assert.ok(!keys.some(k => k.includes(token)), 'the raw token is not a Redis key');
  assert.ok(![...redisSrv.data.values()].some(v => v.v.includes(token)));
});

// Users for the role tests.
let viewer, operator;
test('admin: users with the three roles; bad roles and weak passwords refused', async () => {
  for (const [username, role] of [['vera', 'viewer'], ['otto', 'operator']]) {
    const r = await admin.req('POST', '/v1/console/users', { username, role, password: `Temp-${role}-Pass-2026`, must_change: false });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  }
  assert.strictEqual((await admin.req('POST', '/v1/console/users', { username: 'xuser1', role: 'root', password: 'Temp-Pass-2026-xx' })).json.error, 'invalid_role');
  assert.strictEqual((await admin.req('POST', '/v1/console/users', { username: 'xuser2', role: 'viewer', password: 'weak' })).json.error, 'weak_password');
  viewer = client(urlA); operator = client(urlB);
  assert.strictEqual((await viewer.req('POST', '/v1/auth/login', { username: 'vera', password: 'Temp-viewer-Pass-2026' })).status, 200);
  assert.strictEqual((await operator.req('POST', '/v1/auth/login', { username: 'otto', password: 'Temp-operator-Pass-2026' })).status, 200);
});

const SEED = [
  'site,unit,location,model,serial,mfg_date_reported,firmware,battery_install,battery_replace_due,exhibit1,ip,snmp_version,snmp_community',
  'HMA, HMA-UPS-1W-B,HMA UPS PARKING GARAGE-B RACK 1,SRT5KRMXLT,AS2535281781,AUG/31/2025,UPS 16.9,AUG 2025,JUL 2030,Y,10.112.3.169,2c,haea-ro-test',
  'HMA, HMA-UPS-2E-A,HMA 2E IDF,SRT5KRMXLT,AS2101112222,JAN/01/2024,UPS 16.9,JAN 2024,JAN 2029,Y,10.112.7.21,,',
  'HMA, HMA-UPS-2E-A,HMA 2E IDF (2),SRT5KRMXLT,AS2101112222,JAN/01/2024,UPS 16.9,JAN 2024,JAN 2029,N,,,',
  'KUS,KUS-IDF1,KUS IDF1,SRT5KRMXLT,,,UPS 15.1,,,Y,10.119.141.25,,',
  'NOPE,X-1,nowhere,SRT,,,,,,Y,,,',
].join('\n');

let ups;   // the first imported device
test('settings: sites, CSV import with the §2.2 inventory warnings, credentials sealed', async () => {
  for (const [id, name] of [['HMA-FV', 'HMA Fountain Valley'], ['KUS-IRV', 'KUS Irvine']]) {
    assert.strictEqual((await admin.req('PUT', `/v1/console/sites/${id}`, { name, company: id.split('-')[0] })).status, 200);
  }
  assert.strictEqual((await admin.req('PUT', '/v1/console/sites/bad id', { name: 'x' })).status, 400);

  const dry = await admin.req('POST', '/v1/console/import?dry_run=1', SEED, { 'content-type': 'text/csv' });
  assert.strictEqual(dry.status, 200, dry.text);
  assert.strictEqual(dry.json.dry_run, true);
  assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS c FROM devices').get().c, 0, 'dry run writes nothing');

  const imp = await admin.req('POST', '/v1/console/import', SEED, { 'content-type': 'text/csv' });
  assert.strictEqual(imp.json.created, 3);
  assert.strictEqual(imp.json.updated, 1, 'same serial again = update, not a duplicate row');
  assert.strictEqual(imp.json.failed, 1);
  assert.strictEqual(imp.json.rows.find(r => r.site === 'NOPE').error, 'unknown_site');
  const codes = (label) => imp.json.rows.filter(r => r.label === label).flatMap(r => r.warnings.map(w => w.code));
  assert.ok(codes('HMA-UPS-2E-A').includes('mfg_date_default_suspect'), JSON.stringify(imp.json.rows));
  assert.ok(codes('HMA-UPS-2E-A').includes('not_in_sow'));
  assert.ok(codes('KUS-IDF1').includes('serial_missing'));
  assert.deepStrictEqual(codes('HMA-UPS-1W-B'), []);

  const devs = (await viewer.req('GET', '/v1/console/devices')).json.devices;
  ups = devs.find(d => d.label === 'HMA-UPS-1W-B');
  assert.strictEqual(ups.site_id, 'HMA-FV');
  assert.strictEqual(ups.mfg_date, '2025-08');
  assert.strictEqual(ups.device_id, crypto.createHash('sha1').update('HAEA|HMA-FV|AS2535281781').digest('hex').slice(0, 16));

  // Exhibit-1 community came in with the CSV — sealed, never echoed.
  const creds = (await admin.req('GET', '/v1/console/credentials')).json.credentials;
  assert.strictEqual(creds.length, 1);
  assert.strictEqual(creds[0].secret_set, true);
  assert.ok(!JSON.stringify(creds).includes('haea-ro-test'));
  assert.ok(!fs.readFileSync(path.join(tmp, 'console.db')).includes('haea-ro-test'), 'not in the database file in the clear');
  const v3 = await admin.req('PUT', '/v1/console/credentials', { site_id: 'KUS-IRV', version: '3', username: 'cflexro', auth_proto: 'SHA', auth_key: 'auth-secret-kus', priv_proto: 'AES', priv_key: 'priv-secret-kus' });
  assert.strictEqual(v3.status, 200);
  assert.ok(!v3.text.includes('secret-kus'));
});

test('roles: Viewer reads but cannot ACK or configure; Operator cannot configure', async () => {
  assert.strictEqual((await viewer.req('GET', '/v1/fms/assets')).status, 200);
  assert.strictEqual((await viewer.req('PUT', '/v1/console/sites/HMA-FV', { name: 'x' })).status, 403);
  assert.strictEqual((await viewer.req('POST', `/v1/fms/devices/${ups.id}/mute`, { minutes: 30 })).status, 403);
  assert.strictEqual((await operator.req('PUT', '/v1/console/sites/HMA-FV', { name: 'x' })).status, 403);
  assert.strictEqual((await operator.req('GET', '/v1/console/users')).status, 403);
  assert.strictEqual((await operator.req('GET', '/v1/console/credentials')).status, 403);
  assert.strictEqual((await client(urlA).req('GET', '/v1/fms/assets')).status, 401, 'no session, no data');
});

let collectorKey;
const col = (method, p, body) => fetch(urlB + p, {
  method, headers: { 'content-type': 'application/json', 'x-cflex-node': 'cap01', authorization: `Bearer ${collectorKey}` },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json() }));

test('collector: key-authenticated pull of devices (with opened credentials) and config', async () => {
  const k = await admin.req('POST', '/v1/console/collectors/cap01/key');
  collectorKey = k.json.key;
  assert.ok(collectorKey.length >= 40);
  assert.ok(!JSON.stringify(dbA.prepare('SELECT * FROM collectors').all()).includes(collectorKey), 'stored as a hash');
  assert.strictEqual((await fetch(urlB + '/collector/v1/devices', { headers: { 'x-cflex-node': 'cap01', authorization: 'Bearer nope' } })).status, 401);
  const d = await col('GET', '/collector/v1/devices');
  assert.strictEqual(d.status, 200);
  const one = d.json.devices.find(x => x.device_id === ups.device_id);
  assert.deepStrictEqual([one.ip, one.snmp_version, one.snmp_community], ['10.112.3.169', '2c', 'haea-ro-test']);
  const kus = d.json.devices.find(x => x.name === 'KUS-IDF1');
  assert.deepStrictEqual([kus.snmp_version, kus.snmp_v3.user, kus.snmp_v3.priv_key], ['3', 'cflexro', 'priv-secret-kus'], 'site default credential applies');
  assert.strictEqual((await col('GET', '/collector/v1/config')).status, 200);
});

const iso = (t) => new Date(t).toISOString();
let alarmId, alertRowId;
test('collector → console: telemetry and an On-Battery P1 become a critical device and an open alarm', async () => {
  const t0 = Date.now() - 10 * 60e3;
  const points = [];
  for (let i = 0; i < 10; i++) points.push({ device_id: ups.device_id, ts: iso(t0 + i * 60e3), m: { comm_ok: true, bat_pct: 100 - i, load_pct: 40, bat_temp_c: 24.5, runtime_s: 1800, status: 'online', out_v: [120.1], in_v: [119.8] } });
  points.push({ device_id: 'ffffffffffffffff', ts: iso(t0), m: { comm_ok: true } });
  const t = await col('POST', '/collector/v1/telemetry', { node_id: 'cap01', points });
  assert.deepStrictEqual(t.json, { accepted: 10, unknown_devices: 1 });
  assert.strictEqual((await col('POST', '/collector/v1/telemetry', { node_id: 'cap01', points })).json.accepted, 0, 'replay stores nothing twice');
  assert.strictEqual((await col('POST', '/collector/v1/telemetry', { node_id: 'cap01', points: [{ device_id: 'x', ts: 'yesterday', m: {} }] })).status, 400, 'contract schema enforced');

  let a = (await viewer.req('GET', '/v1/fms/assets')).json.assets.find(x => x.id === ups.id);
  assert.deepStrictEqual([a.status, a.battery_pct, a.runtime_min, a.output_status], ['ok', 91, 30, 'ONLINE']);

  alarmId = UUID();
  const raise = { event_id: UUID(), alarm_id: alarmId, device_id: ups.device_id, site_id: 'HMA-FV', ts: iso(Date.now()), kind: 'alarm_raise',
    severity: 'P1', code: 'UPS_ON_BATTERY', title: 'UPS on battery', detail: { metric: 'output_source', value: 'onBattery' }, source: 'rule',
    local_notified: { email: true, teams: false, itsm: 'INC0012345' } };
  // This event says what was delivered already (a collector that still notifies by itself), so the
  // console — which has no channels configured yet anyway — sends nothing and answers nothing new.
  assert.deepStrictEqual((await col('POST', '/collector/v1/events', { events: [raise] })).json, { accepted: 1, duplicate: 0, local_notified: {} });
  assert.deepStrictEqual((await col('POST', '/collector/v1/events', { events: [raise] })).json,
    { accepted: 0, duplicate: 1, local_notified: { [raise.event_id]: raise.local_notified } }, 'a replay is answered with what was stored');

  a = (await viewer.req('GET', '/v1/fms/assets')).json.assets.find(x => x.id === ups.id);
  assert.strictEqual(a.status, 'critical');
  const s = (await viewer.req('GET', '/v1/fms/summary')).json;
  assert.strictEqual(s.devices.critical, 1);
  assert.strictEqual(s.cbu_list.find(c => c.cbu === 'HMA-FV').critical, 1);

  const list = (await viewer.req('GET', '/v1/fms/alerts?hours=24')).json.alerts;
  const al = list.find(x => x.alarm_id === alarmId);
  alertRowId = al.id;
  assert.deepStrictEqual([al.priority, al.code, al.device_id, al.device_label, al.state, al.local_notified.itsm], ['P1', 'UPS_ON_BATTERY', `ups-${ups.id}`, 'HMA-UPS-1W-B', 'open', 'INC0012345']);
  assert.strictEqual((await viewer.req('GET', '/v1/fms/alerts?priority=P2')).json.alerts.length, 0, 'priority filter');
  assert.strictEqual((await viewer.req('GET', '/v1/fms/alerts?cbu=KUS-IRV')).json.alerts.length, 0, 'site filter');
});

test('alarms: Operator ACKs and comments (on the other node); detail shows history; clear closes it', async () => {
  assert.strictEqual((await viewer.req('POST', `/v1/fms/alerts/${alertRowId}/ack`, {})).status, 403);
  const ack = await operator.req('POST', `/v1/fms/alerts/${alertRowId}/ack`, { comment: 'generator test, expected' });
  assert.strictEqual(ack.json.acked_by, 'otto');
  assert.strictEqual((await operator.req('POST', `/v1/fms/alerts/${alertRowId}/comments`, { text: 'on site, watching' })).status, 200);
  const clear = { event_id: UUID(), alarm_id: alarmId, device_id: ups.device_id, site_id: 'HMA-FV', ts: iso(Date.now() + 1000), kind: 'alarm_clear',
    severity: 'P1', code: 'UPS_ON_BATTERY', title: 'Cleared: UPS on battery', detail: {}, source: 'rule' };
  await col('POST', '/collector/v1/events', { events: [clear] });
  const d = (await viewer.req('GET', `/v1/fms/alerts/${alertRowId}`)).json;
  assert.strictEqual(d.alert.state, 'cleared');
  assert.strictEqual(d.alert.acked_by, 'otto');
  assert.deepStrictEqual(d.events.map(e => e.kind), ['alarm_raise', 'alarm_clear']);
  assert.deepStrictEqual(d.comments.map(c => [c.kind, c.author, c.text]), [['ack', 'otto', 'generator test, expected'], ['comment', 'otto', 'on site, watching']]);
  assert.strictEqual((await viewer.req('GET', '/v1/fms/alerts?state=open')).json.alerts.length, 0);
  assert.strictEqual((await viewer.req('GET', '/v1/fms/assets')).json.assets.find(x => x.id === ups.id).status, 'ok');
});

test('device detail: 24 h trend from telemetry, thresholds, the device facts', async () => {
  const r = (await viewer.req('GET', `/v1/fms/assets/${ups.id}?range=24h`)).json;
  assert.ok(r.metrics.length >= 2 && r.metrics.length <= 96, String(r.metrics.length));
  assert.ok(r.metrics.every(m => m.battery_pct >= 91 && m.battery_pct <= 100));
  assert.deepStrictEqual(r.thresholds.battery_pct, { critical: 30, warn: 60, direction: 'below' });
  assert.deepStrictEqual([r.asset.serial, r.asset.firmware, r.asset.battery_installed, r.asset.battery_due], ['AS2535281781', 'UPS 16.9', '2025-08', '2030-07']);
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual((await viewer.req('GET', `/v1/fms/assets/ups-${ups.id}?range=7d`)).status, 200, 'the alert row id form works too');
  const f = (await viewer.req('GET', '/v1/fms/fleet-live?minutes=30')).json;
  assert.ok(f.series.length >= 1);
  assert.strictEqual(f.fleet.devices, 3);
});

test('maintenance: Operator mutes a device; the collector config carries the window', async () => {
  const m = await operator.req('POST', `/v1/fms/devices/${ups.id}/mute`, { minutes: 90, reason: 'battery swap' });
  assert.ok(m.json.muted_until > Date.now() + 80 * 60e3);
  const a = (await viewer.req('GET', '/v1/fms/assets')).json.assets.find(x => x.id === ups.id);
  assert.strictEqual(a.muted_until, m.json.muted_until);
  const cfg = await col('GET', '/collector/v1/config');
  assert.deepStrictEqual(cfg.json.maintenance.map(w => [w.device_id, w.ledger_id, w.reason]), [[ups.device_id, ups.id, 'battery swap']]);
  await operator.req('POST', `/v1/fms/devices/${ups.id}/unmute`, {});
  assert.strictEqual((await col('GET', '/collector/v1/config')).json.maintenance.length, 0);
});

test('notify channels: secrets stored sealed, answered as {set:true}; the test-ticket button runs create→update→resolve', async () => {
  const put = await admin.req('PUT', '/v1/console/notify', {
    policy: { local_itsm: true, itsm_min: 'P2' },
    email: { to: ['noc@haea.example'], from: 'fms@haea.example', smtp: { host: 'relay.haea.example', port: 587, auth: { user: 'relay', pass: 'smtp-secret-pw' } } },
    teams: { webhook: 'https://haea.webhook.office.com/webhookb2/secret-hook' },
    servicenow: { instanceUrl: 'https://haea.service-now.example', user: 'svc-cflex', pass: 'sn-secret-pw' },
  });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual(put.json.notify.servicenow.pass, { set: true });
  assert.deepStrictEqual(put.json.notify.teams.webhook, { set: true });
  for (const s of ['smtp-secret-pw', 'secret-hook', 'sn-secret-pw']) {
    assert.ok(!put.text.includes(s));
    assert.ok(!JSON.stringify(dbA.prepare('SELECT * FROM settings').all()).includes(s), `${s} sealed at rest`);
    assert.ok(!JSON.stringify(dbA.prepare('SELECT * FROM audit_log').all()).includes(s), `${s} not in the audit log`);
  }
  // A later PUT without the secret keeps it.
  await admin.req('PUT', '/v1/console/notify', { servicenow: { assignmentGroup: 'Facilities' } });
  const health = (await viewer.req('GET', '/v1/fms/channels/health')).json.channels;
  assert.deepStrictEqual(health.map(c => [c.channel, c.configured]), [['email', true], ['teams', true], ['servicenow', true]]);

  assert.strictEqual((await operator.req('POST', '/v1/console/notify/test-ticket', {})).status, 403);
  const tt = await admin.req('POST', '/v1/console/notify/test-ticket', {});
  assert.strictEqual(tt.status, 200, tt.text);
  assert.deepStrictEqual([tt.json.ok, tt.json.number, tt.json.updated, tt.json.resolved], [true, 'INC0099001', true, true]);
  assert.strictEqual(A.tickets.length, 3);
  assert.match(A.tickets[0].url, /^https:\/\/haea\.service-now\.example\/api\/now\/table\/incident/);
  // Q-2026-10-25-10 (A): the console notifies, so the channel secrets stay here —
  // the collector's config pull no longer carries them, opened or sealed.
  const cfg = await fetch(urlB + '/collector/v1/config', { headers: { 'x-cflex-node': 'cap01', authorization: `Bearer ${collectorKey}` } }).then(r => r.text());
  assert.strictEqual(JSON.parse(cfg).notify, undefined);
  for (const s of ['smtp-secret-pw', 'secret-hook', 'sn-secret-pw']) assert.ok(!cfg.includes(s), s);
});

test('local notification (Q-10 A): the console notifies collector events and answers with local_notified', async () => {
  const before = { mails: B.mails.length, tickets: B.tickets.length };
  const id = UUID();
  const raise = { event_id: UUID(), alarm_id: id, device_id: ups.device_id, site_id: 'HMA-FV', ts: iso(Date.now()), kind: 'alarm_raise',
    severity: 'P1', code: 'UPS_ON_BATTERY', title: 'Output source: onBattery', detail: { metric: 'output_source', value: 'onBattery' }, source: 'rule' };
  const r = await col('POST', '/collector/v1/events', { events: [raise] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.local_notified[raise.event_id], { email: true, teams: true, itsm: 'INC0099001' });
  assert.strictEqual(B.mails.length - before.mails, 1, 'one e-mail to the one recipient');
  assert.match(B.mails.at(-1).subject, /\[P1\].*HMA-UPS-1W-B/);
  assert.ok(B.tickets.slice(before.tickets).some(t => /webhook/.test(t.url)), 'Teams');
  assert.ok(B.tickets.slice(before.tickets).some(t => /table\/incident$/.test(t.url)), 'ServiceNow create');
  // What reached the alarm list is what was delivered.
  const al = (await viewer.req('GET', '/v1/fms/alerts?hours=1')).json.alerts.find(x => x.alarm_id === id);
  assert.deepStrictEqual(al.local_notified, { email: true, teams: true, itsm: 'INC0099001' });

  // The collector retries (lost response): same answer, nobody told twice.
  const n = { mails: B.mails.length, tickets: B.tickets.length };
  const again = await col('POST', '/collector/v1/events', { events: [raise] });
  assert.deepStrictEqual(again.json, { accepted: 0, duplicate: 1, local_notified: { [raise.event_id]: { email: true, teams: true, itsm: 'INC0099001' } } });
  assert.deepStrictEqual([B.mails.length, B.tickets.length], [n.mails, n.tickets]);

  // The clear goes to the other node: it finds the INC the raise opened (itsm_map, not process memory) and resolves it.
  const clear = { ...raise, event_id: UUID(), ts: iso(Date.now() + 1000), kind: 'alarm_clear', title: 'Cleared: Output source: onBattery', detail: {} };
  const ca = await fetch(urlA + '/collector/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cflex-node': 'cap01', authorization: `Bearer ${collectorKey}` }, body: JSON.stringify({ events: [clear] }) }).then(x => x.json());
  assert.strictEqual(ca.local_notified[clear.event_id].itsm, 'INC0099001');
  const resolve = A.tickets.at(-1);
  assert.strictEqual(resolve.method, 'PATCH');
  assert.match(resolve.url, /table\/incident\/a{32}$/);
  assert.strictEqual(resolve.body.state, '6', 'resolved');
});

test('local notification: a maintenance window on the console suppresses paging; a stale replay is recorded, not paged', async () => {
  const m = await operator.req('POST', `/v1/fms/devices/${ups.id}/mute`, { minutes: 30, reason: 'battery swap' });
  const n = { mails: B.mails.length, tickets: B.tickets.length };
  const ev = { event_id: UUID(), alarm_id: UUID(), device_id: ups.device_id, site_id: 'HMA-FV', ts: iso(Date.now()), kind: 'alarm_raise',
    severity: 'P1', code: 'UPS_ON_BATTERY', title: 'Output source: onBattery', detail: {}, source: 'rule' };
  const r = await col('POST', '/collector/v1/events', { events: [ev] });
  assert.deepStrictEqual(r.json.local_notified[ev.event_id], { email: false, teams: false, itsm: null }, 'window set after the collector last pulled its config still applies');
  assert.deepStrictEqual([B.mails.length, B.tickets.length], [n.mails, n.tickets]);
  await operator.req('POST', `/v1/fms/devices/${ups.id}/unmute`, {});
  assert.ok(m.json.muted_until);

  const old = { ...ev, event_id: UUID(), alarm_id: UUID(), ts: iso(Date.now() - 60 * 60e3) };
  const replay = await fetch(urlB + '/collector/v1/events', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cflex-node': 'cap01', authorization: `Bearer ${collectorKey}`, 'x-cflex-replay': '1' },
    body: JSON.stringify({ events: [old] }) }).then(x => x.json());
  assert.deepStrictEqual(replay.local_notified[old.event_id], { email: false, teams: false, itsm: null });
  assert.deepStrictEqual([B.mails.length, B.tickets.length], [n.mails, n.tickets], 'an hour-old raise replayed after an outage pages nobody');
  assert.strictEqual((await viewer.req('GET', '/v1/fms/alerts?hours=2')).json.alerts.filter(a => a.alarm_id === old.alarm_id).length, 1, 'but it is on the list');
});

test('profile internal (Q-09 B): no portal-scope API is served — routing, control, copilot, power chain, topology, tickets, incidents', async () => {
  assert.strictEqual(A.config.profile, 'internal', 'the console default');
  const portalish = /copilot|power-chain|topology|\/routes|\/control|tickets|incidents|sites-map|noc|wall/;
  assert.deepStrictEqual(A.app.router.routes.filter(r => portalish.test(r.re.source)).map(r => r.re.source), []);
  for (const p of ['/v1/fms/routes', '/v1/fms/control/actions', '/v1/fms/topology', '/v1/fms/copilot', '/v1/fms/power-chain/1', '/v1/incidents/1/workbench']) {
    assert.strictEqual((await viewer.req('GET', p)).status, 404, p);
  }
});

test('lockout: five wrong passwords lock the account on both nodes, even against the right one', async () => {
  const u = client(urlA);
  for (let i = 0; i < 5; i++) assert.strictEqual((await u.req('POST', '/v1/auth/login', { username: 'vera', password: `Wrong-Pass-${i}-2026` })).status, 401);
  assert.strictEqual((await client(urlB).req('POST', '/v1/auth/login', { username: 'vera', password: 'Temp-viewer-Pass-2026' })).status, 423);
  const vera = (await admin.req('GET', '/v1/console/users')).json.users.find(x => x.username === 'vera');
  await admin.req('PUT', `/v1/console/users/${vera.id}`, { unlock: true });
  assert.strictEqual((await client(urlB).req('POST', '/v1/auth/login', { username: 'vera', password: 'Temp-viewer-Pass-2026' })).status, 200);
});

test('roles take effect at once: a demoted operator loses ACK on the next request; the last admin cannot be demoted', async () => {
  const otto = (await admin.req('GET', '/v1/console/users')).json.users.find(x => x.username === 'otto');
  await admin.req('PUT', `/v1/console/users/${otto.id}`, { role: 'viewer' });
  assert.strictEqual((await operator.req('POST', `/v1/fms/alerts/${alertRowId}/unack`, {})).status, 403);
  await admin.req('PUT', `/v1/console/users/${otto.id}`, { disabled: true });
  assert.strictEqual((await operator.req('GET', '/v1/fms/summary')).status, 401);
  const me = (await admin.req('GET', '/v1/me')).json;
  assert.strictEqual((await admin.req('PUT', `/v1/console/users/${me.userId}`, { role: 'viewer' })).json.error, 'last_admin');
});

test('audit log: logins, ACKs and settings are recorded; rows cannot be changed or deleted', async () => {
  const actions = new Set((await admin.req('GET', '/v1/console/audit?limit=500')).json.entries.map(e => e.action));
  for (const a of ['login', 'login_failed', 'login_locked', 'password_change', 'user_create', 'import', 'credential_put', 'alarm_ack', 'alarm_comment', 'maintenance_set', 'notify_put', 'test_ticket', 'collector_key_issued']) {
    assert.ok(actions.has(a), a);
  }
  assert.throws(() => dbA.prepare('UPDATE audit_log SET actor = ? WHERE id = 1').run('x'), /append-only/);
  assert.throws(() => dbA.prepare('DELETE FROM audit_log').run(), /append-only/);
  const nodes = new Set(dbA.prepare('SELECT DISTINCT node FROM audit_log').all().map(r => r.node));
  assert.ok(nodes.has('app01') && nodes.has('app02'), 'both nodes write the one log');
});

test('CSRF: state-changing requests must be JSON (cross-site forms cannot send it)', async () => {
  const r = await admin.req('POST', `/v1/fms/alerts/${alertRowId}/unack`, 'x=1', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(r.status, 415);
  const t = await admin.req('POST', '/v1/console/import', 'site,label\nHMA,X', { 'content-type': 'text/plain' });
  assert.strictEqual(t.status, 415);
});

test('static: twin under /twin/, /login and /settings pages, CSP same-origin only on every response', async () => {
  const ui = await client(urlA).req('GET', '/twin/');
  assert.strictEqual(ui.status, 200);
  assert.match(ui.text, /<title>twin<\/title>/);
  assert.strictEqual((await client(urlA).req('GET', '/twin/device/42')).status, 200, 'SPA fallback');
  for (const p of ['/login', '/settings', '/v1/fms/summary', '/twin/']) {
    const r = await client(urlA).req('GET', p);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, p);
    assert.doesNotMatch(csp, /https?:/, `${p}: no external origin allowed`);
  }
  const trav = await fetch(urlA + '/static/..%2f..%2fsrc%2fserver.js');
  assert.notStrictEqual(trav.status, 200, 'no path traversal out of public/');
});

/** Every external reference a browser would follow in a set of files. */
function externalRefs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html|js|mjs|css)$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      // What a browser fetches by itself: script/img/link/iframe/media sources,
      // CSS url()/@import, fetch/new URL/importScripts targets, and any string
      // naming a font, tile or CDN host. A plain <a href> is a link the user
      // may click, not a load, and is not counted (the CSP blocks loads anyway).
      const re = /<(?:script|img|link|iframe|source|video|audio|embed)\b[^>]*?(?:src|href)\s*=\s*\\?["'](?:https?:)?\/\/[^"']+|url\(\s*["']?(?:https?:)?\/\/[^)"']+|@import\s+["'](?:https?:)?\/\/[^"']+|(?:fetch|importScripts|new URL)\(\s*["'`]https?:\/\/[^"'`]+|["'`]https?:\/\/[a-z0-9.-]*(?:googleapis|gstatic|jsdelivr|unpkg|cdnjs|cloudflare|openfreemap|cartocdn|tile|fonts)[^"'`]*["'`]/gi;
      for (const m of s.matchAll(re)) out.push(`${path.relative(dir, p)}: ${m[0].slice(0, 120)}`);
    }
  };
  walk(dir);
  return out;
}

test('no external CDN: the scanner does catch what the portal build loads (Google Fonts, map tiles)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-scan-'));
  fs.copyFileSync(path.resolve(ROOT, '../twin/index.html'), path.join(d, 'index.html'));
  fs.writeFileSync(path.join(d, 'a.js'), "const s='https://tiles.openfreemap.org/styles/positron';fetch('https://x.example/y')");
  const hits = externalRefs(d);
  assert.ok(hits.some(h => /fonts\.googleapis/.test(h)), hits.join('\n'));
  assert.ok(hits.some(h => /openfreemap/.test(h)) && hits.some(h => /x\.example/.test(h)), hits.join('\n'));
});

test('no external CDN: the console pages reference nothing off-origin', () => {
  assert.deepStrictEqual(externalRefs(path.join(ROOT, 'public')), []);
});

const TWIN_BUILD = path.resolve(ROOT, '../twin/dist-console');
test('no external CDN: the console build of twin (apps/twin, npm run build:console) references nothing off-origin', { skip: !fs.existsSync(TWIN_BUILD) && 'twin console build not present — run `npm run build:console` in apps/twin' }, () => {
  assert.deepStrictEqual(externalRefs(TWIN_BUILD), []);
});

test('SAT 6: app01 stops — app02 keeps serving the same logged-in user', async () => {
  await new Promise(r => A.app.server.close(r));
  const onB = client(urlB);
  onB.useCookie(admin.cookie);
  const r = await onB.req('GET', '/v1/fms/summary');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.devices.total, 3);
  await assert.rejects(fetch(urlA + '/healthz'));
});

test('Redis down: the API answers 503 (and /healthz says so for nginx), not 500 and not a crash', async () => {
  await redisSrv.close();
  const onB = client(urlB);
  onB.useCookie(admin.cookie);
  const r = await onB.req('GET', '/v1/fms/summary');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error, 'session_store_unavailable');
  assert.strictEqual((await fetch(urlB + '/healthz')).status, 503);
});
