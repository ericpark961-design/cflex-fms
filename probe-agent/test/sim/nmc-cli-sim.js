// test/sim/nmc-cli-sim.js — an APC NMC (NMC2 / NMC3) as cflex-onboard sees
// it, on 127.0.0.1 only: the CLI over SSH, config.ini over SCP, the SNMPv3
// agent the verifier GETs from, and (optional) the web UI's log-in and
// config.ini download over HTTPS.
//
// Output layout follows the NMC2/NMC3 CLI guides; it is a reconstruction, not
// a capture from a real card (docs/onboard/NMC_CLI_COMMANDS.md). NMC2 and
// NMC3 differ in a few labels on purpose, so the parsers are tested against both.
//
// The host key is generated in memory when the simulator starts and never
// written anywhere. Every fixture value here (users, phrases, serials,
// addresses in 192.0.2.0/24) is a test value, not any site's.
//
// Variants (opts.variant):
//   v1only   SNMPv1 on, v3 off, no trap receiver (the reference fleet today)
//   v3set    already in the desired state (needs opts.desired)
//   factory  log-in is the factory account
//   authfail every log-in refused
//   slow     every CLI answer delayed by opts.slowMs
//   oldfw    snmpv3 → E101 Command not supported
// Faults: opts.failOn = 'snmptrap' (that write answers E102),
//         opts.snmpBroken = true (agent never learns v3 users → verify fails).
const crypto = require('crypto');
const dgram = require('dgram');
const https = require('https');
const { Server } = require('ssh2');
const snmp = require('net-snmp');

const T = snmp.ObjectType;

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function baseState(family, n) {
  const id = String(n).padStart(2, '0');
  const nmc3 = family === 'NMC3';
  return {
    family,
    about: nmc3
      ? { model: 'AP9641', serial: `TEST3NMC00${id}`, hw: 'HW05', mfg: '11/08/2021', mac: `28 29 86 00 00 ${id}`, appName: 'sups', app: 'v2.5.0.8', aos: 'v2.5.0.8' }
      : { model: 'AP9631', serial: `TEST2NMC00${id}`, hw: '05', mfg: '01/15/2016', mac: `00 C0 B7 00 00 ${id}`, appName: 'sumx', app: 'v6.9.6', aos: 'v6.9.6' },
    ups: { model: 'Smart-UPS SRT 5000', sku: 'SRT5KRMXLT', serial: `TESTUPS000${id}`, mfg: '08/31/2025', fw: 'UPS 16.9 (ID1044)' },
    tcpip: { ip: `192.0.2.${n}`, mask: '255.255.255.0', gw: '192.0.2.1', host: `nmc-sim-${id}`, domain: 'example.com' },
    date: { date: '10/27/2026', time: '09:41:00', tz: '-08:00' },
    ntp: { enabled: false, primary: '0.0.0.0', secondary: '0.0.0.0' },
    v1: { enabled: true, access: [
      { c: 'public', type: 'read', nms: '0.0.0.0' }, { c: 'private', type: 'write+', nms: '0.0.0.0' },
      { c: 'public2', type: 'disabled', nms: '0.0.0.0' }, { c: 'private2', type: 'disabled', nms: '0.0.0.0' }] },
    v3: {
      supported: true, enabled: false,
      users: [1, 2, 3, 4].map(i => ({ name: `apc snmp profile${i}`, auth: 'None', priv: 'None', authKey: null, privKey: null })),
      access: [1, 2, 3, 4].map(i => ({ enabled: false, name: `apc snmp profile${i}`, nms: '0.0.0.0' })),
    },
    traps: [1, 2, 3, 4, 5, 6].map(() => ({ ip: '0.0.0.0', community: 'public', type: 'SNMPV1', gen: false, auth: false, profile: 'profile1' })),
    web: { http: false, https: true },
    console: { telnet: false, ssh: true },
    accounts: {},
  };
}

// ── output ────────────────────────────────────────────────────────────────
const ok = (body = '') => `E000: Success\r\n${body}`;
const en = (b) => (b ? 'enabled' : 'disabled');
const rule = (t) => `${t}\r\n${'-'.repeat(Math.max(15, t.length))}\r\n`;

function render(st, cmd) {
  const nmc3 = st.family === 'NMC3';
  const a = st.about;
  switch (cmd) {
    case 'about':
      return ok(rule('Hardware Factory')
        + `${nmc3 ? 'Model' : 'Model Number'}:           ${a.model}\r\nSerial Number:          ${a.serial}\r\nHardware Revision:      ${a.hw}\r\n`
        + `Manufacture Date:       ${a.mfg}\r\nMAC Address:            ${a.mac}\r\nManagement Uptime:      3 Days 4 Hours 10 Minutes\r\n\r\n`
        + rule('Application Module') + `Name:                   ${a.appName}\r\nVersion:                ${a.app}\r\nDate:                   Apr 23 2024\r\n\r\n`
        + rule('APC OS(AOS)') + `Name:                   aos\r\nVersion:                ${a.aos}\r\n`);
    case 'upsabout':
      return ok(`Model:                  ${st.ups.model}\r\nSKU:                    ${st.ups.sku}\r\nSerial Number:          ${st.ups.serial}\r\n`
        + `Manufacture Date:       ${st.ups.mfg}\r\n${nmc3 ? 'Firmware' : 'Firmware Revision'}:      ${st.ups.fw}\r\n`);
    case 'tcpip':
      return ok(rule('Active IPv4 Settings')
        + `  Active IPv4 Address:          ${st.tcpip.ip}\r\n  Active IPv4 Subnet Mask:      ${st.tcpip.mask}\r\n  Active IPv4 Gateway:          ${st.tcpip.gw}\r\n\r\n`
        + rule('Manually Configured IPv4 Settings')
        + `  Domain Name:          ${st.tcpip.domain}\r\n  Host Name:            ${st.tcpip.host}\r\n`);
    case 'date':
      return ok(`Date:          ${st.date.date}\r\nTime:          ${st.date.time}\r\nFormat:        mm/dd/yyyy\r\nTime Zone:     ${st.date.tz}\r\n`);
    case 'ntp':
      return ok(`NTP status:            ${en(st.ntp.enabled)}\r\nPrimary NTP Server:    ${st.ntp.primary}\r\nSecondary NTP Server:  ${st.ntp.secondary}\r\n`);
    case 'snmp':
      return ok(`${nmc3 ? 'SNMPv1 Access' : 'SNMPv1'}:    ${en(st.v1.enabled)}\r\n\r\nAccess Control summary:\r\n`
        + st.v1.access.map((x, i) => `Access Control #:   ${i + 1}\r\nCommunity:          ${x.c}\r\nAccess Type:        ${x.type}\r\nNMS IP/Host Name:   ${x.nms}\r\n`).join('\r\n'));
    case 'snmpv3':
      if (!st.v3.supported) return 'E101: Command not supported\r\n';
      return ok(`SNMPv3 Configuration\r\nSNMPv3:    ${en(st.v3.enabled)}\r\n\r\n` + rule('SNMPv3 User Profiles')
        + st.v3.users.map((u, i) => `Index:            ${i + 1}\r\nUser Name:        ${u.name}\r\nAuthentication:   ${u.auth}\r\n${nmc3 ? 'Privacy' : 'Encryption'}:       ${u.priv}\r\n`).join('\r\n')
        + '\r\n' + rule('SNMPv3 Access Control')
        + st.v3.access.map((x, i) => `Index:            ${i + 1}\r\nUser Name:        ${x.name}\r\nAccess:           ${en(x.enabled)}\r\nNMS IP/Host Name: ${x.nms}\r\n`).join('\r\n'));
    case 'snmptrap':
      return ok(st.traps.map((t, i) => `Index:            ${i + 1}\r\nReceiver IP:      ${t.ip}\r\nCommunity:        ${t.community}\r\nTrap Type:        ${t.type}\r\n`
        + `Generation:       ${en(t.gen)}\r\nAuth Traps:       ${en(t.auth)}\r\nUser Name:        ${t.profile}\r\nLanguage:         English\r\n`).join('\r\n'));
    case 'web':
      return ok(`Http:         ${en(st.web.http)}\r\nHttps:        ${en(st.web.https)}\r\nHttp Port:    80\r\nHttps Port:   443\r\n`);
    case 'console':
      return ok(`Telnet:       ${en(st.console.telnet)}\r\nSSH:          ${en(st.console.ssh)}\r\nTelnet Port:  23\r\nSSH Port:     22\r\n`);
    default: return null;
  }
}

function configIni(st) {
  const L = ['; Schneider Electric config.ini (simulator)', '[SystemID]', `Name=${st.tcpip.host}`, '[NetworkTCP/IP]',
    `SystemIP=${st.tcpip.ip}`, `SubnetMask=${st.tcpip.mask}`, `DefaultGateway=${st.tcpip.gw}`, `HostName=${st.tcpip.host}`, `DomainName=${st.tcpip.domain}`,
    '[SystemDate/Time]', `NTPEnable=${en(st.ntp.enabled)}`, `NTPPrimaryServer=${st.ntp.primary}`, `NTPSecondaryServer=${st.ntp.secondary}`,
    '[NetworkSNMP]', `SNMPv1Enable=${en(st.v1.enabled)}`];
  st.v1.access.forEach((x, i) => L.push(`AccessControl${i + 1}Community=${x.c}`, `AccessControl${i + 1}AccessType=${x.type}`, `AccessControl${i + 1}NMSIP=${x.nms}`));
  if (st.v3.supported) {
    L.push(`SNMPv3Enable=${en(st.v3.enabled)}`);
    st.v3.users.forEach((u, i) => L.push(`SNMPv3User${i + 1}UserName=${u.name}`, `SNMPv3User${i + 1}AuthProtocol=${u.auth}`, `SNMPv3User${i + 1}PrivProtocol=${u.priv}`,
      // The card keeps phrases in config.ini (masked here as a real card would not be — backups are 0600 for this reason).
      `SNMPv3User${i + 1}AuthPhrase=${u.authKey ? '<set>' : ''}`));
    st.v3.access.forEach((x, i) => L.push(`SNMPv3Access${i + 1}Enable=${en(x.enabled)}`, `SNMPv3Access${i + 1}UserName=${x.name}`, `SNMPv3Access${i + 1}NMSIP=${x.nms}`));
  }
  st.traps.forEach((t, i) => L.push(`TrapReceiver${i + 1}NMSIP=${t.ip}`, `TrapReceiver${i + 1}Community=${t.community}`, `TrapReceiver${i + 1}Type=${t.type}`,
    `TrapReceiver${i + 1}Generation=${en(t.gen)}`, `TrapReceiver${i + 1}AuthTraps=${en(t.auth)}`, `TrapReceiver${i + 1}Profile=${t.profile}`));
  return L.join('\r\n') + '\r\n';
}

// ── commands ──────────────────────────────────────────────────────────────
function tokens(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}
const flags = (tk) => { const f = {}; for (let i = 1; i < tk.length; i += 2) f[tk[i]] = tk[i + 1]; return f; };
const onoff = (v) => (v === 'enable' ? true : v === 'disable' ? false : null);
const PROTO = { sha: 'SHA', md5: 'MD5', none: 'None', aes: 'AES', des: 'DES' };

function execute(sim, line) {
  const st = sim.state;
  const tk = tokens(line);
  const cmd = tk[0];
  if (tk.length === 1) { const r = render(st, cmd); if (r != null) return r; }
  if (cmd === 'user' && tk[1] === '-n' && tk.length === 3) {
    return ok(`Access:            Enabled\r\nUser Permission:   ${tk[2] === sim.login.user ? 'Super User' : 'Device User'}\r\n`);
  }
  if (sim.opts.failOn && cmd === sim.opts.failOn && tk.length > 1) return 'E102: Parameter Error\r\n';
  const f = flags(tk);
  if (cmd === 'snmpv3') {
    if (!st.v3.supported) return 'E101: Command not supported\r\n';
    if (f['-S']) { st.v3.enabled = onoff(f['-S']); return ok(); }
    const u = Object.keys(f).find(k => /^-u[1-4]$/.test(k));
    if (u) {
      const n = +u.slice(2);
      const x = st.v3.users[n - 1];
      x.name = f[u];
      if (f[`-a${n}`]) x.authKey = f[`-a${n}`];
      if (f[`-c${n}`]) x.privKey = f[`-c${n}`];
      if (f[`-ap${n}`]) x.auth = PROTO[f[`-ap${n}`]];
      if (f[`-pp${n}`]) x.priv = PROTO[f[`-pp${n}`]];
      if (x.auth === 'None') x.authKey = null;
      if (x.priv === 'None') x.privKey = null;
      return ok();
    }
    const ac = Object.keys(f).find(k => /^-ac[1-4]$/.test(k));
    if (ac) {
      const n = +ac.slice(3);
      const x = st.v3.access[n - 1];
      x.enabled = onoff(f[ac]);
      if (f[`-au${n}`]) x.name = f[`-au${n}`];
      if (f[`-n${n}`]) x.nms = f[`-n${n}`];
      return ok();
    }
    return 'E102: Parameter Error\r\n';
  }
  if (cmd === 'snmptrap') {
    const r = Object.keys(f).find(k => /^-r[1-6]$/.test(k));
    if (!r) return 'E102: Parameter Error\r\n';
    const n = +r.slice(2);
    const t = st.traps[n - 1];
    t.ip = f[r];
    if (f[`-t${n}`]) t.type = f[`-t${n}`].toUpperCase();
    if (f[`-g${n}`]) t.gen = onoff(f[`-g${n}`]);
    if (f[`-a${n}`]) t.auth = onoff(f[`-a${n}`]);
    if (f[`-u${n}`]) t.profile = f[`-u${n}`];
    return ok();
  }
  if (cmd === 'snmp' && f['-S']) { st.v1.enabled = onoff(f['-S']); return ok(); }
  if (cmd === 'ntp' && f['-OM']) {
    st.ntp.enabled = onoff(f['-OM']);
    if (f['-p']) st.ntp.primary = f['-p'];
    if (f['-s']) st.ntp.secondary = f['-s'];
    return ok();
  }
  // What a real card would also do — the simulator obeys so that a test can
  // prove cflex-onboard never sends these (sim.forbidden is checked).
  if (['reboot', 'ups', 'resetToDef', 'user', 'tcpip', 'format', 'firmware', 'userdflt'].includes(cmd)) {
    sim.forbidden.push(line);
    return ok();
  }
  return 'E100: Command does not exist\r\n';
}

/**
 * @param {object} opts
 * @param {'NMC2'|'NMC3'} [opts.family]
 * @param {number} [opts.n]           last octet of the fixture address (192.0.2.n)
 * @param {string} [opts.variant]
 * @param {{user, password}} opts.login
 * @param {object} [opts.desired]     for v3set: {user, authKey, privKey, nms}
 * @param {{key, cert}} [opts.https]  start the web UI too
 */
async function startNmcSim(opts) {
  const sim = {
    opts, login: opts.login,
    state: baseState(opts.family || 'NMC2', opts.n || 11),
    commands: [], forbidden: [], connections: 0, authAttempts: 0, scp: 0, http: [],
  };
  const st = sim.state;
  if (opts.variant === 'oldfw') { st.v3.supported = false; st.about.app = 'v3.7.3'; st.about.aos = 'v3.7.4'; }
  if (opts.variant === 'v3set' && opts.desired) {
    const d = opts.desired;
    st.v3.enabled = true;
    Object.assign(st.v3.users[0], { name: d.user, auth: 'SHA', priv: 'AES', authKey: d.authKey, privKey: d.privKey });
    Object.assign(st.v3.access[0], { enabled: true, name: d.user, nms: d.nms });
    Object.assign(st.traps[0], { ip: d.nms, type: 'SNMPV3', gen: true, auth: true, profile: 'profile1' });
  }

  // ── SNMPv3 agent (what the verifier GETs) ──
  const snmpPort = await freeUdpPort();
  const agent = snmp.createAgent({ port: snmpPort, address: '127.0.0.1', disableAuthorization: false, accessControlModelType: snmp.AccessControlModelType.Simple }, () => {});
  const mib = agent.getMib();
  const scalar = (oid, name, type, get) => {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: snmp.MaxAccess['read-only'], handler: (req) => { mib.setScalarValue(name, get()); req.done(); } });
    mib.setScalarValue(name, get());
  };
  scalar('1.3.6.1.2.1.1.1', 'sysDescr', T.OctetString, () => `APC Web/SNMP Management Card (MB:v4.1.0 PF:${st.about.aos} PN:apc_hw05_aos AN1:${st.about.app}) (SIM)`);
  scalar('1.3.6.1.2.1.1.2', 'sysObjectID', T.OID, () => '1.3.6.1.4.1.318.1.3.27');
  scalar('1.3.6.1.4.1.318.1.1.1.1.1.1', 'upsBasicIdentModel', T.OctetString, () => st.ups.model);
  sim.syncAgent = () => {
    const auth = agent.getAuthorizer();
    for (const u of [...auth.getUsers()]) auth.deleteUser(u.name);
    if (opts.snmpBroken || !st.v3.supported || !st.v3.enabled) return;
    st.v3.users.forEach((u, i) => {
      const a = st.v3.access[i];
      if (!a.enabled || a.name !== u.name || u.auth !== 'SHA' || u.priv !== 'AES' || !u.authKey || !u.privKey) return;
      auth.addUser({ name: u.name, level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha, authKey: u.authKey, privProtocol: snmp.PrivProtocols.aes, privKey: u.privKey });
    });
  };
  sim.syncAgent();

  // ── SSH ──
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    sim.connections++;
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      const check = (pw) => {
        sim.authAttempts++;
        if (opts.variant !== 'authfail' && ctx.username === sim.login.user && pw === sim.login.password) ctx.accept();
        else ctx.reject(['password', 'keyboard-interactive']);
      };
      if (ctx.method === 'password') return check(ctx.password);
      if (ctx.method === 'keyboard-interactive') return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => check(answers[0]));
      return ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (a) => a && a());
      session.on('exec', (acc, rej, info) => {
        if (info.command !== 'scp -f config.ini') { const s = acc(); s.stderr.write('not allowed\n'); s.exit(1); s.end(); return; }
        sim.scp++;
        const s = acc();
        const body = Buffer.from(configIni(st));
        let stage = 0;
        s.on('data', (d) => {
          for (const b of d) {
            if (b !== 0) continue;
            if (stage === 0) { s.write(`C0644 ${body.length} config.ini\n`); stage = 1; }
            else if (stage === 1) { s.write(Buffer.concat([body, Buffer.from([0])])); stage = 2; }
            else if (stage === 2) { s.exit(0); s.end(); stage = 3; }
          }
        });
      });
      session.on('shell', (acc) => {
        const s = acc();
        let line = '';
        let queue = Promise.resolve();
        s.write('\r\nSchneider Electric Network Management Card AOS (simulator)\r\n\r\napc>');
        s.on('data', (d) => {
          for (const ch of d.toString('utf8')) {
            if (ch === '\r' || ch === '\n') {
              const l = line.trim();
              line = '';
              if (!l) continue;
              queue = queue.then(async () => {
                sim.commands.push(l);
                if (opts.variant === 'slow') await delay(opts.slowMs || 2000);
                const out = execute(sim, l);
                sim.syncAgent();
                s.write(`${l}\r\n${out}\r\napc>`);
              });
            } else line += ch;
          }
        });
      });
    });
  });
  const sshPort = await new Promise((resolve) => server.listen(0, '127.0.0.1', function () { resolve(this.address().port); }));

  // ── HTTPS web UI (read fallback) ──
  let web = null, httpsPort = null;
  if (opts.https) {
    const sessions = new Set();
    web = https.createServer({ key: opts.https.key, cert: opts.https.cert }, (req, res) => {
      sim.http.push(`${req.method} ${req.url}`);
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/Forms/login1') {
          const p = new URLSearchParams(body);
          sim.authAttempts++;
          if (opts.variant !== 'authfail' && p.get('login_username') === sim.login.user && p.get('login_password') === sim.login.password) {
            const sid = crypto.randomBytes(8).toString('hex');
            sessions.add(sid);
            res.writeHead(303, { 'set-cookie': `C=${sid}; Path=/`, location: '/home.htm' });
          } else res.writeHead(403);
          return res.end();
        }
        const sid = /C=([0-9a-f]+)/.exec(req.headers.cookie || '')?.[1];
        if (req.method === 'GET' && req.url === '/config.ini' && sessions.has(sid)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(configIni(st)); }
        if (req.method === 'GET' && req.url === '/logout.htm') { sessions.delete(sid); res.writeHead(200); return res.end(); }
        res.writeHead(404); res.end();
      });
    });
    httpsPort = await new Promise((resolve) => web.listen(0, '127.0.0.1', function () { resolve(this.address().port); }));
  }

  sim.sshPort = sshPort;
  sim.snmpPort = snmpPort;
  sim.httpsPort = httpsPort;
  sim.ip = st.tcpip.ip;
  sim.stop = () => Promise.all([
    new Promise(r => server.close(() => r())),
    new Promise(r => { try { agent.close(); } catch { /* closed */ } r(); }),
    web ? new Promise(r => web.close(() => r())) : null,
  ]);
  return sim;
}

module.exports = { startNmcSim, configIni, render };
