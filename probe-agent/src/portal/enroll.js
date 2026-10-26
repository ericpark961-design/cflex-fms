// enroll.js — the collector enrols itself.
//
// WHY. Until now getting a device certificate onto a collector meant: ssh in,
// run cflex-csr, copy the CSR out by hand, get it signed, scp the certificate
// back, restart. Every node, every rotation, a developer. That does not scale
// past one site and it is not something an operator can do.
//
// So the collector does its own half, and the Local Console's 포털 연동 page is
// left with the only two steps a person has to take: copy the CSR to the CA,
// paste the signed certificate back.
//
//   boot / tick ─┬─ no key?        → csr.ensure()  (key stays here, 0600)
//                ├─ CSR not sent?  → POST /collector/v1/enroll  { csr, pubkey }
//                ├─ no cert yet?   → GET  /collector/v1/certs   → install
//                └─ have cert?     → nothing. Idempotent, safe on a timer.
//
// Talks to the CONSOLE, not the Portal: the console is inside the customer
// network and already authenticates collectors (X-CFlex-Node + collector key).
// The Portal never sees the CSR from here — an operator carries it to the CA,
// which is what contract §6-1 describes.
'use strict';
const csr = require('./csr');

/**
 * @param {object} o
 * @param {string} o.consoleUrl   e.g. https://app01.haea.internal
 * @param {string} o.nodeId
 * @param {string} o.tenant
 * @param {string} o.token        collector key issued by the console
 * @param {string} o.dir          PKI directory on this node
 * @param {Function} o.request    transport.request, injectable
 * @param {object} [o.log]
 * @param {Array<Buffer>} [o.ca]  CA for verifying the console's TLS
 */
function createEnroller({ consoleUrl, nodeId, tenant, token, dir, request, log = console, ca = [] }) {
  const base = String(consoleUrl || '').replace(/\/+$/, '');
  let lastError = null;
  let posted = false;        // this process has already handed over the CSR

  const call = (method, path, body) => request({
    method,
    url: `${base}${path}`,
    body: body ? Buffer.from(JSON.stringify(body)) : undefined,
    headers: {
      'Content-Type': 'application/json',
      'X-CFlex-Node': nodeId,
      'X-Collector-Key': token,
      ...(body ? { 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) } : {}),
    },
    tls: { ca },
  });

  /**
   * A 2xx is not enough. `fms.runless.co.uk` has an nginx catch-all that
   * returns the SPA's index.html for any unknown path, so pointing this at the
   * wrong host — or at a console that predates these endpoints — yields
   * HTTP 200 with a page of HTML. Without this check the collector would read
   * that as "no certificate yet" and retry for ever against a URL that will
   * never answer.
   */
  function jsonOf(r, what) {
    if (r.json && typeof r.json === 'object') return r.json;
    const body = String(r.text ?? r.body ?? '').slice(0, 60).replace(/\s+/g, ' ');
    throw new Error(
      `${what}: HTTP ${r.status} but the body is not JSON — CFLEX_CONSOLE_URL 이 콘솔이 아닐 수 있다`
      + `${body ? ` (${body}…)` : ''}`,
    );
  }

  /**
   * One pass. Returns what it did so a heartbeat can report it.
   *
   * Never throws: this runs on a timer beside polling, and an unreachable
   * console must not stop a collector from doing its actual job.
   */
  async function tick() {
    const out = { state: null, generated: false, posted: false, installed: false, error: null };
    try {
      const have = csr.state({ dir, nodeId });
      out.state = have.state;

      // Already enrolled and the certificate is good: nothing to do. Checked
      // first so the common case costs one stat() and no network.
      if (have.state === 'signed') return out;

      // 1. a key and CSR, made here, once
      const mine = csr.ensure({ dir, tenant, nodeId });
      out.generated = mine.created;
      if (mine.created) log.log(`[enroll] generated key + CSR for ${mine.cn} (key stays on this node)`);

      // 2. hand the CSR to the console so an operator can see it
      if (!posted || mine.created) {
        const r = await call('POST', '/collector/v1/enroll', {
          csr: mine.csr, pubkey_sha256: mine.pubkey_sha256,
        });
        if (r.status >= 300) {
          out.error = lastError = `enroll → HTTP ${r.status}`;
          return out;
        }
        const j = jsonOf(r, 'enroll');
        posted = true;
        out.posted = true;
        if (!j.unchanged) log.log(`[enroll] CSR registered for ${nodeId} — awaiting a signed certificate`);
      }

      // 3. pick up the certificate once someone has pasted it
      const got = await call('GET', '/collector/v1/certs');
      if (got.status >= 300) {
        out.error = lastError = `certs → HTTP ${got.status}`;
        return out;
      }
      const gj = jsonOf(got, 'certs');
      if (gj.pending) return out;
      if (!gj.cert) { out.error = lastError = 'certs: no certificate in response'; return out; }

      const r = csr.install({ dir, tenant, nodeId, cert: gj.cert, ca: gj.ca || null });
      out.installed = true;
      out.state = 'signed';
      lastError = null;
      // Loud: this is the moment the node becomes able to reach the Portal,
      // and it happens unattended.
      log.log(`[enroll] installed certificate for ${r.cn}, valid to ${r.to} — Portal link can come up`);
      return out;
    } catch (e) {
      // An operator pasting the wrong node's certificate lands here. The
      // message says which check failed; the certificate is not written.
      out.error = lastError = e.message;
      log.warn(`[enroll] ${e.message}`);
      return out;
    }
  }

  return {
    tick,
    /** For the heartbeat, so the console can show enrolment without polling the node. */
    status: () => ({ ...csr.state({ dir, nodeId }), last_error: lastError }),
  };
}

module.exports = { createEnroller };
