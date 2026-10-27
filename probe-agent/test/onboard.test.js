// node --test probe-agent/test/onboard.test.js
//
// WO-INT-014: cflex-onboard against the NMC CLI simulator (test/sim/nmc-cli-sim.js)
// on 127.0.0.1 only. Inventory addresses are 192.0.2.x (documentation range)
// and are mapped to the simulators' loopback ports; nothing else is dialed.
// Every credential below is a test value, not any site's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const snmp = require('net-snmp');

const { main } = require('../bin/cflex-onboard');
const commands = require('../src/onboard/commands');
const { loads } = require('../src/onboard/yaml-lite');
const credsLib = require('../src/onboard/credentials');
const targetsLib = require('../src/onboard/targets');
const { createSshTransport } = require('../src/onboard/transport-ssh');
const { createHttpsTransport } = require('../src/onboard/transport-https');
const reader = require('../src/onboard/reader');
const { desiredFor, plan } = require('../src/onboard/planner');
const { createVerifier } = require('../src/onboard/verifier');
const { scan, expandCidr } = require('../src/onboard/scanner');
const report = require('../src/onboard/report');
const { startNmcSim, render } = require('./sim/nmc-cli-sim');
const { makeCerts, hasOpenssl } = require('./support/certs');

// Test-only values. Long and distinctive so a leak is unambiguous.
const S = {
  user: 'sim-admin',
  login: 'sim-login-pw-7f3a19',
  auth: 'test-auth-phrase-9c1d',
  priv: 'test-priv-phrase-4e2b',
  consolePw: 'console-pw-test-55aa',
  overrideLogin: 'sim-override-pw-31bc',
};
const LOGIN = { user: S.user, password: S.login };
const COLLECTOR = '192.0.2.66';
const SITE = 'TEST-A';
const DESIRED = { user: 'cflex-ro', authKey: S.auth, privKey: S.priv, nms: COLLECTOR };
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-onboard-')); }

function capture() {
  const lines = [];
  const f = (...a) => lines.push(a.join(' '));
  return { lines, log: { log: f, info: f, warn: f, error: f } };
}

function stubPrompt(answers = []) {
  const asked = [];
  return { tty: false, asked, ask: async () => '', secret: async () => '', confirm: async (q) => { asked.push(q); return answers.length ? answers.shift() : true; } };
}

const ENV = { T_LOGIN: S.login, T_AUTH: S.auth, T_PRIV: S.priv, T_CONSOLE: S.consolePw, T_OVR: S.overrideLogin };

function writeCreds(dir, { overrides = '', consoleBlock = false, mode = 0o600 } = {}) {
  const file = path.join(dir, 'onboard-credentials.yaml');
  fs.writeFileSync(file, [
    `defaults: { user: ${S.user}, password: ref:T_LOGIN, transport: ssh }`,
    'snmpv3: { auth_key: ref:T_AUTH, priv_key: ref:T_PRIV }',
    ...(overrides ? ['overrides:', overrides] : []),
    ...(consoleBlock ? ['console: { user: operator1, password: ref:T_CONSOLE }'] : []),
  ].join('\n') + '\n');
  fs.chmodSync(file, mode);
  return file;
}

function writeSiteYaml(dir, targetsFile, extra = '') {
  const file = path.join(dir, 'site.yaml');
  fs.writeFileSync(file, `tenant: { code: TEST, timezone: America/Los_Angeles }
hosts:
  collectors: [{ id: cap01, ip: ${COLLECTOR}, sites: [${SITE}] }]
  app: [{ id: app01, ip: 192.0.2.67, role: active }]
nmc:
  targets_file: ${targetsFile}
onboard:
  snmpv3: { user: cflex-ro, auth: sha, priv: aes }
${extra}`);
  return file;
}

/** Simulators + an inventory CSV of 192.0.2.n + a sim map. */
async function rig(specs, { https = null } = {}) {
  const dir = tmp();
  const sims = [];
  for (const s of specs) sims.push(await startNmcSim({ login: LOGIN, desired: DESIRED, https, ...s }));
  const csv = path.join(dir, 'inventory.csv');
  fs.writeFileSync(csv, 'site,unit,nmc_ip,model,serial,firmware\n' + sims.map((s, i) => `${SITE},UNIT-${i + 1},${s.ip},${specs[i].invModel || 'SRT5KRMXLT'},${specs[i].invSerial || s.state.ups.serial},UPS 16.9 (ID1044)`).join('\n') + '\n');
  const simMap = Object.fromEntries(sims.map(s => [s.ip, { host: '127.0.0.1', ssh: s.sshPort, snmp: s.snmpPort, https: s.httpsPort }]));
  const creds = writeCreds(dir);
  const site = writeSiteYaml(dir, csv);
  const out = path.join(dir, 'out');
  const run = (cmd, extra = [], deps = {}) => main([cmd, '--site-yaml', site, '--credentials', creds, '--out', out, '--timeout', '5', ...extra],
    { env: ENV, simMap, prompt: deps.prompt || stubPrompt(), log: deps.log || quiet, settleMs: 20, getTries: 2, snmpTimeoutMs: 800, snmpRetries: 0, ...deps });
  const stop = () => Promise.all(sims.map(s => s.stop()));
  return { dir, sims, csv, out, run, stop, simMap, credsFile: creds, siteFile: site };
}

const writes = (sim) => sim.commands.filter(c => { try { return commands.check(c, { write: true, policy: { legacy: true, ntp: true } }).kind === 'write'; } catch { return true; } });

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

// ── command whitelist ─────────────────────────────────────────────────────
test('whitelist: reads pass on a read session, writes do not', () => {
  for (const r of reader.READ_ORDER) assert.strictEqual(commands.check(r).kind, 'read');
  assert.strictEqual(commands.check('user -n sim-admin').kind, 'read');
  assert.throws(() => commands.check('snmpv3 -S enable'), /read-only session/);
  assert.strictEqual(commands.check('snmpv3 -S enable', { write: true }).kind, 'write');
});

test('whitelist: forbidden commands are refused — injection included', () => {
  const W = { write: true, policy: { legacy: true, ntp: true } };
  const forbidden = [
    'reboot', 'ups -c off', 'ups -s', 'ups -o off', 'resetToDef -p all', 'format', 'user -n apc -pw x', 'user -n newadmin -pe Administrator',
    'userdflt -n x', 'tcpip -i 192.0.2.99', 'tcpip -s 255.0.0.0', 'dns -p 192.0.2.53', 'firmware', 'web -h enable', 'console -S telnet',
    'snmp -c1 newcommunity', 'snmp -a1 writeplus', 'snmptrap -c1 public', 'ftp -S enable', 'radius', 'delete config.ini',
    'snmpv3 -S enable\rreboot', 'snmpv3 -S enable\nreboot', 'about; reboot', 'about && reboot', ' about', 'about ',
    'snmpv3 -u1 cflex-ro -a1 short -c1 short -ap1 sha -pp1 aes', // phrases too short
    'snmpv3 -u1 cflex-ro -a1 test-auth-phrase-9c1d -c2 test-priv-phrase-4e2b -ap1 sha -pp1 aes', // index mismatch
    'snmptrap -r7 192.0.2.66 -t7 snmpV3 -g7 enable -a7 enable', 'snmpv3 -ac1 enable -au1 cflex-ro -n1 999.0.2.1',
    '', null,
  ];
  for (const c of forbidden) assert.throws(() => commands.check(c, W), (e) => e.code === 'command_refused', String(c));
  // Refusal messages never echo the line (a refused line may carry a phrase).
  try { commands.check(`snmpv3 -u1 x y -a1 ${S.auth}`, W); } catch (e) { assert.ok(!e.message.includes(S.auth)); }
  // Policy-gated forms.
  assert.throws(() => commands.check('snmp -S disable', { write: true }), /--disable-legacy/);
  assert.throws(() => commands.check('ntp -OM enable -p 192.0.2.123', { write: true }), /--set-ntp/);
  assert.ok(commands.check('snmp -S disable', { write: true, policy: { legacy: true } }));
});

test('whitelist: a forbidden line never reaches the simulator', async () => {
  const sim = await startNmcSim({ login: LOGIN, n: 21 });
  try {
    const t = { ip: sim.ip };
    const red = credsLib.createRedactor();
    const ssh = createSshTransport({ gate: targetsLib.createGate([t]), redactor: red, log: quiet, timeoutMs: 5000, endpoint: () => ({ host: '127.0.0.1', port: sim.sshPort }) });
    const s = await ssh.open(t, LOGIN, { write: true, policy: { legacy: true, ntp: true } });
    for (const c of ['reboot', 'ups -c off', 'user -n apc -pw x', 'tcpip -i 192.0.2.99', 'about\rreboot']) {
      await assert.rejects(s.run(c), (e) => e.code === 'command_refused', c);
    }
    await assert.rejects(s.scpGet('../etc/passwd'), /not on the whitelist/);
    assert.ok((await s.run('about')).result.ok);
    s.close();
    assert.deepStrictEqual(sim.forbidden, []);
    assert.ok(!sim.commands.some(c => /reboot|ups|tcpip -i|-pw/.test(c)), sim.commands.join('|'));
  } finally { await sim.stop(); }
});

test('no SNMP SET code path in cflex-onboard', () => {
  const dir = path.join(__dirname, '../src/onboard');
  const srcs = [...fs.readdirSync(dir).map(f => path.join(dir, f)), path.join(__dirname, '../bin/cflex-onboard.js')];
  for (const f of srcs) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\.set\s*\(\s*\[/.test(s), `${f}: session.set([...]) found`);
    assert.ok(!/SetRequest|PduType\.Set/.test(s), `${f}: SetRequest found`);
  }
});

// ── inventory gate ────────────────────────────────────────────────────────
test('inventory gate: an address outside the list gets no packet', async () => {
  const sim = await startNmcSim({ login: LOGIN, n: 22 });
  try {
    const listed = { ip: '192.0.2.200' };
    const ssh = createSshTransport({ gate: targetsLib.createGate([listed]), redactor: credsLib.createRedactor(), log: quiet, timeoutMs: 3000, endpoint: () => ({ host: '127.0.0.1', port: sim.sshPort }) });
    await assert.rejects(ssh.open({ ip: sim.ip }, LOGIN), (e) => e.code === 'not_in_inventory');
    assert.strictEqual(ssh.connections(), 0);
    assert.strictEqual(sim.connections, 0);
    const v = createVerifier({ gate: targetsLib.createGate([listed]), endpoint: () => ({ host: '127.0.0.1', snmpPort: sim.snmpPort }) });
    assert.throws(() => v.snmpV3Get(sim.ip, { v3: { user: 'u', auth: 'sha', priv: 'aes', authKey: S.auth, privKey: S.priv } }), (e) => e.code === 'not_in_inventory');
    // --ip narrows the inventory; it cannot add to it.
    assert.throws(() => targetsLib.mergeTargets([[listed]], { only: ['192.0.2.201'] }), (e) => e.code === 'not_in_inventory');
  } finally { await sim.stop(); }
});

test('targets: IP list, CSV aliases, merge and --max-devices', () => {
  const list = targetsLib.parseTargetsFile('# comment\n192.0.2.11\n192.0.2.12  # inline\n', { source: 'nmc-targets.txt' });
  assert.deepStrictEqual(list.map(t => t.ip), ['192.0.2.11', '192.0.2.12']);
  const csv = targetsLib.parseTargetsFile('Site,Unit,IP Address,Model,Serial\nTEST-A,UPS 1,192.0.2.11,SRT5KRMXLT,TESTUPS00011\nTEST-A,UPS no IP,,SRT3000,X\n', { source: 'exhibit1.csv' });
  assert.deepStrictEqual(csv, [{ ip: '192.0.2.11', source: 'exhibit1.csv', site: 'TEST-A', label: 'UPS 1', model: 'SRT5KRMXLT', serial: 'TESTUPS00011' }]);
  const con = targetsLib.fromConsole([{ nmc_ip: '192.0.2.11', site_id: 'TEST-B', label: 'Console label', device_id: 'abc' }, { nmc_ip: null, label: 'x' }]);
  const m = targetsLib.mergeTargets([list, csv, con]);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].site, 'TEST-B'); // the console wins
  assert.deepStrictEqual(m[0].sources, ['nmc-targets.txt', 'exhibit1.csv', 'console']);
  assert.throws(() => targetsLib.mergeTargets([list], { maxDevices: 1 }), /--max-devices/);
  assert.throws(() => targetsLib.parseTargetsFile('192.0.2.300\n'), /not an IPv4/);
  // The repository's own target list loads (format check only — nothing is dialed).
  const repo = targetsLib.parseTargetsFile(fs.readFileSync(path.join(__dirname, '../../install/nmc-targets.example.txt'), 'utf8'));
  assert.strictEqual(repo.length, 41);
});

// ── yaml + credentials ────────────────────────────────────────────────────
test('yaml-lite loads the installer example site.yaml and the spec credentials shape', () => {
  const site = loads(fs.readFileSync(path.join(__dirname, '../../install/site.example.yaml'), 'utf8'));
  assert.strictEqual(site.tenant.code, 'HAEA');
  assert.strictEqual(site.hosts.collectors[0].id, 'cap01');
  assert.strictEqual(site.nmc.targets_file, '/opt/app/cflex/config/nmc-targets.txt');
  const c = loads('defaults: { user: apc, password: ref:ONBOARD_DEFAULT_PW, transport: ssh }\noverrides:\n  192.0.2.34: { user: apc, password: ref:X_PW }\n  192.0.2.25: { transport: https }\n');
  assert.deepStrictEqual(c.overrides['192.0.2.25'], { transport: 'https' });
  assert.strictEqual(c.defaults.password, 'ref:ONBOARD_DEFAULT_PW');
  assert.throws(() => loads('a: b\n\tc: d\n'), /tab in indentation/);
  // The shipped example parses, and holds references only.
  const ex = loads(fs.readFileSync(path.join(__dirname, '../onboard-credentials.example.yaml'), 'utf8'));
  assert.strictEqual(ex.defaults.password, 'ref:ONBOARD_DEFAULT_PW');
  assert.deepStrictEqual(ex.snmpv3, { auth_key: 'ref:ONBOARD_V3_AUTH', priv_key: 'ref:ONBOARD_V3_PRIV' });
});

test('credentials: 0600 enforced, ref: from env, overrides, errors without values', async () => {
  const dir = tmp();
  const open = writeCreds(dir, { mode: 0o644 });
  await assert.rejects(credsLib.loadCredentials({ path: open, env: ENV }), /must be mode 0600/);
  fs.chmodSync(open, 0o600);
  fs.writeFileSync(open, fs.readFileSync(open, 'utf8') + 'overrides:\n  192.0.2.34: { password: ref:T_OVR }\n  192.0.2.25: { transport: https }\n');
  const c = await credsLib.loadCredentials({ path: open, env: ENV });
  assert.strictEqual(c.forTarget('192.0.2.11').password, S.login);
  assert.strictEqual(c.forTarget('192.0.2.34').password, S.overrideLogin);
  assert.strictEqual(c.forTarget('192.0.2.34').set, 'override:192.0.2.34');
  assert.strictEqual(c.forTarget('192.0.2.25').transport, 'https');
  assert.strictEqual(c.forTarget('192.0.2.25').set, 'defaults'); // same account → same lock-out counter
  assert.deepStrictEqual(await c.v3Keys(), { authKey: S.auth, privKey: S.priv });
  for (const v of Object.values(S).filter(v => v !== S.user && v !== S.consolePw)) assert.strictEqual(c.redactor.redact(`x${v}y`), 'x***y');
  // Missing env var: the message names the variable, never a value.
  await assert.rejects(credsLib.loadCredentials({ path: open, env: { T_LOGIN: S.login } }), (e) => /T_OVR/.test(e.message) && !e.message.includes(S.login));
  const lazy = await credsLib.loadCredentials({ path: open, env: { T_LOGIN: S.login, T_OVR: S.overrideLogin } });
  await assert.rejects(lazy.v3Keys(), (e) => /T_AUTH/.test(e.message));
  await assert.rejects(credsLib.loadCredentials({}), /--credentials .* or --ask/);
  // --ask with no file: every value is prompted for.
  const asked = [];
  const p = { ask: async (q) => { asked.push(q); return S.user; }, secret: async (q) => { asked.push(q); return q.includes('auth') ? S.auth : q.includes('privacy') ? S.priv : S.login; } };
  const a = await credsLib.loadCredentials({ askMode: true, prompt: p });
  assert.strictEqual(a.forTarget('192.0.2.11').password, S.login);
  assert.deepStrictEqual(await a.v3Keys(), { authKey: S.auth, privKey: S.priv });
  assert.ok(asked.length >= 3);
});

// ── read parsing (per model) ──────────────────────────────────────────────
test('read: NMC2 and NMC3 output parse to the same shape; old firmware has no v3', async () => {
  const r = await rig([{ family: 'NMC2', n: 31 }, { family: 'NMC3', n: 32 }, { family: 'NMC2', n: 33, variant: 'oldfw' }]);
  try {
    const res = await r.run('read');
    assert.strictEqual(res.code, 0);
    const [a, b, c] = res.results;
    assert.strictEqual(a.status, 'ok');
    assert.strictEqual(a.read.family, 'NMC2');
    assert.strictEqual(a.read.nmc.model, 'AP9631');
    assert.strictEqual(a.read.nmc.serial, 'TEST2NMC0031');
    assert.strictEqual(a.read.nmc.app_version, 'v6.9.6');
    assert.strictEqual(b.read.family, 'NMC3');
    assert.strictEqual(b.read.nmc.model, 'AP9641');
    assert.strictEqual(b.read.nmc.serial, 'TEST3NMC0032');
    for (const x of [a, b]) {
      assert.strictEqual(x.read.ups.sku, 'SRT5KRMXLT');
      assert.strictEqual(x.read.ups.firmware, 'UPS 16.9 (ID1044)');
      assert.strictEqual(x.read.network.gateway, '192.0.2.1');
      assert.strictEqual(x.read.snmp_v1.enabled, true);
      assert.strictEqual(x.read.snmp_v1.access.length, 4);
      assert.deepStrictEqual(x.read.snmp_v1.access[0].community, { set: true, length: 6, factory: true });
      assert.strictEqual(x.read.snmp_v3.enabled, false);
      assert.strictEqual(x.read.snmp_v3.users.length, 4);
      assert.strictEqual(x.read.snmp_v3.users[0].name, 'apc snmp profile1');
      assert.strictEqual(x.read.traps.length, 6);
      assert.strictEqual(x.read.ntp.enabled, false);
      assert.strictEqual(x.read.web.https, true);
      assert.strictEqual(x.read.console.ssh, true);
      assert.strictEqual(x.read.login_account.permission, 'Super User');
      assert.ok(fs.statSync(x.backup).size > 100, 'config.ini saved');
      assert.strictEqual(fs.statSync(x.backup).mode & 0o777, 0o600);
    }
    assert.strictEqual(c.read.snmp_v3.supported, false);
    assert.ok(c.recommendations.some(t => /firmware does not offer SNMPv3/.test(t)));
    // read sends reads only.
    for (const s of r.sims) assert.deepStrictEqual(writes(s), []);
    // read-<ts>.json per card, community names nowhere in it.
    const json = filesUnder(r.out).filter(f => /read-.*\.json$/.test(f));
    assert.strictEqual(json.length, 3);
    for (const f of json) assert.ok(!/public|private/.test(fs.readFileSync(f, 'utf8')), f);
  } finally { await r.stop(); }
});

test('read parsers: tolerate label variants', () => {
  const st = { family: 'NMC3' };
  assert.strictEqual(reader.parse.parseSnmp('E000: Success\nSNMPv1 Access:  disabled\n').enabled, false);
  assert.strictEqual(reader.parse.parseNtp('NTP status: enabled\nPrimary NTP Server: 192.0.2.123\nSecondary NTP Server: 0.0.0.0\n').secondary, null);
  assert.strictEqual(reader.familyOf('AP9630'), 'NMC2');
  assert.strictEqual(reader.familyOf('AP9643'), 'NMC3');
  assert.strictEqual(render(st, 'nothing'), null);
});

// ── plan ──────────────────────────────────────────────────────────────────
test('plan: diff and lines for a v1-only card, nothing written', async () => {
  const r = await rig([{ family: 'NMC2', n: 41 }, { family: 'NMC3', n: 42, variant: 'v3set' }]);
  try {
    const res = await r.run('plan', ['--disable-legacy']);
    const [a, b] = res.results;
    assert.deepStrictEqual(a.diff.map(d => d.field), ['snmpv3.enabled', 'snmpv3.user[1]', 'snmpv3.access[1]', 'snmptrap[1]', 'snmpv1.enabled']);
    assert.deepStrictEqual(a.changes, [
      'snmpv3 -S enable',
      'snmpv3 -u1 cflex-ro -a1 *** -c1 *** -ap1 sha -pp1 aes',
      `snmpv3 -ac1 enable -au1 cflex-ro -n1 ${COLLECTOR}`,
      `snmptrap -r1 ${COLLECTOR} -t1 snmpV3 -g1 enable -a1 enable -u1 profile1`,
      'snmp -S disable',
    ]);
    assert.strictEqual(a.reason, 'changes');
    // Already configured: only the key check remains (pass phrases cannot be read back).
    assert.deepStrictEqual(b.diff.map(d => d.field), ['snmpv1.enabled']);
    assert.strictEqual(b.reason, 'changes');
    for (const s of r.sims) assert.deepStrictEqual(writes(s), []);
  } finally { await r.stop(); }
});

test('plan: undo lines, NTP warn by default / write with --set-ntp, slots in use', () => {
  const read = {
    snmp_v1: { enabled: true, access: [] }, ntp: { enabled: false, primary: null, secondary: null },
    snmp_v3: { supported: true, enabled: true, users: [{ index: 1, name: 'other', auth: 'sha', priv: 'aes' }, { index: 2, name: 'apc snmp profile2', auth: 'none', priv: 'none' }], access: [] },
    traps: [{ index: 1, receiver: '192.0.2.77', type: 'snmpv1', generation: true }, { index: 2, receiver: null }],
  };
  const conf = { collectors: [{ ip: COLLECTOR, sites: [SITE] }], onboard: { snmpv3: { user: 'cflex-ro' }, ntp: { servers: ['192.0.2.123'] } } };
  const keys = { authKey: S.auth, privKey: S.priv };
  const p1 = plan(read, desiredFor({ ip: '192.0.2.11', site: SITE }, { siteConf: conf, keys }));
  assert.strictEqual(p1.slots.profile, 2);
  assert.strictEqual(p1.slots.trap, 2);
  assert.ok(p1.warnings.some(w => /--set-ntp/.test(w)));
  assert.ok(!p1.steps.some(s => s.id === 'ntp'));
  assert.ok(p1.steps.find(s => s.id === 'snmpv3_user').undo.includes('"apc snmp profile2"'));
  assert.strictEqual(p1.post.length, 0); // no --disable-legacy
  assert.ok(p1.recommendations.some(t => /--disable-legacy/.test(t)));
  const p2 = plan(read, desiredFor({ ip: '192.0.2.11', site: SITE }, { siteConf: conf, keys, flags: { setNtp: true } }));
  assert.strictEqual(p2.steps.find(s => s.id === 'ntp').line, 'ntp -OM enable -p 192.0.2.123');
  const full = { ...read, snmp_v3: { ...read.snmp_v3, users: [1, 2, 3, 4].map(i => ({ index: i, name: `u${i}`, auth: 'sha', priv: 'aes' })) } };
  assert.strictEqual(plan(full, desiredFor({ ip: '192.0.2.11', site: SITE }, { siteConf: conf, keys })).reason, 'no_free_snmpv3_profile');
  // Bad phrases: the message names the field, not the value.
  assert.throws(() => desiredFor({ ip: '192.0.2.11' }, { siteConf: conf, keys: { authKey: 'short-x', privKey: S.priv } }), (e) => /auth pass phrase/.test(e.message) && !e.message.includes('short-x'));
});

// ── apply ─────────────────────────────────────────────────────────────────
test('apply: backup → apply → verify (real SNMPv3 GET) → legacy off → verify, then idempotent', async () => {
  const r = await rig([{ family: 'NMC2', n: 51 }]);
  try {
    const events = [];
    const prompt = stubPrompt([true]);
    const res = await r.run('apply', ['--disable-legacy'], { prompt, emit: (...e) => events.push(e.filter(x => x !== r.sims[0].ip).join(':')) });
    const x = res.results[0];
    assert.strictEqual(x.status, 'ok', x.reason);
    assert.deepStrictEqual(events, ['backup', 'apply:snmpv3_enable', 'apply:snmpv3_user', 'apply:snmpv3_access', 'apply:snmptrap_receiver', 'verify', 'apply:legacy_off', 'verify']);
    assert.strictEqual(prompt.asked.length, 1); // one confirmation for the card
    assert.strictEqual(x.verify.snmp.ok, true);
    assert.match(x.verify.snmp.sysDescr, /SIM/);
    assert.strictEqual(x.verify.trap.status, 'not_tested');
    const st = r.sims[0].state;
    assert.strictEqual(st.v3.enabled, true);
    assert.strictEqual(st.v3.users[0].name, 'cflex-ro');
    assert.strictEqual(st.v3.access[0].nms, COLLECTOR);
    assert.strictEqual(st.traps[0].ip, COLLECTOR);
    assert.strictEqual(st.v1.enabled, false);
    assert.strictEqual(r.sims[0].scp, 1);
    assert.strictEqual(fs.statSync(x.backup).mode & 0o777, 0o600);
    // The write commands sent, in order, are exactly the plan.
    assert.deepStrictEqual(writes(r.sims[0]).map(c => c.split(' ').slice(0, 2).join(' ')), ['snmpv3 -S', 'snmpv3 -u1', 'snmpv3 -ac1', 'snmptrap -r1', 'snmp -S']);
    // Second run: nothing to do, nothing written, no backup.
    const before = r.sims[0].commands.length;
    const again = await r.run('apply', ['--disable-legacy', '--yes-all']);
    assert.strictEqual(again.results[0].status, 'skipped');
    assert.match(again.results[0].reason, /already in the desired state/);
    assert.deepStrictEqual(writes({ commands: r.sims[0].commands.slice(before) }), []);
    assert.strictEqual(r.sims[0].scp, 1);
    // verify (SAT 2 evidence)
    const v = await r.run('verify');
    assert.strictEqual(v.results[0].status, 'ok');
    assert.match(v.results[0].reason, /^PASS Smart-UPS/);
  } finally { await r.stop(); }
});

test('apply: verify failure rolls back with undo lines; legacy stays on', async () => {
  const r = await rig([{ family: 'NMC3', n: 52, snmpBroken: true }]);
  try {
    const events = [];
    const res = await r.run('apply', ['--disable-legacy', '--yes-all'], { emit: (...e) => events.push(e[0] + (e[2] ? `:${e[2]}` : '')) });
    const x = res.results[0];
    assert.strictEqual(res.code, 1);
    assert.strictEqual(x.status, 'failed');
    assert.match(x.reason, /verify failed \(snmpv3/);
    assert.strictEqual(x.rolled_back, true);
    assert.deepStrictEqual(events, ['backup', 'apply:snmpv3_enable', 'apply:snmpv3_user', 'apply:snmpv3_access', 'apply:snmptrap_receiver', 'verify', 'rollback']);
    const st = r.sims[0].state;
    assert.strictEqual(st.v3.enabled, false);
    assert.strictEqual(st.v3.users[0].name, 'apc snmp profile1');
    assert.strictEqual(st.v3.users[0].auth, 'None');
    assert.strictEqual(st.v3.access[0].enabled, false);
    assert.strictEqual(st.traps[0].ip, '0.0.0.0');
    assert.strictEqual(st.traps[0].gen, false);
    assert.strictEqual(st.v1.enabled, true, 'legacy is never turned off before v3 is verified');
  } finally { await r.stop(); }
});

test('apply: a refused step stops the card and undoes what was applied', async () => {
  const r = await rig([{ family: 'NMC2', n: 53, failOn: 'snmptrap' }]);
  try {
    const res = await r.run('apply', ['--yes-all']);
    const x = res.results[0];
    assert.strictEqual(x.status, 'failed');
    assert.match(x.reason, /snmptrap_receiver: E102/);
    assert.strictEqual(x.rolled_back, true);
    assert.strictEqual(r.sims[0].state.v3.enabled, false);
    assert.strictEqual(r.sims[0].state.v3.access[0].enabled, false);
  } finally { await r.stop(); }
});

test('apply: declined card gets no backup and no write; concurrency 1', async () => {
  const r = await rig([{ family: 'NMC2', n: 54 }, { family: 'NMC3', n: 55 }]);
  try {
    let open = 0, peak = 0;
    const res = await r.run('apply', [], {
      prompt: stubPrompt([false, true]),
      emit: (k) => { if (k === 'backup') { open++; peak = Math.max(peak, open); } if (k === 'verify') open--; },
    });
    assert.strictEqual(res.results[0].status, 'skipped');
    assert.match(res.results[0].reason, /declined/);
    assert.strictEqual(r.sims[0].scp, 0);
    assert.deepStrictEqual(writes(r.sims[0]), []);
    assert.strictEqual(res.results[1].status, 'ok', res.results[1].reason);
    assert.strictEqual(peak, 1);
  } finally { await r.stop(); }
});

test('apply: maintenance window through the console API (set, then ended)', async () => {
  const sim = await startNmcSim({ login: LOGIN, n: 56 });
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}${b ? ` ${b}` : ''}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/auth/login') { res.setHeader('set-cookie', 'cflex_sid=test; Path=/'); return res.end('{"ok":true}'); }
      if (req.url === '/v1/console/devices') return res.end(JSON.stringify({ ok: true, devices: [{ nmc_ip: sim.ip, site_id: SITE, label: 'Console UPS', serial: sim.state.ups.serial }] }));
      if (req.method === 'POST' && req.url === '/v1/console/maintenance') return res.end('{"ok":true,"id":7}');
      if (req.method === 'DELETE' && req.url === '/v1/console/maintenance/7') return res.end('{"ok":true}');
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = tmp();
  try {
    const creds = writeCreds(dir, { consoleBlock: true });
    const site = writeSiteYaml(dir, path.join(dir, 'none.txt'));
    const res = await main(['apply', '--site-yaml', site, '--credentials', creds, '--console', `http://127.0.0.1:${srv.address().port}`, '--out', path.join(dir, 'out'), '--yes-all'],
      { env: ENV, simMap: { [sim.ip]: { host: '127.0.0.1', ssh: sim.sshPort, snmp: sim.snmpPort } }, prompt: stubPrompt(), log: quiet, settleMs: 20, snmpTimeoutMs: 800 });
    assert.strictEqual(res.results[0].status, 'ok', res.results[0].reason);
    assert.strictEqual(res.results[0].label, 'Console UPS');
    assert.ok(calls[0].startsWith('POST /v1/auth/login'));
    const m = calls.findIndex(c => c.startsWith('POST /v1/console/maintenance'));
    assert.ok(m > 0 && JSON.parse(calls[m].split(' ').slice(2).join(' ')).site_id === SITE);
    assert.strictEqual(calls[calls.length - 1], 'DELETE /v1/console/maintenance/7');
  } finally { srv.close(); await sim.stop(); }
});

// ── auth failures ─────────────────────────────────────────────────────────
test('auth: 3 failures in a row with one set stop that set; the 4th card is not tried', async () => {
  const r = await rig([1, 2, 3, 4].map(i => ({ family: 'NMC2', n: 60 + i, variant: 'authfail' })));
  try {
    const prompt = stubPrompt([false]);
    const res = await r.run('read', [], { prompt });
    assert.deepStrictEqual(res.results.map(x => x.status), ['auth_failed', 'auth_failed', 'auth_failed', 'auth_failed']);
    assert.match(res.results[3].reason, /suspended after 3 failures/);
    assert.deepStrictEqual(r.sims.map(s => s.connections), [1, 1, 1, 0]);
    assert.strictEqual(prompt.asked.length, 1);
    assert.match(prompt.asked[0], /3 authentication failures/);
    // Operator says go on: the set is resumed.
    const r2 = await r.run('read', [], { prompt: stubPrompt([true]) });
    assert.match(r2.results[3].reason, /authentication failed/);
    assert.strictEqual(r.sims[3].connections, 1);
  } finally { await r.stop(); }
});

test('auth: a success resets the count; factory account is detected and only reported', async () => {
  const r = await rig([{ n: 71, variant: 'authfail' }, { n: 72, variant: 'authfail' }, { n: 73 }, { n: 74, variant: 'authfail' }, { n: 75, variant: 'authfail' }]);
  try {
    const res = await r.run('read');
    assert.deepStrictEqual(res.results.map(x => x.status), ['auth_failed', 'auth_failed', 'ok', 'auth_failed', 'auth_failed']);
    assert.ok(r.sims.every(s => s.connections === 1));
  } finally { await r.stop(); }
  const f = await startNmcSim({ login: { user: 'apc', password: 'apc' }, n: 76 });
  const dir = tmp();
  try {
    const credFile = path.join(dir, 'c.yaml');
    fs.writeFileSync(credFile, 'defaults: { user: apc, password: ref:T_FACTORY }\nsnmpv3: { auth_key: ref:T_AUTH, priv_key: ref:T_PRIV }\n', { mode: 0o600 });
    const inv = path.join(dir, 'i.txt');
    fs.writeFileSync(inv, `${f.ip}\n`);
    const res = await main(['read', '--site-yaml', writeSiteYaml(dir, inv), '--credentials', credFile, '--out', path.join(dir, 'out')],
      { env: { ...ENV, T_FACTORY: 'apc' }, simMap: { [f.ip]: { host: '127.0.0.1', ssh: f.sshPort, snmp: f.snmpPort } }, prompt: stubPrompt(), log: quiet });
    assert.strictEqual(res.results[0].read.factory_account, true);
    assert.ok(res.results[0].recommendations.some(t => /factory account/.test(t)));
    assert.deepStrictEqual(writes(f), []); // detected, never changed
  } finally { await f.stop(); }
});

test('slow card: a command slower than the timeout makes it unreachable, not hung', async () => {
  const r = await rig([{ n: 77, variant: 'slow', slowMs: 2500 }]);
  try {
    const res = await r.run('read', ['--timeout', '1']);
    assert.strictEqual(res.results[0].status, 'unreachable');
    assert.strictEqual(res.results[0].reason, 'timeout');
  } finally { await r.stop(); }
});

// ── masking ───────────────────────────────────────────────────────────────
test('masking: no credential, key or community value in logs, reports, audit, read files or errors', async () => {
  const r = await rig([{ family: 'NMC2', n: 81 }, { family: 'NMC3', n: 82, snmpBroken: true }, { n: 83, variant: 'authfail' }]);
  try {
    const cap = capture();
    await r.run('read', [], { log: cap.log });
    await r.run('plan', ['--disable-legacy'], { log: cap.log });
    await r.run('apply', ['--disable-legacy'], { log: cap.log, prompt: stubPrompt([true, true, true]) });
    await r.run('verify', [], { log: cap.log });
    const secrets = [S.login, S.auth, S.priv];
    const texts = [['log', cap.lines.join('\n')]];
    for (const f of filesUnder(r.out)) texts.push([f, fs.readFileSync(f, 'utf8')]);
    for (const [name, t] of texts) {
      for (const s of secrets) assert.ok(!t.includes(s), `${name} contains a secret`);
      if (!/config-.*\.ini$/.test(name)) assert.ok(!/\bprivate2?\b|\bpublic2\b/.test(t), `${name} contains a community name`);
    }
    assert.ok(cap.lines.some(l => l.includes('-a1 *** -c1 ***')), 'the masked form is what is shown');
    // An error carrying a secret is redacted before it is printed.
    const cap2 = capture();
    const bad = path.join(r.dir, 'bad.yaml');
    fs.writeFileSync(bad, `defaults: { user: ${S.user}, password: ${S.login} }\nsnmpv3: { auth_key: ${S.auth}, priv_key: ${S.priv} }\n`, { mode: 0o600 });
    const res = await main(['read', '--site-yaml', r.siteFile, '--credentials', bad, '--inventory', path.join(r.dir, `missing-${S.auth}.csv`), '--out', r.out], { env: {}, log: cap2.log, prompt: stubPrompt() });
    assert.strictEqual(res.code, 2);
    assert.ok(cap2.lines.length && !cap2.lines.join('\n').includes(S.auth), cap2.lines.join('\n'));
    assert.ok(!res.error.includes(S.auth));
  } finally { await r.stop(); }
});

// ── inventory comparison + report ─────────────────────────────────────────
test('inventory comparison: serial / model mismatch and non-answering cards', async () => {
  const r = await rig([{ n: 91, invSerial: 'WRONGSERIAL1' }, { n: 92, invModel: 'SRT3000RMXLA' }, { n: 93, variant: 'authfail' }]);
  try {
    const res = await r.run('read');
    assert.deepStrictEqual(res.inventory.mismatches.map(m => [m.ip, m.field]), [['192.0.2.91', 'serial'], ['192.0.2.92', 'model']]);
    assert.deepStrictEqual(res.inventory.no_answer.map(m => [m.ip, m.status]), [['192.0.2.93', 'auth_failed']]);
    const extra = report.compareInventory([{ ip: '192.0.2.91' }], [], { scanned: [{ ip: '192.0.2.91' }, { ip: '192.0.2.99', ports: [22] }] });
    assert.deepStrictEqual(extra.not_in_inventory, [{ ip: '192.0.2.99', ports: [22] }]);
    const md = fs.readFileSync(res.files.md, 'utf8');
    assert.match(md, /## 인벤토리 대조/);
    assert.match(md, /불일치 192\.0\.2\.91 \(UNIT-1\) serial: 인벤토리 WRONGSERIAL1 \/ 카드 TESTUPS00091/);
    assert.match(md, /응답 없음 192\.0\.2\.93 \(UNIT-3\): auth_failed/);
  } finally { await r.stop(); }
});

test('report: md + csv per run (0600), audit.log append-only across runs', async () => {
  const r = await rig([{ n: 95 }, { n: 96, variant: 'oldfw' }]);
  try {
    const one = await r.run('plan');
    const auditFile = path.join(r.out, 'audit.log');
    const n1 = fs.readFileSync(auditFile, 'utf8').trim().split('\n').length;
    await new Promise(res => setTimeout(res, 1100)); // a new report timestamp
    const two = await r.run('apply', ['--yes-all']);
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    assert.ok(lines.length > n1);
    for (const l of lines) JSON.parse(l); // one JSON object per line
    assert.ok(lines.some(l => JSON.parse(l).action === 'backup'));
    for (const f of [one.files.md, one.files.csv, two.files.md, two.files.csv]) assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, f);
    const csv = fs.readFileSync(two.files.csv, 'utf8').trim().split('\n');
    assert.strictEqual(csv[0], 'ip,site,label,status,reason,nmc,ups,snmp,changes,verify,rolled_back');
    assert.match(csv[1], /^192\.0\.2\.95,TEST-A,UNIT-1,ok,/);
    assert.match(csv[2], /^192\.0\.2\.96,TEST-A,UNIT-2,skipped,firmware_without_snmpv3/);
    const md = fs.readFileSync(two.files.md, 'utf8');
    assert.match(md, /결과: ok 1 · skipped 1 · auth_failed 0 · unreachable 0 · failed 0/);
    assert.match(md, /## 변경 전 → 후/);
    assert.match(md, /firmware does not offer SNMPv3/);
  } finally { await r.stop(); }
});

// ── HTTPS read fallback ───────────────────────────────────────────────────
test('HTTPS: config.ini read fallback, read whitelist only', { skip: !hasOpenssl() && 'openssl not found' }, async () => {
  const certs = makeCerts();
  const r = await rig([{ n: 97 }], { https: certs.server });
  try {
    fs.writeFileSync(r.credsFile, fs.readFileSync(r.credsFile, 'utf8') + `overrides:\n  ${r.sims[0].ip}: { transport: https }\n`);
    const res = await r.run('read');
    const x = res.results[0];
    assert.strictEqual(x.status, 'ok', x.reason);
    assert.strictEqual(x.read.via, 'config.ini');
    assert.strictEqual(x.read.network.ip, '192.0.2.97');
    assert.strictEqual(x.read.snmp_v1.enabled, true);
    assert.strictEqual(x.read.snmp_v3.users.length, 4);
    assert.strictEqual(r.sims[0].connections, 0); // no SSH
    assert.deepStrictEqual(r.sims[0].http, ['POST /Forms/login1', 'GET /config.ini', 'GET /logout.htm']);
    const web = createHttpsTransport({ gate: targetsLib.createGate([{ ip: r.sims[0].ip }]), log: quiet, endpoint: () => ({ host: '127.0.0.1', httpsPort: r.sims[0].httpsPort }) });
    // apply never writes over HTTPS, and does not fall back to SSH for such a card.
    const ap = await r.run('apply', ['--yes-all']);
    assert.strictEqual(ap.results[0].status, 'skipped');
    assert.match(ap.results[0].reason, /https is read-only/);
    assert.strictEqual(r.sims[0].connections, 0);
    await assert.rejects(web.request(r.sims[0].ip, 'POST', '/Forms/snmp1', { body: 'x=1' }), (e) => e.code === 'command_refused');
    await assert.rejects(web.request('192.0.2.250', 'GET', '/config.ini'), (e) => e.code === 'not_in_inventory');
  } finally { await r.stop(); certs.cleanup(); }
});

// ── trap test ─────────────────────────────────────────────────────────────
test('verify --trap-test: passes on a v3 trap from the card, fails without one', async () => {
  const port = await new Promise((res) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const d = { v3: { user: 'cflex-ro', auth: 'sha', priv: 'aes', authKey: S.auth, privKey: S.priv } };
  const t = { ip: '192.0.2.98' };
  const v = createVerifier({ gate: targetsLib.createGate([t]), endpoint: () => ({ host: '127.0.0.1', snmpPort: 1 }), trap: { port, bind: '127.0.0.1', waitMs: 3000 }, log: quiet });
  const waiting = v.trapTest(t.ip, d);
  setTimeout(() => {
    // Stand-in for the card: a v3 authPriv trap from 127.0.0.1.
    const s = snmp.createV3Session('127.0.0.1', { name: 'cflex-ro', level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha, authKey: S.auth, privProtocol: snmp.PrivProtocols.aes, privKey: S.priv }, { trapPort: port, version: snmp.Version3 });
    s.trap(snmp.TrapType.ColdStart, () => s.close());
  }, 300);
  assert.deepStrictEqual(await waiting, { status: 'pass', version: 'v3' });
  const v2 = createVerifier({ gate: targetsLib.createGate([t]), endpoint: () => ({ host: '127.0.0.1' }), trap: { port, bind: '127.0.0.1', waitMs: 300 }, log: quiet });
  assert.deepStrictEqual(await v2.trapTest(t.ip, d), { status: 'fail', error: 'no_trap' });
  assert.deepStrictEqual(await createVerifier({ gate: targetsLib.createGate([t]) }).trapTest(t.ip, d), { status: 'not_tested' });
});

// ── scan (option 2) ───────────────────────────────────────────────────────
test('scan: ≤ 20 hosts started per second, inside the CIDR only, after a yes', async () => {
  let t = 0;
  const fake = { now: () => t, sleep: async (ms) => { t += ms; } };
  const seen = [];
  const res = await scan({ cidr: '192.0.2.0/26', prompt: stubPrompt([true]), rate: 50, log: quiet, ...fake,
    probeHost: async (ip) => { seen.push(ip); return ip === '192.0.2.10' ? { ip, ports: [22, 443] } : null; } });
  assert.strictEqual(res.rate, 20); // capped
  assert.strictEqual(res.hosts, 62);
  const starts = res.started.map(s => s.at);
  for (let i = 0; i < starts.length; i++) {
    const inWindow = starts.filter(x => x >= starts[i] && x < starts[i] + 1000).length;
    assert.ok(inWindow <= 20, `${inWindow} hosts within one second`);
  }
  assert.ok(seen.every(ip => /^192\.0\.2\.(\d+)$/.test(ip) && +ip.split('.')[3] >= 1 && +ip.split('.')[3] <= 62));
  assert.strictEqual(seen.length, 62 + 61); // one retry for every non-answer
  assert.deepStrictEqual(res.candidates.map(c => c.ip), ['192.0.2.10']);
  assert.strictEqual(res.candidates[0].candidate, true);
  // Declined: nothing probed.
  const none = [];
  const d = await scan({ cidr: '192.0.2.0/30', prompt: stubPrompt([false]), log: quiet, probeHost: async (ip) => { none.push(ip); } });
  assert.strictEqual(d.declined, true);
  assert.deepStrictEqual(none, []);
  assert.throws(() => expandCidr('10.0.0.0/16'), /prefix must be/);
  assert.deepStrictEqual(expandCidr('192.0.2.4/30'), ['192.0.2.5', '192.0.2.6']);
});

test('scan CLI: needs --scan, writes candidates only, real TCP probe against the simulator', async () => {
  const sim = await startNmcSim({ login: LOGIN, n: 99 });
  const dir = tmp();
  try {
    const out = path.join(dir, 'out');
    assert.strictEqual((await main(['scan', '--out', out], { log: quiet, prompt: stubPrompt() })).code, 2);
    const res = await main(['scan', '--scan', `${sim.ip}/32`, '--out', out], { log: quiet, prompt: stubPrompt([true]), simMap: { [sim.ip]: { host: '127.0.0.1', ssh: sim.sshPort, https: 1, snmp: sim.snmpPort } } });
    assert.strictEqual(res.code, 0);
    assert.deepStrictEqual(res.scan.candidates.map(c => [c.ip, c.ports]), [[sim.ip, [22]]]);
    assert.match(res.scan.candidates[0].ssh_banner, /^SSH-2\.0-/);
    const j = JSON.parse(fs.readFileSync(res.files.scan, 'utf8'));
    assert.strictEqual(j.candidates.length, 1);
    assert.strictEqual(sim.authAttempts, 0); // a scan never logs in
    assert.deepStrictEqual(sim.commands, []);
  } finally { await sim.stop(); }
});
