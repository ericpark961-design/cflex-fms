// node --test probe-agent/test/modbus.e2e.test.js
//
// WO-INT-017 §5 E2E: a CRAC and a contact module on one Modbus TCP simulator
// → the collector's real poll cycle → the Local Console's collector API.
//
//   sim-modbus (unit 1 CRAC, unit 2 contacts, one port — a gateway's shape)
//        ▲  fc 3/4/2 reads, one connection, sequential
//   collector  node -r test/support/object-feed.js src/index.js
//        │  POST /collector/v1/telemetry (collector key, TLS)
//        ▼
//   console    node apps/console/src/server.js → PostgreSQL `telemetry`
//
// The harness is console.e2e.test.js's: the same processes and stand-ins
// (embedded PostgreSQL, mini-redis, a TLS front for nginx with a test CA), set
// up the way an admin would through Settings. Two differences, both because
// the console has no non-UPS device feed yet (forwarder.fetchObjectConfig()
// returns [], Q-2026-10-26-14):
//   · the collector gets its two Modbus devices from a test-only preload
//     (support/object-feed.js) — the cycle, collectors and forwarder are the
//     production code;
//   · the console knows the two devices (so it stores their points) with
//     polling disabled, so its UPS inventory does not hand them to the UPS
//     poller.
// No Portal: the point here is collector → console.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { makeCerts, hasOpenssl } = require('./support/certs');
const { startMiniRedis } = require('../../apps/console/test/support/mini-redis');
const pgt = require('../../apps/console/test/support/pg');

const ROOT = path.resolve(__dirname, '../..');
const resolves = (mod, from) => { try { require.resolve(mod, { paths: [from] }); return true; } catch { return false; } };
const skip = !hasOpenssl() ? 'openssl CLI not available'
  : !resolves('better-sqlite3', __dirname) ? 'probe-agent dependencies not installed (npm install in probe-agent)'
  : !resolves('pg', path.join(ROOT, 'apps/console/src')) ? 'console dependencies not installed (npm install in apps/console)'
  : pgt.unavailable || false;

const TENANT = 'TEST';
const SITE = 'LAB-CCR';
const CRAC_SERIAL = 'SIMCRAC0001';
const DIO_SERIAL = 'SIMDIO0001';
const idOf = (serial) => crypto.createHash('sha1').update(`${TENANT}|${SITE}|${serial}`).digest('hex').slice(0, 16);

let tmp, certs, redis, front, consoleDb, pg;
const procs = {};
const logs = { console: [], probe: [], sim: [] };

const freeTcp = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

function run(name, args, env) {
  const p = spawn(process.execPath, args, { cwd: tmp, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-modbus-e2e-'));
  certs = makeCerts();
  redis = await startMiniRedis();
  pg = await pgt.start();
  const dbConn = pg.conn();

  const secretKey = path.join(tmp, 'console.key');
  fs.writeFileSync(secretKey, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  {
    const db = await require('../../apps/console/src/db').open(dbConn);
    const { createSettings } = require('../../apps/console/src/settings');
    const { createSealer } = require('../../apps/console/src/seal');
    const settings = createSettings(db, { sealer: createSealer(fs.readFileSync(secretKey, 'utf8')), tenant: TENANT });
    await settings.putSite(SITE, { name: 'Lab CCR (simulator)', company: 'LAB' });
    for (const [label, serial, model] of [['CRAC-SIM-1', CRAC_SERIAL, 'sim-crac'], ['FIRE-DIO-SIM', DIO_SERIAL, 'sim-dio']]) {
      const { device } = await settings.saveDevice({ site_id: SITE, label, vendor: 'Simulator', model, serial, polling_enabled: false });
      assert.strictEqual(device.device_id, idOf(serial));
    }
    fs.writeFileSync(path.join(tmp, 'collector.key'), (await settings.issueCollectorKey('cap01')).key + '\n', { mode: 0o600 });
    await db.close();
  }

  const consolePort = await freeTcp();
  run('console', [path.join(ROOT, 'apps/console/src/server.js')], {
    CONSOLE_NODE_ID: 'app01', CONSOLE_BIND: '127.0.0.1', CONSOLE_PORT: String(consolePort),
    CFLEX_DB_URL: dbConn.url, CFLEX_DB_PASSWORD_FILE: dbConn.passwordFile,
    REDIS_URL: redis.url, CONSOLE_SECRET_KEY_FILE: secretKey, CFLEX_TENANT: TENANT, CONSOLE_COOKIE_SECURE: '0',
    CONSOLE_TWIN_DIR: tmp,
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

  // The devices: one simulator, two unit IDs. Cooling in STANDBY, fire alarm contact closed.
  const modbusPort = await freeTcp();
  run('sim', [path.join(ROOT, 'probe-agent/sim/sim-modbus.js')], {
    MODBUS_PORT: String(modbusPort), SUPPLY_C: '18.3', RETURN_C: '26.5', COOLING: 'standby', DIO_INPUTS: '1,0,0,0',
  });
  await waitFor('Modbus simulator', () => logs.sim.some(l => /tcp\//.test(l)));

  const objects = [
    { id: 'crac-sim-1', name: 'CRAC-SIM-1', kind: 'crac', ip: '127.0.0.1', site_id: SITE, serial: CRAC_SERIAL,
      attrs: { protocol: 'modbus-tcp', modbus: { unit_id: 1, profile: 'sim-crac' } } },
    { id: 'fire-dio-sim', name: 'FIRE-DIO-SIM', kind: 'dio', ip: '127.0.0.1', site_id: SITE, serial: DIO_SERIAL,
      attrs: { protocol: 'modbus-tcp', modbus: { unit_id: 2, type: 'discrete', address_base: 0 },
        inputs: [
          { channel: 0, metric: 'fire_alarm', active_state: 'closed', label: 'FM-200 Alarm' },
          { channel: 1, metric: 'fire_trouble', active_state: 'closed' },
          { channel: 2, metric: 'fire_predischarge', active_state: 'closed' },
          { channel: 3, metric: 'fire_discharge', active_state: 'closed' },
        ] } },
  ];
  run('probe', ['-r', path.join(__dirname, 'support/object-feed.js'), path.join(ROOT, 'probe-agent/src/index.js')], {
    TENANT_ID: TENANT, CFLEX_NODE_ID: 'cap01', CFLEX_SITE_ID: SITE,
    CFLEX_CONSOLE_URL: `https://localhost:${front.address().port}`,
    CFLEX_CONSOLE_KEY_FILE: path.join(tmp, 'collector.key'), CFLEX_CONSOLE_CA: certs.caPath,
    BUFFER_DB_PATH: path.join(tmp, 'buffer.db'), CFLEX_TRAP_ENABLED: '0',
    POLL_INTERVAL_MS: '1500', HEARTBEAT_INTERVAL_MS: '1000', TELEMETRY_FLUSH_MS: '1000', CONFIG_RELOAD_MS: '3000',
    // The device rows carry no port: the config block's default (MODBUS_PORT) applies.
    MODBUS_PORT: String(modbusPort), MODBUS_TIMEOUT_MS: '1000', MODBUS_RETRIES: '0',
    E2E_OBJECTS: JSON.stringify(objects),
  });
});

test.after(async () => {
  if (skip) return;
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  await Promise.all(Object.values(procs).map(p => (p.exitCode != null ? null : new Promise(r => p.once('exit', r)))));
  await consoleDb?.close();
  await pg?.stop();
  front?.closeAllConnections?.(); front?.close();
  await redis.close();
  certs.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const latestM = async (deviceId) => {
  const r = await consoleDb.one('SELECT m FROM telemetry WHERE device_id = ? AND comm_ok = 1 ORDER BY ts DESC LIMIT 1', deviceId);
  return r && (typeof r.m === 'string' ? JSON.parse(r.m) : r.m);
};

test('sim-modbus CRAC + DIO → collector cycle → console collector API stores metrics for both', { skip }, async () => {
  await waitFor('collector loaded the two Modbus objects', () => logs.probe.some(l => /loaded 2 objects — crac:1 dio:1/.test(l)));
  const crac = await waitFor('CRAC metrics in the console', () => latestM(idOf(CRAC_SERIAL)));
  assert.strictEqual(crac.supply_temp_c, 18.3);
  assert.strictEqual(crac.return_temp_c, 26.5);
  assert.strictEqual(crac.delta_t_c, 8.2, 'derived on the Modbus path');
  assert.strictEqual(crac.state_cooling, 2, 'the state code, as on the SNMP path (2 = standby in sim-crac.json)');
  assert.strictEqual(crac.cooling_available, 0, 'a standby unit is not cooling-available');
  assert.strictEqual(crac.comm_ok, true);

  const dio = await waitFor('DIO metrics in the console', () => latestM(idOf(DIO_SERIAL)));
  assert.deepStrictEqual([dio.fire_alarm, dio.fire_trouble, dio.fire_predischarge, dio.fire_discharge], [1, 0, 0, 0]);

  // The cycle reported them as metrics, not as failures or unsupported.
  await waitFor('a clean cycle', () => logs.probe.some(l => /cycle: 2 ok, 0 fail/.test(l)));
});

test('the simulator received no write request from the collector', { skip }, async () => {
  procs.sim.kill('SIGTERM');
  await new Promise(r => (procs.sim.exitCode != null ? r() : procs.sim.once('exit', r)));
  assert.ok(logs.sim.some(l => /0 write requests received/.test(l)), logs.sim.slice(-5).join('\n'));
  assert.ok(!logs.sim.some(l => /WRITE REQUEST RECEIVED/.test(l)));
});
