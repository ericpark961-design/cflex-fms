// portal/transport.js — one HTTPS request to the Portal: mTLS, through a proxy if any.
//
// Contract §1: the Probe always dials out, presents its device certificate,
// and must work behind HAEA's proxy (HTTPS_PROXY, with credentials, possibly
// re-signing TLS with its own CA). axios cannot do all of that without two
// more packages; node's https and tls can, so the forwarder talks through this
// instead and the offline bundle carries nothing extra.
//
// Proxy auth: Basic is implemented. NTLM needs a challenge/response handshake
// over the same CONNECT socket and is not — see DECISIONS Q-2026-10-25-04.
const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');

const readMaybe = (p) => (p ? fs.readFileSync(p) : undefined);

/** TLS material, read once. Paths only in config — never the key itself. */
function loadTls({ certPath, keyPath, caPath, proxyCaPath } = {}) {
  const ca = [readMaybe(caPath), readMaybe(proxyCaPath)].filter(Boolean);
  return {
    cert: readMaybe(certPath),
    key: readMaybe(keyPath),
    // Without an explicit CA the system store applies. With one, keep the
    // system store too: a proxy CA must add trust, not replace it.
    ca: ca.length ? [...tls.rootCertificates, ...ca] : undefined,
  };
}

function hostMatches(host, noProxy) {
  if (!noProxy) return false;
  return noProxy.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(rule => {
    if (rule === '*') return true;
    const r = rule.replace(/^\*?\./, '');
    return host === r || host.endsWith(`.${r}`);
  });
}

/** Open a CONNECT tunnel to host:port through an HTTP(S) proxy; resolves to the raw socket. */
function connectTunnel(proxyUrl, host, port, { timeoutMs, proxyTls }) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = { Host: `${host}:${port}` };
    if (p.username) {
      const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const lib = p.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: p.hostname,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout: timeoutMs,
      ...(p.protocol === 'https:' ? { ca: proxyTls?.ca } : {}),
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const e = new Error(`proxy CONNECT ${host}:${port} → ${res.statusCode}`);
        e.code = res.statusCode === 407 ? 'EPROXYAUTH' : 'EPROXY';
        e.status = res.statusCode;
        return reject(e);
      }
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('proxy CONNECT timed out'), { code: 'ETIMEDOUT' })));
    req.once('error', reject);
    req.end();
  });
}

/**
 * @param {object} o
 * @param {string} o.method
 * @param {string} o.url       absolute https URL
 * @param {object} o.headers
 * @param {Buffer|string} [o.body]
 * @param {object} [o.tls]     loadTls() result
 * @param {string} [o.proxy]   proxy URL (http://user:pass@host:port)
 * @param {string} [o.noProxy]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status:number, headers:object, body:string, json:any}>}
 */
async function request(o) {
  const u = new URL(o.url);
  const port = Number(u.port) || 443;
  const timeoutMs = o.timeoutMs || 15000;
  const t = o.tls || {};
  const tlsOpts = { cert: t.cert, key: t.key, ca: t.ca, servername: u.hostname, minVersion: 'TLSv1.2' };

  // Plaintext is refused, except to loopback.
  //
  // This used to call https.request() whatever the URL said, so an `http://`
  // destination failed with `EPROTO … wrong version number` — an SSL error
  // that names nothing an operator can act on. And it cannot simply be
  // allowed: these requests carry the collector key and the one-time
  // enrolment token, and the Portal contract (§1) is HTTPS.
  //
  // Loopback is the exception because it never crosses a network: a console
  // and a collector on the same host, and the end-to-end test.
  const LOOPBACK = /^(127(\.\d+){3}|localhost|\[?::1\]?)$/;
  const plaintext = u.protocol === 'http:';
  if (plaintext && !LOOPBACK.test(u.hostname)) {
    throw Object.assign(
      new Error(`refusing plaintext to ${u.hostname}: this request carries credentials — use https://`),
      { code: 'plaintext_refused' },
    );
  }
  if (plaintext && o.proxy) {
    // A CONNECT tunnel exists to carry TLS. Plaintext through a proxy would
    // hand the credentials to the proxy as well.
    throw Object.assign(new Error('refusing plaintext through a proxy'), { code: 'plaintext_refused' });
  }

  let tunnel = null;
  if (o.proxy && !hostMatches(u.hostname, o.noProxy)) {
    tunnel = await connectTunnel(o.proxy, u.hostname, port, { timeoutMs, proxyTls: t });
  }

  return new Promise((resolve, reject) => {
    const req = (plaintext ? http : https).request({
      method: o.method,
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      headers: o.headers,
      timeout: timeoutMs,
      ...(plaintext ? {} : tlsOpts),
      ...(tunnel
        ? { agent: false, createConnection: () => tls.connect({ socket: tunnel, ...tlsOpts }) }
        : { agent: false }),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        // One request per tunnel. Left alone, the CONNECT socket outlives the
        // TLS session on top of it and holds a proxy slot open for minutes.
        if (tunnel) { res.socket?.destroy(); tunnel.destroy(); }
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
      res.on('error', reject);
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    req.once('error', (e) => { if (tunnel) tunnel.destroy(); reject(e); });
    if (o.body) req.write(o.body);
    req.end();
  });
}

module.exports = { request, loadTls, hostMatches, connectTunnel };
