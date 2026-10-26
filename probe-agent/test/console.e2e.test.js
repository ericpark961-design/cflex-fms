// node --test probe-agent/test/console.e2e.test.js
//
// WO-INT-004c: the Collector and the Local Console as two real processes —
// `node probe-agent/src/index.js` and `node apps/console/src/server.js`, the
// same entry points systemd/Quadlet start — with nothing mocked between them.
// A third process is the UPS: sim/sim-ups.js answering SNMP like an APC NMC.
//
//   console  ── devices (+ community), thresholds, maintenance ──▶ collector   (inventory pull)
//   UPS sim  ◀── SNMP get (community from the console) ─────────── collector
//   collector ── telemetry, UPS_ON_BATTERY raise/clear ──────────▶ console   (push, collector key)
//   console  ── e-mail ▶ SMTP relay, incident ▶ ServiceNow;  answers local_notified
//   collector ── events carrying that local_notified ────────────▶ Portal    (mTLS)
//
// Stand-ins, each for something this Mac cannot have: a TLS front for nginx
// (443, HAEA CA), mini-redis for Redis 6, embedded-postgres for PostgreSQL 16
// on db01 (WO-INT-008; apps/console/test/support/pg.js), the dummy SMTP relay and dummy
// ServiceNow for HAEA's, and the mTLS mock Portal (the real one has no
// /api/v1 yet). No call is short-circuited inside either process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { makeCerts, hasOpenssl } = require('./support/certs');
const { startMockPortal } = require('./support/mock-portal');
const { startDummySmtp, decode } = require('../../packages/notify/test/support/dummy-smtp');
const { startDummyServiceNow } = require('../../packages/notify/test/support/dummy-servicenow');
const { startMiniRedis } = require('../../apps/console/test/support/mini-redis');
const pgt = require('../../apps/console/test/support/pg');

const ROOT = path.resolve(__dirname, '../..');
// better-sqlite3 for the probe's buffer, pg for the console, and a PostgreSQL 16 to run it against.
const resolves = (mod, from) => { try { require.resolve(mod, { paths: [from] }); return true; } catch { return false; } };
const skip = !hasOpenssl() ? 'openssl CLI not available'
  : !resolves('better-sqlite3', __dirname) ? 'probe-agent dependencies not installed (npm install in probe-agent)'
  : !resolves('pg', path.join(ROOT, 'apps/console/src')) ? 'console dependencies not installed (npm install in apps/console)'
  : pgt.unavailable || false;

const COMMUNITY = 'e2e-ro-community';
const SERIAL = 'AS2535281781';
const deviceId = crypto.createHash('sha1').update(`TEST|HMA-FV|${SERIAL}`).digest('hex').slice(0, 16);

let tmp, certs, relay, sn, redis, portal, front, consoleDb, pg;
const procs = {};
const logs = { console: [], probe: [], sim: [] };

const freeTcp = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const freeUdp = () => new Promise((r) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

function run(name, file, env) {
  const p = spawn(process.execPath, [file], { cwd: tmp, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const keep = (b) => { for (const l of String(b).split('\n')) if (l.trim()) logs[name].push(l); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  procs[name] = p;
  return p;
}

async function waitFor(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) {
      const tail = (n) => logs[n].slice(-15).join('\n    ');
      throw new Error(`timed out waiting for ${what}\n  console:\n    ${tail('console')}\n  probe:\n    ${tail('probe')}\n  sim:\n    ${tail('sim')}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

const q = (sql, ...a) => consoleDb.all(sql, ...a);
const one = (sql, ...a) => consoleDb.one(sql, ...a);
const json = (s) => (s ? JSON.parse(s) : null);

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-console-e2e-'));
  certs = makeCerts();
  relay = await startDummySmtp({ user: 'fms', pass: 'relay-pw' });
  sn = await startDummyServiceNow();
  redis = await startMiniRedis();
  portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  pg = await pgt.start();
  const dbConn = pg.conn();

  // ── the console's store, set up the way an admin would through Settings ──
  const secretKey = path.join(tmp, 'console.key');
  fs.writeFileSync(secretKey, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  {
    const db = await require('../../apps/console/src/db').open(dbConn);
    const { createSettings } = require('../../apps/console/src/settings');
    const { createSealer } = require('../../apps/console/src/seal');
    const settings = createSettings(db, { sealer: createSealer(fs.readFileSync(secretKey, 'utf8')), tenant: 'TEST' });
    await settings.putSite('HMA-FV', { name: 'HMA Fountain Valley', company: 'HMA' });
    const { device } = await settings.saveDevice({ site_id: 'HMA-FV', label: 'HMA-UPS-1W-B', vendor: 'APC', model: 'SRT5KRMXLT', serial: SERIAL, nmc_ip: '127.0.0.1' });
    assert.strictEqual(device.device_id, deviceId);
    await settings.putCredential({ device_id: device.device_id, version: '2c', community: COMMUNITY }, 'e2e');
    await settings.putNotify({
      policy: { local_teams: false },
      email: { to: ['idc-noc@haeaus.example'], from: 'C-Flex FMS <fms-noreply@haeaus.example>',
        smtp: { host: relay.host, port: relay.port, starttls: 'never', auth: { user: 'fms', pass: 'relay-pw' } } },
      servicenow: { instanceUrl: sn.url, user: 'svc', pass: 'secret', category: 'Hardware' },
    }, 'e2e');
    fs.writeFileSync(path.join(tmp, 'collector.key'), (await settings.issueCollectorKey('cap01')).key + '\n', { mode: 0o600 });
    await db.close();
  }

  // ── process 1: the Local Console ─────────────────────────────────────────
  const consolePort = await freeTcp();
  run('console', path.join(ROOT, 'apps/console/src/server.js'), {
    CONSOLE_NODE_ID: 'app01', CONSOLE_BIND: '127.0.0.1', CONSOLE_PORT: String(consolePort),
    CFLEX_DB_URL: dbConn.url, CFLEX_DB_PASSWORD_FILE: dbConn.passwordFile,
    REDIS_URL: redis.url, CONSOLE_SECRET_KEY_FILE: secretKey, CFLEX_TENANT: 'TEST', CONSOLE_COOKIE_SECURE: '0',
    CONSOLE_TWIN_DIR: tmp,
  });
  await waitFor('console /healthz', () => fetch(`http://127.0.0.1:${consolePort}/healthz`).then(r => r.ok));
  // A second connection to read what the console stored (the console process has its own pool).
  consoleDb = await require('../../apps/console/src/db').open(dbConn, { migrate: false, partitions: false });

  // nginx's part: TLS on the console's name with the HAEA (here: test) CA, proxied to the app.
  front = https.createServer(certs.server, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: consolePort, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise(r => front.listen(0, '127.0.0.1', r));

  // ── process 2: the UPS ───────────────────────────────────────────────────
  const snmpPort = await freeUdp();
  run('sim', path.join(ROOT, 'probe-agent/sim/sim-ups.js'), { SNMP_PORT: String(snmpPort), SNMP_COMMUNITY: COMMUNITY, OUTPUT: 'battery' });
  await waitFor('UPS simulator', () => logs.sim.some(l => /udp\//.test(l)));

  // ── process 3: the Collector ─────────────────────────────────────────────
  run('probe', path.join(ROOT, 'probe-agent/src/index.js'), {
    TENANT_ID: 'TEST', CFLEX_NODE_ID: 'cap01', CFLEX_SITE_ID: 'HMA-FV',
    CFLEX_CONSOLE_URL: `https://localhost:${front.address().port}`,
    CFLEX_CONSOLE_KEY_FILE: path.join(tmp, 'collector.key'), CFLEX_CONSOLE_CA: certs.caPath,
    CFLEX_PORTAL_URL: portal.url, CFLEX_TLS_CERT: certs.client.certPath, CFLEX_TLS_KEY: certs.client.keyPath, CFLEX_TLS_CA: certs.caPath,
    BUFFER_DB_PATH: path.join(tmp, 'buffer.db'), CFLEX_ID_STORE: path.join(tmp, 'ids.json'), CFLEX_ITSM_STORE: path.join(tmp, 'itsm.json'),
    POLL_INTERVAL_MS: '1500', HEARTBEAT_INTERVAL_MS: '1000', TELEMETRY_FLUSH_MS: '1000', CONFIG_RELOAD_MS: '3000',
    SNMP_PORT: String(snmpPort), SNMP_TIMEOUT_MS: '1000', SNMP_RETRIES: '0',
  });
});

test.after(async () => {
  if (skip) return;
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  await Promise.all(Object.values(procs).map(p => (p.exitCode != null ? null : new Promise(r => p.once('exit', r)))));
  await consoleDb?.close();
  await pg?.stop();
  front?.closeAllConnections?.(); front?.close();
  await Promise.all([relay.close(), sn.close(), redis.close(), portal.close()]);
  certs.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('inventory pull: the collector polls the device the console has, with the community the console holds', { skip }, async () => {
  await waitFor('collector loaded the console inventory', () => logs.probe.some(l => /loaded 1 UPS from the Local Console/.test(l)));
  // Telemetry from that poll, pushed back: the console has readings for the device.
  const t = await waitFor('telemetry in the console', async () => (await one('SELECT COUNT(*) AS c FROM telemetry WHERE device_id = ? AND comm_ok = 1', deviceId)).c > 0 && one('SELECT * FROM devices WHERE device_id = ?', deviceId));
  assert.deepStrictEqual([t.battery_pct, t.load_pct, t.ups_status], [100, 38, 'on_battery']);
  // And the same points reached the Portal, under the same contract device_id.
  await waitFor('telemetry at the Portal', () => portal.of('POST /api/v1/telemetry').some(b => b.points.some(p => p.device_id === deviceId)));
  assert.ok(portal.of('PUT /api/v1/inventory').some(b => b.devices.some(d => d.device_id === deviceId && d.serial === SERIAL)));
});

let alarm, inc;
test('event push: an on-battery UPS raises a P1 the console notifies (SMTP + ServiceNow), and the Portal gets what was delivered', { skip }, async () => {
  alarm = await waitFor('the alarm in the console, notified', async () => {
    const a = await one(`SELECT * FROM alarms WHERE device_id = ? AND code = 'UPS_ON_BATTERY'`, deviceId);
    return a && a.local_notified && a;
  });
  assert.strictEqual(alarm.severity, 'P1');
  assert.strictEqual(alarm.state, 'open');
  const ln = json(alarm.local_notified);
  inc = [...sn.state.incidents.values()][0];
  assert.ok(inc, 'an incident was opened in ServiceNow');
  assert.deepStrictEqual(ln, { email: true, teams: false, itsm: inc.number }, 'what the console delivered');

  // The relay got the mail from the console process (the collector has no channel configured at all).
  const mail = decode(relay.state.messages[0].raw);
  assert.match(mail.subject, /\[P1\]/);
  assert.deepStrictEqual(relay.state.messages[0].to, ['idc-noc@haeaus.example']);

  // The Portal's copy carries the same local_notified — contract 00 v1.1 §3.4.
  const ev = await waitFor('the raise at the Portal', () => portal.of('POST /api/v1/events').flatMap(b => b.events).find(e => e.alarm_id === alarm.alarm_id && e.kind === 'alarm_raise'));
  assert.deepStrictEqual(ev.local_notified, ln);
  assert.strictEqual(ev.code, 'UPS_ON_BATTERY');
});

test('clear: back on line, the alarm clears in the console, the ServiceNow incident is resolved, the Portal gets the clear', { skip }, async () => {
  procs.sim.stdin.write('online\n');
  const cleared = await waitFor('the clear in the console', async () => {
    const a = await one('SELECT * FROM alarms WHERE alarm_id = ?', alarm.alarm_id);
    return a.state === 'cleared' && a;
  });
  assert.ok(cleared.cleared_at >= alarm.raised_at);
  await waitFor('the incident resolved', () => sn.state.incidents.get(inc.sys_id)?.state === '6');
  const clr = await waitFor('the clear at the Portal', () => portal.of('POST /api/v1/events').flatMap(b => b.events).find(e => e.alarm_id === alarm.alarm_id && e.kind === 'alarm_clear'));
  assert.strictEqual(clr.local_notified?.itsm, inc.number);
  const hist = await q('SELECT kind, local_notified FROM alarm_events WHERE alarm_id = ? ORDER BY ts', alarm.alarm_id);
  assert.deepStrictEqual(hist.map(h => h.kind), ['alarm_raise', 'alarm_clear']);
});

test('heartbeat: the console sees the collector and its Portal link', { skip }, async () => {
  const c = await waitFor('collector heartbeat', async () => {
    const r = await one(`SELECT * FROM collectors WHERE node_id = 'cap01'`);
    return r?.last_seen && json(r.heartbeat)?.portal?.last_reachable && r;
  });
  const hb = json(c.heartbeat);
  assert.strictEqual(hb.portal.enabled, true);
  assert.strictEqual(hb.devices_total, 1);
  assert.ok(!logs.probe.some(l => /local notify on the Collector/.test(l)), 'the collector does not notify by itself');
});
