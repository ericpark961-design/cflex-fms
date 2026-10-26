// node --test test/portal.test.js
//
// The 포털 연동 page writes the collector's link settings and installs its
// device certificate. Two failures here are silent, and silent is the problem:
//
//   · the wrong node's certificate pasted in — the collector installs it, the
//     Portal rejects every call, and nothing on screen says why
//   · the device private key ending up in this database or on this screen
//
// So the assertions are mostly about refusals, and one of them walks the whole
// enrolment round trip the way an engineer and an admin actually would.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPortal } = require('../src/portal');
const { createSealer } = require('../src/seal');
const dbmod = require('../src/db');

const hasOpenssl = () => { try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } };

function fresh() {
  const db = dbmod.open(':memory:');
  const sealer = createSealer(Buffer.alloc(32, 7).toString('hex'));
  // Anchored to the real clock: openssl issues the test certificates against
  // it, so a fake epoch a year in the past makes every expiry assertion wrong.
  let t = Date.now();
  const portal = createPortal(db, {
    sealer, tenant: 'HAEA', now: () => t,
    // Injected: a unit test must not reach the network, and the real checks
    // live in probe-agent/src/portal/check.js with their own tests.
    checker: async (opts) => ({
      summary: { pass: 1, warn: 0, fail: 0, skip: 0 }, linked: true, blockers: [],
      checks: [{ id: 'STUB', verdict: 'PASS', title: 'stub', detail: '', ref: null }],
      _opts: opts,
    }),
  });
  // Enrolling now costs a one-time token, so the harness issues one the way
  // an operator would. Helper rather than inline: every enrolment test needs it.
  const enrol = (node, body) => {
    if (!portal.listEnrollments().some(e => e.node_id === node)) {
      portal.addNode({ node_id: node, site_id: 'TEST-SITE', role: 'collector' }, 'admin');
    }
    const { token } = portal.issueEnrollToken(node, {}, 'admin');
    return portal.enroll(node, { ...body, enroll_token: token });
  };
  return { db, portal, enrol, tick: (ms) => { t += ms; } };
}

/** A CA and a node certificate, the way the Portal would issue them. */
function issue({ cn = 'HAEA.cap01', days = 730, clientAuth = true, key = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-enrol-'));
  const p = (f) => path.join(dir, f);
  const ssl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });

  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=ringon-test-ca',
    '-keyout', p('ca.key'), '-out', p('ca.pem'));

  const keyPath = key || p('node.key');
  if (!key) ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath);

  fs.writeFileSync(p('csr.cnf'), [
    '[req]', 'prompt = no', 'distinguished_name = dn', 'req_extensions = ext', '',
    '[dn]', `CN = ${cn}`, '',
    '[ext]', `subjectAltName = DNS:${cn}`,
    ...(clientAuth ? ['extendedKeyUsage = clientAuth'] : ['extendedKeyUsage = serverAuth']), '',
  ].join('\n'));
  ssl('req', '-new', '-key', keyPath, '-out', p('node.csr'), '-config', p('csr.cnf'), '-sha256');

  fs.writeFileSync(p('crt.ext'), [
    `subjectAltName = DNS:${cn}`,
    ...(clientAuth ? ['extendedKeyUsage = clientAuth'] : ['extendedKeyUsage = serverAuth']),
  ].join('\n') + '\n');
  ssl('x509', '-req', '-in', p('node.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
    '-days', String(days), '-out', p('node.pem'), '-extfile', p('crt.ext'));

  return {
    dir, keyPath,
    csr: fs.readFileSync(p('node.csr'), 'utf8'),
    cert: fs.readFileSync(p('node.pem'), 'utf8'),
    ca: fs.readFileSync(p('ca.pem'), 'utf8'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── configuration ───────────────────────────────────────────────────

test('defaults are the contract numbers, not guesses', () => {
  const { portal, enrol } = fresh();
  const c = portal.get();
  assert.strictEqual(c.url, 'https://cflex.fms.support');     // 계약 §1
  assert.strictEqual(c.ip_pin, '40.114.79.164');              // 계약 §1
  assert.strictEqual(c.heartbeat_ms, 60_000);                 // 계약 §3.1 / D-07
  assert.strictEqual(c.buffer_days, 7);                       // D-07
  assert.strictEqual(c.legacy_forward, false);                // 구 경로는 기본 off
});

test('http:// is refused — a device cert and telemetry in the clear', () => {
  const { portal, enrol } = fresh();
  // Asserted on `code`, not the message: the code is the stable contract the
  // screen branches on, the message is human text that will get reworded.
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.strictEqual(code(() => portal.put({ url: 'http://cflex.fms.support' })), 'invalid_url');
  assert.strictEqual(code(() => portal.put({ url: 'not a url' })), 'invalid_url');
  assert.strictEqual(code(() => portal.put({ url: '' })), 'invalid_url');
  assert.throws(() => portal.put({ url: 'http://x' }), /https/, 'the reason should name the scheme');
  assert.strictEqual(portal.get().url, 'https://cflex.fms.support', 'a refused write must not land');
});

test('polling is floored at 10s — below that a 48-device cycle never finishes', () => {
  const { portal, enrol } = fresh();
  assert.strictEqual(portal.put({ poll_ms: 1 }).poll_ms, 10_000);      // spec 01 §2.1
  assert.strictEqual(portal.put({ poll_ms: 'abc' }).poll_ms, 60_000);  // falls back, not NaN
  assert.strictEqual(portal.put({ heartbeat_ms: 1 }).heartbeat_ms, 30_000);
  assert.strictEqual(portal.put({ buffer_days: 999 }).buffer_days, 30);
});

test('the proxy password is sealed, and never returned to the screen', () => {
  const { db, portal, enrol } = fresh();
  portal.put({ proxy: 'http://proxy.haeaus.com:8080', proxy_password: 's3cret' }, 'admin');

  const shown = portal.get();
  assert.deepStrictEqual(shown.proxy_password, { set: true }, 'the screen must not get the value');
  assert.strictEqual(portal.get({ open: true }).proxy_password, 's3cret', 'the collector pull must');

  const raw = db.prepare("SELECT value FROM settings WHERE key = 'portal'").get().value;
  assert.ok(!raw.includes('s3cret'), 'stored in the clear');

  // `{set:true}` round-tripped from a GET means "leave it alone".
  portal.put({ proxy_password: { set: true }, proxy: 'http://other:3128' }, 'admin');
  assert.strictEqual(portal.get({ open: true }).proxy_password, 's3cret');
  // and an explicit empty clears it
  portal.put({ proxy_password: '' }, 'admin');
  assert.strictEqual(portal.get({ open: true }).proxy_password, undefined);
});

// ── enrolment ───────────────────────────────────────────────────────

test('a collector posts its CSR, an admin installs the signed certificate', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, enrol } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    // 1. the collector enrols. The key is not in this call.
    const e1 = enrol('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    assert.strictEqual(e1.state, 'pending');
    assert.ok(!/PRIVATE KEY/.test(m.csr), 'a CSR must not carry the key');

    // 2. nothing to pick up yet
    assert.deepStrictEqual(portal.certsFor('cap01'), { pending: true });

    // 3. the admin pastes what the CA signed
    const e2 = portal.signCert('cap01', { cert: m.cert, ca: m.ca }, 'admin');
    assert.strictEqual(e2.state, 'signed');
    assert.strictEqual(e2.cert.cn, 'HAEA.cap01');
    assert.strictEqual(e2.cert.client_auth, true);

    // 4. the collector picks it up
    const got = portal.certsFor('cap01');
    assert.strictEqual(got.pending, false);
    assert.strictEqual(got.cert.trim(), m.cert.trim());
    assert.strictEqual(got.ca.trim(), m.ca.trim());
  } finally { m.cleanup(); }
});

test('the wrong node\'s certificate is refused by public key', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  // The failure this prevents: cap01's row gets app01's certificate, the
  // collector installs it, every Portal call 401s, and the screen looks fine.
  const { portal, enrol } = fresh();
  const mine = issue({ cn: 'HAEA.cap01' });
  const theirs = issue({ cn: 'HAEA.cap01' });   // same CN, different key pair
  try {
    enrol('cap01', { csr: mine.csr, pubkey_sha256: pub(mine.csr) });
    assert.throws(() => portal.signCert('cap01', { cert: theirs.cert }, 'admin'),
      (e) => e.code === 'key_mismatch' && /공개키/.test(e.message));
    assert.deepStrictEqual(portal.certsFor('cap01'), { pending: true }, 'a refused cert must not land');
  } finally { mine.cleanup(); theirs.cleanup(); }
});

test('CN must be tenant.node, and clientAuth is required', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, enrol } = fresh();
  const wrongCn = issue({ cn: 'HAEA.app99' });
  try {
    enrol('cap01', { csr: wrongCn.csr, pubkey_sha256: pub(wrongCn.csr) });
    assert.throws(() => portal.signCert('cap01', { cert: wrongCn.cert }, 'admin'),
      (e) => e.code === 'cn_mismatch' && /HAEA\.cap01/.test(e.message));
  } finally { wrongCn.cleanup(); }

  const noEku = issue({ cn: 'HAEA.cap02', clientAuth: false });
  try {
    enrol('cap02', { csr: noEku.csr, pubkey_sha256: pub(noEku.csr) });
    assert.throws(() => portal.signCert('cap02', { cert: noEku.cert }, 'admin'),
      (e) => e.code === 'no_client_auth');
  } finally { noEku.cleanup(); }
});

test('garbage and oversized input are refused before parsing', () => {
  const { portal, enrol } = fresh();
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.strictEqual(code(() => enrol('cap01', { csr: 'hello' })), 'invalid_csr');
  assert.strictEqual(code(() => portal.enroll('cap01', { csr: `-----BEGIN CERTIFICATE REQUEST-----\n${'A'.repeat(9000)}\n-----END CERTIFICATE REQUEST-----` })), 'invalid_csr');
  assert.strictEqual(code(() => portal.enroll('', { csr: 'x' })), 'node_required');
  assert.strictEqual(code(() => portal.signCert('nope', { cert: 'x' })), 'no_enrollment');
  assert.strictEqual(code(() => portal.put({ ip_pin: 'nonsense' })), 'invalid_ip_pin');
  assert.strictEqual(code(() => portal.put({ proxy: 'not a url' })), 'invalid_proxy');
});

test('a re-posted CSR is a no-op; a NEW CSR drops the certificate', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, enrol } = fresh();
  const a = issue({ cn: 'HAEA.cap01' });
  const b = issue({ cn: 'HAEA.cap01' });     // re-enrolment: new key pair
  try {
    enrol('cap01', { csr: a.csr, pubkey_sha256: pub(a.csr) });
    portal.signCert('cap01', { cert: a.cert, ca: a.ca }, 'admin');
    assert.strictEqual(portal.certsFor('cap01').pending, false);

    // Same CSR again — the collector restarted, nothing changed.
    const same = enrol('cap01', { csr: a.csr, pubkey_sha256: pub(a.csr) });
    assert.strictEqual(same.unchanged, true);
    assert.strictEqual(portal.certsFor('cap01').pending, false, 'a restart must not drop the cert');

    // A new key pair makes the held certificate dead, so it must go.
    enrol('cap01', { csr: b.csr, pubkey_sha256: pub(b.csr) });
    assert.deepStrictEqual(portal.certsFor('cap01'), { pending: true },
      'a new CSR left the old certificate in place');
  } finally { a.cleanup(); b.cleanup(); }
});

test('revoking keeps the CSR so the node can be re-signed', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, enrol } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    enrol('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    portal.signCert('cap01', { cert: m.cert, ca: m.ca }, 'admin');
    const r = portal.revoke('cap01', 'admin');
    assert.strictEqual(r.state, 'pending');
    assert.ok(r.csr.includes('CERTIFICATE REQUEST'), 'the CSR must survive — the key still matches it');
    // and re-signing the same certificate works without a new key
    assert.strictEqual(portal.signCert('cap01', { cert: m.cert }, 'admin').state, 'signed');
  } finally { m.cleanup(); }
});

test('an expired certificate is refused', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, enrol, tick } = fresh();
  const m = issue({ cn: 'HAEA.cap01', days: 1 });
  try {
    enrol('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    tick(3 * 86_400_000);
    assert.throws(() => portal.signCert('cap01', { cert: m.cert }, 'admin'),
      (e) => e.code === 'expired');
  } finally { m.cleanup(); }
});

test('renew_due flags a certificate inside the 60-day window', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, enrol, tick } = fresh();
  const m = issue({ cn: 'HAEA.cap01', days: 80 });
  try {
    enrol('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    portal.signCert('cap01', { cert: m.cert }, 'admin');
    assert.strictEqual(portal.listEnrollments()[0].renew_due, false);
    tick(30 * 86_400_000);                      // 50일 남음
    assert.strictEqual(portal.listEnrollments()[0].renew_due, true);   // 계약 §1, §6-2
  } finally { m.cleanup(); }
});

// ── the private key is nowhere near this ────────────────────────────

test('no private key reaches the database or the listing', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { db, portal, enrol } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    enrol('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    portal.signCert('cap01', { cert: m.cert, ca: m.ca }, 'admin');

    const dump = JSON.stringify(db.prepare('SELECT * FROM enrollments').all())
      + JSON.stringify(portal.listEnrollments())
      + JSON.stringify(portal.certsFor('cap01'));
    for (const marker of ['PRIVATE KEY', 'BEGIN EC PARAMETERS']) {
      assert.ok(!dump.includes(marker), `${marker} reached the console`);
    }
    // And the real key file on disk is not readable from any of this.
    const key = fs.readFileSync(m.keyPath, 'utf8');
    assert.ok(!dump.includes(key.trim().split('\n')[1]), 'key material leaked');
  } finally { m.cleanup(); }
});

// ── the check ───────────────────────────────────────────────────────

test('check passes the stored settings and the held certificate through', { skip: !hasOpenssl() && 'openssl 없음' }, async () => {
  const { portal, enrol } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    portal.put({ url: 'https://portal.test', ip_pin: null, proxy: 'http://p:8080' }, 'admin');
    enrol('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    portal.signCert('cap01', { cert: m.cert, ca: m.ca }, 'admin');

    const r = await portal.check({ node_id: 'cap01' });
    assert.strictEqual(r._opts.url, 'https://portal.test');
    assert.strictEqual(r._opts.tenant, 'HAEA');
    assert.strictEqual(r._opts.nodeId, 'cap01');
    assert.strictEqual(r._opts.pinnedIp, '');          // null pin disables it
    assert.strictEqual(r._opts.proxy, 'http://p:8080');
    assert.ok(r._opts.tls.cert.includes('BEGIN CERTIFICATE'));
    assert.strictEqual(r._opts.tls.key, null, 'the key is on the collector, not here');
    assert.strictEqual(r.ran_from, 'app');
    // Said plainly rather than left for someone to infer from a green screen.
    assert.match(r.note, /collector/);
  } finally { m.cleanup(); }
});

test('check without a certificate says so instead of looking fine', async () => {
  const { portal, enrol } = fresh();
  const r = await portal.check({});
  assert.strictEqual(r._opts.tls.cert, undefined);
  assert.match(r.note, /익명/);
});

/** The CSR's public key fingerprint, the way cflex-csr computes it for the Portal. */
function pub(csrPem) {
  const spki = execFileSync('openssl', ['req', '-pubkey', '-noout'], { input: csrPem, encoding: 'utf8' });
  return require('node:crypto').createHash('sha256')
    .update(require('node:crypto').createPublicKey(spki).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

// ── first-registration credential ───────────────────────────────────
// The collector key authenticates ongoing calls but is permanent and
// reusable: a leaked one would let anyone replace that node's key pair for
// ever, taking over its identity while every call still authenticates. So
// enrolling — and re-enrolling, which is the same act — costs a separate
// credential that is node-scoped, expiring and consumed on use.

test('enrolling without a token is refused', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    portal.addNode({ node_id: 'cap01', site_id: 'TEST-SITE' }, 'admin');
    assert.throws(() => portal.enroll('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) }),
      (e) => e.code === 'enroll_token_required');
    assert.deepStrictEqual(portal.certsFor('cap01'), { pending: true });
  } finally { m.cleanup(); }
});

test('a token is single use', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal } = fresh();
  const a = issue({ cn: 'HAEA.cap01' });
  const b = issue({ cn: 'HAEA.cap01' });
  try {
    portal.addNode({ node_id: 'cap01', site_id: 'TEST-SITE' }, 'admin');
    const { token } = portal.issueEnrollToken('cap01', {}, 'admin');
    portal.enroll('cap01', { csr: a.csr, pubkey_sha256: pub(a.csr), enroll_token: token });

    // The same token cannot install a different key pair afterwards — that is
    // exactly the identity takeover this is for.
    assert.throws(() => portal.enroll('cap01', { csr: b.csr, pubkey_sha256: pub(b.csr), enroll_token: token }),
      (e) => e.code === 'enroll_token_invalid');
    assert.strictEqual(portal.listEnrollTokens()[0].state, 'used');
  } finally { a.cleanup(); b.cleanup(); }
});

test('a restart re-posting the same CSR needs no token', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  // Otherwise every collector reboot would wait on an operator.
  const { portal } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    portal.addNode({ node_id: 'cap01', site_id: 'TEST-SITE' }, 'admin');
    const { token } = portal.issueEnrollToken('cap01', {}, 'admin');
    portal.enroll('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr), enroll_token: token });
    const again = portal.enroll('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr) });
    assert.strictEqual(again.unchanged, true);
  } finally { m.cleanup(); }
});

test('a token is scoped to one node and one tenant', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal } = fresh();
  const m = issue({ cn: 'HAEA.cap02' });
  try {
    portal.addNode({ node_id: 'cap01', site_id: 'TEST-SITE' }, 'admin');
    portal.addNode({ node_id: 'cap02', site_id: 'TEST-SITE' }, 'admin');
    const { token } = portal.issueEnrollToken('cap01', {}, 'admin');
    // cap02 presenting cap01's token
    assert.throws(() => portal.enroll('cap02', { csr: m.csr, pubkey_sha256: pub(m.csr), enroll_token: token }),
      (e) => e.code === 'enroll_token_invalid');
    // and the refusal says nothing about whose token it was: an attacker must
    // not learn whether a token exists or belongs elsewhere.
    try { portal.enroll('cap02', { csr: m.csr, enroll_token: token }); } catch (e) {
      assert.ok(!/cap01/.test(e.message), 'the error disclosed the token owner');
    }
  } finally { m.cleanup(); }
});

test('a token expires', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const { portal, tick } = fresh();
  const m = issue({ cn: 'HAEA.cap01' });
  try {
    portal.addNode({ node_id: 'cap01', site_id: 'TEST-SITE' }, 'admin');
    const t = portal.issueEnrollToken('cap01', { ttlMinutes: 10 }, 'admin');
    tick(11 * 60_000);
    assert.throws(() => portal.enroll('cap01', { csr: m.csr, pubkey_sha256: pub(m.csr), enroll_token: t.token }),
      (e) => e.code === 'enroll_token_invalid');
    assert.strictEqual(portal.listEnrollTokens()[0].state, 'expired');
  } finally { m.cleanup(); }
});

test('only the hash is stored', () => {
  const { db, portal } = fresh();
  portal.addNode({ node_id: 'cap01', site_id: 'TEST-SITE' }, 'admin');
  const { token } = portal.issueEnrollToken('cap01', {}, 'admin');
  const dump = JSON.stringify(db.prepare('SELECT * FROM enroll_tokens').all())
    + JSON.stringify(portal.listEnrollTokens());
  assert.ok(!dump.includes(token), 'the token itself is recoverable from the database');
});

// ── collector id vs site id ─────────────────────────────────────────

test('allowed sites are checked server-side, not taken from the payload', () => {
  const { portal } = fresh();
  portal.addNode({ node_id: 'cap01', site_id: 'HMA-FV', allowed_sites: ['HMA-FV', 'KUS-IRV'] }, 'admin');

  assert.ok(portal.assertSite('cap01', 'HMA-FV'));
  assert.ok(portal.assertSite('cap01', 'KUS-IRV'));
  assert.throws(() => portal.assertSite('cap01', 'HAEA-HQ'), (e) => e.code === 'site_not_allowed');
  assert.throws(() => portal.assertSite('cap01', ''), (e) => e.code === 'site_required');
  // An unregistered collector is refused outright rather than defaulted in.
  assert.throws(() => portal.assertSite('ghost', 'HMA-FV'), (e) => e.code === 'node_not_registered');
});

test('a node with no explicit list may only use its own site', () => {
  const { portal } = fresh();
  portal.addNode({ node_id: 'cap01', site_id: 'HMA-FV' }, 'admin');
  assert.deepStrictEqual(portal.listEnrollments()[0].allowed_sites, ['HMA-FV']);
  assert.throws(() => portal.assertSite('cap01', 'KUS-IRV'), (e) => e.code === 'site_not_allowed');

  portal.setAllowedSites('cap01', ['HMA-FV', 'KUS-IRV'], 'admin');
  assert.ok(portal.assertSite('cap01', 'KUS-IRV'));
  // An empty list accepts nothing — a node that may send nowhere is a valid
  // state (suspended), and silently meaning "anywhere" would be the opposite.
  portal.setAllowedSites('cap01', [], 'admin');
  assert.throws(() => portal.assertSite('cap01', 'HMA-FV'), (e) => e.code === 'site_not_allowed');
  assert.throws(() => portal.setAllowedSites('cap01', ['bad-lower'], 'admin'), (e) => e.code === 'invalid_site_id');
});
