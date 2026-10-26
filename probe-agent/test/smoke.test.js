// node --test probe-agent/test/smoke.test.js        (npm run smoke)
//
// WO-INT-007: `node src/index.js` started for real, the way systemd/Quadlet
// start it — no module loaded into the test process, nothing mocked inside.
// The open item from PM review 3: index.js had never been booted on its own.
//
//   inventory stub (127.0.0.1) ── 1 UPS ──▶ index.js ── SNMP get ──▶ sim/sim-ups.js (on battery)
//   index.js ── inventory, UPS_ON_BATTERY raise, telemetry ──▶ Portal = a closed 127.0.0.1 port
//                                                           └──▶ buffer.db (store-and-forward)
//
// What it shows: the process boots, finishes poll cycles, writes what the
// Portal could not take into the SQLite buffer (with the alarm engine's open
// alarm in the same file), the container HEALTHCHECK (bin/cflex-healthcheck.js)
// turns healthy, and SIGTERM ends it with exit 0 and an intact database.
//
// Without a Local Console the inventory comes from the old-cloud pull
// (forwarder.legacyGet, HTTPS); here that is a 127.0.0.1 stub with a test CA
// the process is told to trust through NODE_EXTRA_CA_CERTS. Nothing leaves
// 127.0.0.1: the Portal URL, the inventory URL, the UPS and the trap port are
// all local, the environment is only PATH plus what is set here (no proxy),
// and SNMP is read-only (D-05).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn, execFile } = require('node:child_process');
const { makeCerts, hasOpenssl } = require('./support/certs');

const AGENT = path.resolve(__dirname, '..');
const hasSqlite = (() => { try { require.resolve('better-sqlite3'); return true; } catch { return false; } })();
const skip = !hasOpenssl() ? 'openssl CLI not available'
  : !hasSqlite ? 'probe-agent dependencies not installed (npm install in probe-agent)' : false;

const COMMUNITY = 'smoke-ro';
const UPS = { id: 1, name: 'SMOKE-UPS-1', kind: 'ups', site_id: 'TEST-SITE', ip: '127.0.0.1',
  vendor: 'APC', model: 'SRT5KRMXLT', serial: 'SMOKE0000001', snmp_version: 'v2c', snmp_community: COMMUNITY };

const freeTcp = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const freeUdp = () => new Promise((r) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

let tmp, stub, probe, sim, env;
const logs = { probe: [], sim: [] };
const pulls = [];

function run(name, args, e) {
  const p = spawn(process.execPath, args, { cwd: tmp, env: { PATH: process.env.PATH, ...e }, stdio: ['pipe', 'pipe', 'pipe'] });
  const keep = (b) => { for (const l of String(b).split('\n')) if (l.trim()) logs[name].push(l); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.exited = new Promise(r => p.on('exit', (code, signal) => r({ code, signal })));
  return p;
}

async function waitFor(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n  probe:\n    ${logs.probe.slice(-20).join('\n    ')}\n  sim:\n    ${logs.sim.slice(-5).join('\n    ')}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const healthcheck = () => new Promise((resolve) => execFile(process.execPath, [path.join(AGENT, 'bin/cflex-healthcheck.js')],
  { env: { PATH: process.env.PATH, CFLEX_HEALTH_FILE: env.CFLEX_HEALTH_FILE, POLL_INTERVAL_MS: env.POLL_INTERVAL_MS } },
  (err, stdout) => resolve({ code: err ? err.code : 0, out: stdout.trim() })));

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-smoke-'));

  const snmpPort = await freeUdp();
  sim = run('sim', [path.join(AGENT, 'sim/sim-ups.js')], { SNMP_PORT: String(snmpPort), SNMP_COMMUNITY: COMMUNITY, OUTPUT: 'battery' });
  await waitFor('sim-ups', () => logs.sim.some(l => l.includes('[sim-ups]')));

  const certs = makeCerts();
  stub = https.createServer(certs.server, (req, res) => {
    pulls.push({ url: req.url, key: req.headers['x-probe-key'] });
    if (req.url.startsWith('/v1/probe/devices')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ devices: [{ ...UPS, snmp_port: snmpPort }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));

  env = {
    TENANT_ID: 'TEST', CFLEX_NODE_ID: 'cap-smoke', CFLEX_SITE_ID: 'TEST-SITE',
    CFLEX_URL: `https://127.0.0.1:${stub.address().port}`, NODE_EXTRA_CA_CERTS: certs.caPath, CFLEX_TOKEN: 'smoke-not-a-secret',
    CFLEX_PORTAL_URL: `https://127.0.0.1:${await freeTcp()}`,           // nothing listens: every send fails → buffer
    BUFFER_DB_PATH: path.join(tmp, 'queue/buffer.db'),
    CFLEX_HEALTH_FILE: path.join(tmp, 'health.json'),
    CFLEX_ITSM_STORE: path.join(tmp, 'queue/itsm-map.json'),
    CFLEX_ID_STORE: path.join(tmp, 'queue/device-ids.json'),
    CFLEX_TRAP_PORT: String(await freeUdp()), CFLEX_TRAP_BIND: '127.0.0.1', // the WO-INT-006 listener, once merged
    POLL_INTERVAL_MS: '2000', HEARTBEAT_INTERVAL_MS: '2000', TELEMETRY_FLUSH_MS: '1000',
    SNMP_TIMEOUT_MS: '1000', SNMP_RETRIES: '0',
  };
});

test.after(async () => {
  for (const p of [probe, sim]) if (p && p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await p.exited; }
  if (stub) await new Promise(r => stub.close(r));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('healthcheck before any cycle: unhealthy', { skip }, async () => {
  const r = await healthcheck();
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /^unhealthy: no cycle finished yet/);
});

test('index.js boots, pulls the inventory and finishes poll cycles against the simulator', { skip }, async () => {
  probe = run('probe', [path.join(AGENT, 'src/index.js')], env);
  await waitFor('inventory', () => logs.probe.some(l => /\[probe\] loaded 1 UPS from cflex/.test(l)));
  assert.ok(pulls.some(p => p.url.startsWith('/v1/probe/devices?tenant=TEST') && p.key === env.CFLEX_TOKEN));
  // Two cycles, each 1 ok / 0 fail: the SNMP session works, not just the timer.
  await waitFor('two poll cycles', () => logs.probe.filter(l => /\[probe\] cycle: 1 ok, 0 fail/.test(l)).length >= 2);
  assert.ok(!logs.probe.some(l => /fatal bootstrap|uncaught|unhandled rejection/.test(l)), logs.probe.join('\n'));
});

test('healthcheck after a cycle: healthy', { skip }, async () => {
  const r = await healthcheck();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^healthy: last cycle \d+s ago/);
});

test('the buffer holds what the Portal could not take, and the open alarm', { skip }, async () => {
  const Database = require('better-sqlite3');
  const rows = await waitFor('buffered inventory, events and telemetry', () => {
    const db = new Database(env.BUFFER_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const r = db.prepare(`SELECT json_extract(payload, '$.name') AS name, COUNT(*) AS n, MAX(attempts) AS tries, MAX(last_error) AS err
        FROM events WHERE kind = 'portal' GROUP BY 1`).all();
      const by = Object.fromEntries(r.map(x => [x.name, x]));
      return by.inventory && by.events && by.telemetry && by.inventory.tries > 0 ? by : null;
    } finally { db.close(); }
  });
  // The forwarder did try 127.0.0.1 and kept the rows when it failed.
  assert.match(rows.inventory.err, /ECONNREFUSED/);
  const db = new Database(env.BUFFER_DB_PATH, { readonly: true });
  try {
    const raise = db.prepare(`SELECT payload FROM events WHERE kind = 'portal' AND json_extract(payload, '$.name') = 'events'`).all()
      .flatMap(r => JSON.parse(r.payload).body.events).find(e => e.kind === 'alarm_raise');
    assert.strictEqual(raise.code, 'UPS_ON_BATTERY');
    const pts = db.prepare(`SELECT payload FROM events WHERE kind = 'portal' AND json_extract(payload, '$.name') = 'telemetry'`).all()
      .flatMap(r => JSON.parse(r.payload).body.points);
    assert.ok(pts.length > 0 && pts.every(p => p.device_id === raise.device_id));
    const st = JSON.parse(db.prepare(`SELECT value FROM state WHERE name = 'alarm_engine'`).get().value);
    assert.deepStrictEqual(st.open.map(a => a.alarm_id), [raise.alarm_id]);
  } finally { db.close(); }
});

test('SIGTERM: exit 0, promptly, and the buffer file is intact', { skip }, async () => {
  const t0 = Date.now();
  probe.kill('SIGTERM');
  const { code, signal } = await probe.exited;
  assert.deepStrictEqual({ code, signal }, { code: 0, signal: null });
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(logs.probe.some(l => l.includes('[probe] SIGTERM received, exiting')));
  const db = new (require('better-sqlite3'))(env.BUFFER_DB_PATH, { readonly: true });
  try {
    assert.strictEqual(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(db.prepare(`SELECT COUNT(*) AS c FROM events`).get().c > 0, 'buffered rows survive the exit');
  } finally { db.close(); }
});
