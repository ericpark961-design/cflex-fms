// node --test probe-agent/test/distributed.e2e.test.js
//
// WO-INT-012 (D-13): collectors N → FMS → Portal, as real processes — two
// `node probe-agent/src/index.js` (cap01, cap02) and one
// `node apps/console/src/server.js` (app01), nothing mocked between them.
//
//   UPS sim ◀── SNMP ── cap01 (sites HMA-FV)          ─┐
//   UPS sim ◀── SNMP ── cap02 (sites HMA-FV, KUS-IRV) ─┼─ telemetry/events/heartbeat ─▶ app01 (FMS)
//                                                      │                                  │ merge by device_id,
//                                                      │                                  │ one alarm_id
//                                                      └─ nothing else                    └─▶ Portal (mTLS, app01)
//
// Device A (HMA-FV) is seen by both collectors, device B (KUS-IRV) by cap02
// only. What must hold:
//   · site scope: cap01 polls 1 UPS, cap02 polls 2
//   · A is one row in the FMS; the Portal gets its points from both collectors,
//     one device_id, collector_id telling them apart
//   · both collectors raise UPS_ON_BATTERY on A: one FMS alarm, one raise at
//     the Portal (one alarm_id); it clears once, when the last collector clears
//   · a collector has no external path: no Portal URL, key path or proxy in
//     its environment, its code or its installer env file (grep), and the
//     Portal never heard from anything but app01
//
// Stand-ins as in console.e2e.test.js: a TLS front for nginx, mini-redis,
// embedded-postgres, the mTLS mock Portal, sim/sim-ups.js for the NMC.
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
const { startMiniRedis } = require('../../apps/console/test/support/mini-redis');
const pgt = require('../../apps/console/test/support/pg');

const ROOT = path.resolve(__dirname, '../..');
const resolves = (mod, from) => { try { require.resolve(mod, { paths: [from] }); return true; } catch { return false; } };
const skip = !hasOpenssl() ? 'openssl CLI not available'
  : !resolves('better-sqlite3', __dirname) ? 'probe-agent dependencies not installed (npm install in probe-agent)'
  : !resolves('pg', path.join(ROOT, 'apps/console/src')) ? 'console dependencies not installed (npm install in apps/console)'
  : pgt.unavailable || false;

const COMMUNITY = 'e2e-ro-community';
const id = (site, serial) => crypto.createHash('sha1').update(`TEST|${site}|${serial}`).digest('hex').slice(0, 16);
const A = id('HMA-FV', 'AS2535281781');
const B = id('KUS-IRV', 'AS2535281799');

let tmp, certs, redis, portal, front, consoleDb, pg;
const procs = {};
const envs = {};
const logs = { console: [], cap01: [], cap02: [], sim: [] };

const freeTcp = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const freeUdp = () => new Promise((r) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

function run(name, file, env) {
  envs[name] = env;
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
      const tail = (n) => logs[n].slice(-12).join('\n    ');
      throw new Error(`timed out waiting for ${what}\n  console:\n    ${tail('console')}\n  cap01:\n    ${tail('cap01')}\n  cap02:\n    ${tail('cap02')}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

const q = (sql, ...a) => consoleDb.all(sql, ...a);
const one = (sql, ...a) => consoleDb.one(sql, ...a);
const sentEvents = () => portal.of('POST /api/v1/events').flatMap(b => b.events);
const sentPoints = () => portal.of('POST /api/v1/telemetry').flatMap(b => b.points);

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-dist-e2e-'));
  certs = makeCerts();
  redis = await startMiniRedis();
  portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  pg = await pgt.start();
  const dbConn = pg.conn();

  // ── the FMS store: two sites, one UPS each, a key per collector ──────────
  const secretKey = path.join(tmp, 'console.key');
  fs.writeFileSync(secretKey, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  {
    const db = await require('../../apps/console/src/db').open(dbConn);
    const { createSettings } = require('../../apps/console/src/settings');
    const { createSealer } = require('../../apps/console/src/seal');
    const settings = createSettings(db, { sealer: createSealer(fs.readFileSync(secretKey, 'utf8')), tenant: 'TEST' });
    await settings.putSite('HMA-FV', { name: 'HMA Fountain Valley' });
    await settings.putSite('KUS-IRV', { name: 'KUS Irvine' });
    const a = (await settings.saveDevice({ site_id: 'HMA-FV', label: 'HMA-UPS-1W-B', vendor: 'APC', model: 'SRT5KRMXLT', serial: 'AS2535281781', nmc_ip: '127.0.0.1' })).device;
    const b = (await settings.saveDevice({ site_id: 'KUS-IRV', label: 'KUS-UPS-IDF', vendor: 'APC', model: 'SRT5KRMXLT', serial: 'AS2535281799', nmc_ip: '127.0.0.1' })).device;
    assert.deepStrictEqual([a.device_id, b.device_id], [A, B]);
    for (const site of ['HMA-FV', 'KUS-IRV']) await settings.putCredential({ site_id: site, version: '2c', community: COMMUNITY }, 'e2e');
    for (const n of ['cap01', 'cap02']) fs.writeFileSync(path.join(tmp, `${n}.key`), (await settings.issueCollectorKey(n)).key + '\n', { mode: 0o600 });
    await db.close();
  }

  // ── the FMS (app01): the only node with a Portal link ────────────────────
  const consolePort = await freeTcp();
  run('console', path.join(ROOT, 'apps/console/src/server.js'), {
    CONSOLE_NODE_ID: 'app01', CONSOLE_BIND: '127.0.0.1', CONSOLE_PORT: String(consolePort),
    CFLEX_DB_URL: dbConn.url, CFLEX_DB_PASSWORD_FILE: dbConn.passwordFile,
    REDIS_URL: redis.url, CONSOLE_SECRET_KEY_FILE: secretKey, CFLEX_TENANT: 'TEST', CONSOLE_COOKIE_SECURE: '0', CONSOLE_TWIN_DIR: tmp,
    CFLEX_PORTAL_URL: portal.url, CFLEX_TLS_CERT: certs.client.certPath, CFLEX_TLS_KEY: certs.client.keyPath, CFLEX_TLS_CA: certs.caPath,
    CFLEX_PORTAL_HEARTBEAT_MS: '1000', CFLEX_PORTAL_FLUSH_MS: '300', CFLEX_PORTAL_INVENTORY_MS: '2000',
  });
  await waitFor('console /healthz', () => fetch(`http://127.0.0.1:${consolePort}/healthz`).then(r => r.ok));
  consoleDb = await require('../../apps/console/src/db').open(dbConn, { migrate: false, partitions: false });

  front = https.createServer(certs.server, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: consolePort, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise(r => front.listen(0, '127.0.0.1', r));

  // ── the UPS (both devices answer from the one simulator) ─────────────────
  const snmpPort = await freeUdp();
  run('sim', path.join(ROOT, 'probe-agent/sim/sim-ups.js'), { SNMP_PORT: String(snmpPort), SNMP_COMMUNITY: COMMUNITY, OUTPUT: 'battery' });
  await waitFor('UPS simulator', () => logs.sim.some(l => /udp\//.test(l)));

  // ── two collectors: what an installer renders into collector.env, nothing more ──
  for (const [n, sites] of [['cap01', 'HMA-FV'], ['cap02', 'HMA-FV,KUS-IRV']]) {
    run(n, path.join(ROOT, 'probe-agent/src/index.js'), {
      TENANT_ID: 'TEST', CFLEX_NODE_ID: n, CFLEX_SITE_ID: 'HMA-FV', CFLEX_COLLECTOR_SITES: sites,
      CFLEX_CONSOLE_URL: `https://localhost:${front.address().port}`,
      CFLEX_CONSOLE_KEY_FILE: path.join(tmp, `${n}.key`), CFLEX_CONSOLE_CA: certs.caPath,
      BUFFER_DB_PATH: path.join(tmp, `${n}-buffer.db`),
      CFLEX_TRAP_PORT: String(await freeUdp()), CFLEX_TRAP_BIND: '127.0.0.1',
      POLL_INTERVAL_MS: '1500', HEARTBEAT_INTERVAL_MS: '1000', TELEMETRY_FLUSH_MS: '1000', CONFIG_RELOAD_MS: '3000',
      SNMP_PORT: String(snmpPort), SNMP_TIMEOUT_MS: '1000', SNMP_RETRIES: '0',
    });
  }
});

test.after(async () => {
  if (skip) return;
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  await Promise.all(Object.values(procs).map(p => (p.exitCode != null ? null : new Promise(r => p.once('exit', r)))));
  await consoleDb?.close();
  await pg?.stop();
  front?.closeAllConnections?.(); front?.close();
  await Promise.all([redis.close(), portal.close()]);
  certs.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('site scope: cap01 polls only HMA-FV (1 UPS), cap02 HMA-FV and KUS-IRV (2 UPS)', { skip }, async () => {
  await waitFor('cap01 inventory', () => logs.cap01.some(l => /loaded 1 UPS from the Local Console/.test(l)));
  await waitFor('cap02 inventory', () => logs.cap02.some(l => /loaded 2 UPS from the Local Console/.test(l)));
  assert.ok(!logs.cap01.some(l => /loaded 2 UPS/.test(l)));
});

test('device merge: A is one row, fed by both collectors; the Portal gets A from cap01 and cap02 under one device_id, B from cap02 only', { skip }, async () => {
  await waitFor('A from both collectors at the Portal', () => {
    const by = new Set(sentPoints().filter(p => p.device_id === A).map(p => p.collector_id));
    return by.has('cap01') && by.has('cap02');
  });
  await waitFor('B at the Portal', () => sentPoints().some(p => p.device_id === B));
  assert.deepStrictEqual([...new Set(sentPoints().filter(p => p.device_id === B).map(p => p.collector_id))], ['cap02']);
  assert.deepStrictEqual((await q('SELECT device_id FROM devices ORDER BY site_id')).map(d => d.device_id), [A, B], 'one row per device');
  const a = await one('SELECT * FROM devices WHERE device_id = ?', A);
  assert.strictEqual(a.ups_status, 'on_battery', 'the latest reading, whichever collector took it');
  // Inventory: the FMS's two devices, once each.
  const inv = await waitFor('inventory at the Portal', () => portal.of('PUT /api/v1/inventory').at(-1));
  assert.deepStrictEqual(inv.devices.map(d => d.device_id).sort(), [A, B].sort());
  for (const b of portal.of('POST /api/v1/telemetry')) assert.strictEqual(b.node_id, 'app01');
});

let fmsAlarm;
test('alarm merge: both collectors raise UPS_ON_BATTERY on A → one FMS alarm, one raise at the Portal, one alarm_id', { skip }, async () => {
  fmsAlarm = await waitFor('two collectors behind A\'s alarm', async () => {
    const rows = await q(`SELECT * FROM alarms WHERE device_id = ? AND code = 'UPS_ON_BATTERY'`, A);
    if (rows.length !== 1) return null;
    const srcs = await q('SELECT collector_id, state FROM alarm_sources WHERE alarm_id = ? ORDER BY collector_id', rows[0].alarm_id);
    return srcs.length === 2 && rows[0];
  });
  assert.strictEqual(fmsAlarm.state, 'open');
  assert.deepStrictEqual((await q('SELECT collector_id, state FROM alarm_sources WHERE alarm_id = ? ORDER BY collector_id', fmsAlarm.alarm_id))
    .map(s => [s.collector_id, s.state]), [['cap01', 'open'], ['cap02', 'open']]);
  assert.strictEqual((await q(`SELECT * FROM alarms WHERE device_id = ? AND code = 'UPS_ON_BATTERY'`, A)).length, 1, 'still one row');

  const raises = await waitFor('the raise at the Portal', () => {
    const r = sentEvents().filter(e => e.device_id === A && e.code === 'UPS_ON_BATTERY' && e.kind === 'alarm_raise');
    return r.length && r;
  });
  assert.strictEqual(raises.length, 1, 'one raise, not one per collector');
  assert.strictEqual(raises[0].alarm_id, fmsAlarm.alarm_id);
  assert.ok(['cap01', 'cap02'].includes(raises[0].collector_id));
  // B: cap02's alone.
  const b = await waitFor('B\'s alarm', () => sentEvents().find(e => e.device_id === B && e.kind === 'alarm_raise'));
  assert.strictEqual(b.collector_id, 'cap02');
  // Every alarm_id the Portal got for A's on-battery is the FMS's one.
  assert.deepStrictEqual([...new Set(sentEvents().filter(e => e.device_id === A && e.code === 'UPS_ON_BATTERY').map(e => e.alarm_id))], [fmsAlarm.alarm_id]);
});

test('clear: back on line, the alarm clears once — when the last collector clears it — with the same alarm_id', { skip }, async () => {
  procs.sim.stdin.write('online\n');
  await waitFor('A cleared in the FMS', async () => (await one('SELECT state FROM alarms WHERE alarm_id = ?', fmsAlarm.alarm_id)).state === 'cleared');
  assert.deepStrictEqual((await q('SELECT state FROM alarm_sources WHERE alarm_id = ?', fmsAlarm.alarm_id)).map(s => s.state), ['cleared', 'cleared'],
    'cleared only once both collectors cleared it');
  const clears = await waitFor('the clear at the Portal', () => {
    const c = sentEvents().filter(e => e.alarm_id === fmsAlarm.alarm_id && e.kind === 'alarm_clear');
    return c.length && c;
  });
  assert.strictEqual(clears.length, 1, 'one clear');
  // The FMS's history has both collectors' events, under the one alarm.
  const hist = await q('SELECT kind, collector_id FROM alarm_events WHERE alarm_id = ? ORDER BY ts', fmsAlarm.alarm_id);
  assert.deepStrictEqual([...new Set(hist.map(h => h.collector_id))].sort(), ['cap01', 'cap02']);
});

test('heartbeat: app01 sends its own and relays each collector (collector_id); the Portal hears from app01 only', { skip }, async () => {
  await waitFor('both collectors relayed', () => {
    const c = new Set(portal.of('POST /api/v1/heartbeat').filter(b => b.role === 'collector').map(b => b.collector_id));
    return c.has('cap01') && c.has('cap02');
  });
  const beats = portal.of('POST /api/v1/heartbeat');
  assert.ok(beats.some(b => b.role === 'app' && b.node_id === 'app01' && !('collector_id' in b)));
  assert.ok(beats.every(b => b.node_id === 'app01'), 'node_id is the sending node');
  assert.ok(portal.state.requests.length > 0);
  assert.ok(portal.state.requests.every(r => r.peerCN === 'TEST.app01' && r.headers['x-cflex-node'] === 'app01'), 'no collector ever reached the Portal');
});

test('no external path on a collector (D-13): its environment, its code and its installer env file carry no Portal URL, key path or proxy', { skip }, async () => {
  const OUTSIDE = /PORTAL|TLS_CERT|TLS_KEY|TLS_CA|PROXY|CFLEX_URL|CFLEX_TOKEN|LEGACY/i;
  for (const n of ['cap01', 'cap02']) {
    assert.deepStrictEqual(Object.keys(envs[n]).filter(k => OUTSIDE.test(k)), [], `${n} environment`);
    assert.ok(!logs[n].some(l => /cflex\.fms\.support|\/api\/v1\//.test(l)), `${n} log`);
  }
  // The code the collector runs: no Portal URL or path, no setting that would name one, no proxy setting.
  const CODE = /cflex\.fms\.support|40\.114\.79\.164|runless|\/api\/v1\/|CFLEX_PORTAL|CFLEX_TLS_|HTTPS_PROXY|https_proxy|NO_PROXY|CFLEX_LEGACY|CFLEX_TOKEN|CFLEX_URL\b/;
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const hits = [];
  for (const f of files(path.join(ROOT, 'probe-agent/src'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (CODE.test(l)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepStrictEqual(hits, [], 'probe-agent/src');
  const env = fs.readFileSync(path.join(ROOT, 'install/templates/env/collector.env'), 'utf8');
  assert.deepStrictEqual(env.split('\n').filter(l => /PORTAL|MTLS|TLS_CERT|TLS_KEY|PROXY|CFLEX_URL|fms\.support/.test(l)), [], 'collector.env template');
});
