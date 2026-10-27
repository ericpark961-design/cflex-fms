// onboard/transport-https.js — the HTTPS read fallback (spec 04 §3, priority 2).
//
// Read only: log in, GET config.ini, log out. Those three requests are the
// whole list — request() refuses any other method/path pair, so no web form
// that changes a setting can be posted from here. The result is parsed with
// reader.fromConfigIni().
//
// NMC certificates are self-signed. The certificate is pinned on first use in
// the same known_hosts.json as the SSH host keys (key "https:<ip>"); a changed
// certificate is refused.
//
// Paths and form field names follow the NMC web UI as described in the
// guides — NOT CONFIRMED ON A REAL CARD; override with --https-paths.
const https = require('https');
const fs = require('fs');
const { TransportError } = require('./transport-ssh');

const DEFAULT_PATHS = { login: '/Forms/login1', config: '/config.ini', logout: '/logout.htm' };

function pins(path) {
  let map = {};
  if (path && fs.existsSync(path)) { try { map = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { map = {}; } }
  return {
    get: (k) => map[k] || null,
    set(k, v) { map[k] = v; if (path) fs.writeFileSync(path, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 }); },
  };
}

function createHttpsTransport({ gate, log = console, timeoutMs = 30000, endpoint = null, knownHostsPath = null, paths = {} }) {
  const P = { ...DEFAULT_PATHS, ...paths };
  const allowed = new Set([`POST ${P.login}`, `GET ${P.config}`, `GET ${P.logout}`]);
  const ep = endpoint || ((ip) => ({ host: ip, httpsPort: 443 }));
  const store = pins(knownHostsPath);

  function request(ip, method, path, { body = null, cookie = null } = {}) {
    if (!allowed.has(`${method} ${path}`)) return Promise.reject(new TransportError('command_refused', `HTTPS ${method} ${path} is not on the read whitelist`));
    gate.assert(ip);
    const { host, httpsPort } = ep(ip);
    return new Promise((resolve, reject) => {
      const r = https.request({
        host, port: httpsPort || 443, method, path, timeout: timeoutMs, rejectUnauthorized: false,
        headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}), ...(cookie ? { cookie } : {}) },
      }, (res) => {
        const fp = res.socket.getPeerCertificate()?.fingerprint256;
        const had = store.get(`https:${ip}`);
        if (fp && !had) { store.set(`https:${ip}`, fp); log.warn(`[onboard] ${ip}: HTTPS certificate ${fp} pinned (first use)`); }
        else if (fp && had && had !== fp) { res.destroy(); return reject(new TransportError('host_key_mismatch', `${ip}: HTTPS certificate changed — refused`)); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      r.on('timeout', () => r.destroy(new TransportError('unreachable', `${ip}: HTTPS timeout`)));
      r.on('error', (e) => reject(e instanceof TransportError ? e : new TransportError('unreachable', `${ip}: HTTPS ${e.code || 'error'}`)));
      if (body) r.write(body);
      r.end();
    });
  }

  /** config.ini through the web UI. */
  async function readConfigIni(target, cred) {
    const ip = target.ip;
    const form = `login_username=${encodeURIComponent(cred.user)}&login_password=${encodeURIComponent(cred.password)}`;
    const login = await request(ip, 'POST', P.login, { body: form });
    const set = login.headers['set-cookie'];
    const cookie = set && set.length ? String(set[0]).split(';')[0] : null;
    if (login.status === 401 || login.status === 403 || !cookie) throw new TransportError('auth_failed', `${ip}: HTTPS log-in refused`);
    try {
      const r = await request(ip, 'GET', P.config, { cookie });
      if (r.status !== 200) throw new TransportError('read_failed', `${ip}: config.ini HTTP ${r.status}`);
      return r.body;
    } finally {
      await request(ip, 'GET', P.logout, { cookie }).catch(() => {});
    }
  }

  return { readConfigIni, request };
}

module.exports = { createHttpsTransport, DEFAULT_PATHS };
