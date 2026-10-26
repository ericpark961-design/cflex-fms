// node --test test/enroll.test.js
//
// The collector enrols itself so nobody ssh-es in to run a CLI. The failures
// that matters are the silent ones: a key quietly regenerated (the Portal's
// certificate dies), or someone else's certificate installed unattended (every
// Portal call 401s with nothing on disk saying why).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const csr = require('../src/portal/csr');
const { createEnroller } = require('../src/portal/enroll');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-enroll-'));
const skip = !csr.hasOpenssl() && 'openssl 없음';

/** A CA that signs a CSR, the way the Portal's CA would. */
function sign(csrPem, { days = 730, clientAuth = true } = {}) {
  const d = tmp();
  const p = (f) => path.join(d, f);
  const ssl = (...a) => execFileSync('openssl', a, { cwd: d, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-ca',
    '-keyout', p('ca.key'), '-out', p('ca.pem'));
  fs.writeFileSync(p('in.csr'), csrPem);
  fs.writeFileSync(p('ext'), `extendedKeyUsage=${clientAuth ? 'clientAuth' : 'serverAuth'}\n`);
  ssl('x509', '-req', '-in', p('in.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
    '-days', String(days), '-out', p('out.pem'), '-extfile', p('ext'));
  const out = { cert: fs.readFileSync(p('out.pem'), 'utf8'), ca: fs.readFileSync(p('ca.pem'), 'utf8') };
  fs.rmSync(d, { recursive: true, force: true });
  return out;
}

/** A console that behaves like apps/console's collector endpoints. */
function fakeConsole() {
  const state = { csr: null, pubkey: null, cert: null, ca: null, calls: [], fault: null, requireToken: null };
  const request = async ({ method, url, body, headers }) => {
    const p = new URL(url).pathname;
    state.calls.push(`${method} ${p}`);
    if (!headers['X-CFlex-Node'] || !/^Bearer .+/.test(headers.Authorization || '')) {
      return { status: 401, json: { error: 'unauthorized' } };
    }
    if (state.fault) { const f = state.fault; state.fault = null; return { status: f, json: { error: 'fault' } }; }
    if (p === '/collector/v1/enroll') {
      const b = JSON.parse(body.toString());
      const unchanged = state.csr === b.csr;
      // Mirrors the console: a NEW key pair costs a one-time token, a restart
      // re-posting the same CSR does not.
      if (!unchanged && state.requireToken && headers['X-Enroll-Token'] !== state.requireToken) {
        return { status: 400, json: { ok: false, error: 'enroll_token_invalid' } };
      }
      if (!unchanged) { state.csr = b.csr; state.pubkey = b.pubkey_sha256; state.cert = null; state.ca = null; }
      return { status: 200, json: { ok: true, unchanged } };
    }
    if (p === '/collector/v1/certs') {
      return state.cert
        ? { status: 200, json: { ok: true, pending: false, cert: state.cert, ca: state.ca } }
        : { status: 200, json: { ok: true, pending: true } };
    }
    return { status: 404, json: {} };
  };
  return { state, request };
}

const quiet = { log() {}, warn() {}, error() {} };
const enroller = (dir, c, over = {}) => createEnroller({
  consoleUrl: 'https://app01.test', nodeId: 'cap01', tenant: 'HAEA',
  token: 'collector-key', dir, request: c.request, log: quiet, ...over,
});

test('boot → CSR posted → operator signs → certificate installed', { skip }, async () => {
  const dir = tmp();
  const c = fakeConsole();
  try {
    const e = enroller(dir, c);

    // 1. first tick: generate, post, nothing to collect yet
    let r = await e.tick();
    assert.strictEqual(r.generated, true);
    assert.strictEqual(r.posted, true);
    assert.strictEqual(r.installed, false);
    assert.ok(c.state.csr.includes('CERTIFICATE REQUEST'));
    assert.ok(!c.state.csr.includes('PRIVATE KEY'), 'the key must not travel');
    assert.strictEqual(fs.statSync(path.join(dir, 'cap01.key')).mode & 0o777, 0o600);
    assert.strictEqual(e.status().state, 'pending');

    // 2. ticks while nobody has signed yet: no churn, no regeneration
    r = await e.tick();
    assert.strictEqual(r.generated, false, 'a second tick regenerated the key');
    assert.strictEqual(e.status().state, 'pending');

    // 3. the operator pastes a signed certificate
    Object.assign(c.state, sign(c.state.csr));
    r = await e.tick();
    assert.strictEqual(r.installed, true);
    assert.strictEqual(r.state, 'signed');
    assert.ok(fs.existsSync(path.join(dir, 'cap01.pem')));
    assert.ok(fs.existsSync(path.join(dir, 'ringon-ca.pem')));

    // 4. once enrolled it stops talking to the console entirely
    const before = c.state.calls.length;
    r = await e.tick();
    assert.strictEqual(c.state.calls.length, before, 'kept polling after enrolment');
    assert.strictEqual(r.state, 'signed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('another node\'s certificate is refused, and not written', { skip }, async () => {
  const dir = tmp();
  const other = tmp();
  const c = fakeConsole();
  try {
    const e = enroller(dir, c);
    await e.tick();

    // A certificate with the right CN but a different key pair — the mistake
    // an operator makes with two pending nodes open in two tabs.
    const theirs = csr.ensure({ dir: other, tenant: 'HAEA', nodeId: 'cap01' });
    Object.assign(c.state, sign(theirs.csr));

    const r = await e.tick();
    assert.strictEqual(r.installed, false);
    assert.match(r.error, /public key does not match/);
    assert.ok(!fs.existsSync(path.join(dir, 'cap01.pem')), 'a refused certificate was written');
    assert.strictEqual(e.status().state, 'pending');
  } finally { for (const d of [dir, other]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('a certificate for the wrong node is refused by CN', { skip }, async () => {
  const dir = tmp();
  const c = fakeConsole();
  try {
    const e = createEnroller({
      consoleUrl: 'https://app01.test', nodeId: 'cap01', tenant: 'HAEA',
      token: 'k', dir, request: c.request, log: quiet,
    });
    await e.tick();
    // Same key, CN for app01: re-sign this node's CSR under a different subject.
    const mine = fs.readFileSync(path.join(dir, 'cap01.csr'), 'utf8');
    const wrong = sign(mine);
    // Rewrite the enroller's expectation instead of forging a subject: the
    // check under test is CN vs tenant.node, and openssl x509 -req keeps the
    // CSR's subject, so the honest way is to enrol as a different node.
    const e2 = createEnroller({
      consoleUrl: 'https://app01.test', nodeId: 'app01', tenant: 'HAEA',
      token: 'k', dir, request: c.request, log: quiet,
    });
    await e2.tick();                       // makes app01's own key + CSR
    c.state.cert = wrong.cert;             // but hand it cap01's certificate
    c.state.ca = wrong.ca;
    const r = await e2.tick();
    assert.strictEqual(r.installed, false);
    assert.match(r.error, /CN=HAEA\.cap01, expected HAEA\.app01|public key does not match/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install() rejects an expired certificate', { skip }, () => {
  // Backdated by the CA rather than faked: openssl can issue a window that has
  // already closed, which is the only honest way to exercise this without a
  // clock injection.
  //
  // An earlier version of this test wrapped everything in try/catch with a
  // placeholder assertion and reported `ok` no matter what happened. A test
  // that cannot fail is worse than no test.
  const dir = tmp();
  const d = tmp();
  try {
    const mine = csr.ensure({ dir, tenant: 'HAEA', nodeId: 'cap01' });
    const p = (f) => path.join(d, f);
    const ssl = (...a) => execFileSync('openssl', a, { cwd: d, stdio: 'pipe' });
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=test-ca',
      '-keyout', p('ca.key'), '-out', p('ca.pem'));
    fs.writeFileSync(p('in.csr'), mine.csr);
    fs.writeFileSync(p('ext'), 'extendedKeyUsage=clientAuth\n');
    // A window that ended yesterday.
    const stamp = (offsetDays) => {
      const t = new Date(Date.now() + offsetDays * 86_400_000);
      const z = (n) => String(n).padStart(2, '0');
      return `${t.getUTCFullYear()}${z(t.getUTCMonth() + 1)}${z(t.getUTCDate())}${z(t.getUTCHours())}${z(t.getUTCMinutes())}${z(t.getUTCSeconds())}Z`;
    };
    ssl('x509', '-req', '-in', p('in.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
      '-not_before', stamp(-10), '-not_after', stamp(-1),
      '-out', p('out.pem'), '-extfile', p('ext'));

    const expired = fs.readFileSync(p('out.pem'), 'utf8');
    assert.throws(
      () => csr.install({ dir, tenant: 'HAEA', nodeId: 'cap01', cert: expired, ca: null }),
      /already expired/,
    );
    assert.ok(!fs.existsSync(path.join(dir, 'cap01.pem')), 'an expired certificate was written');
  } finally { for (const x of [dir, d]) fs.rmSync(x, { recursive: true, force: true }); }
});

test('an unreachable console does not stop the collector', { skip }, async () => {
  const dir = tmp();
  const c = fakeConsole();
  try {
    const e = enroller(dir, c);
    c.state.fault = 503;
    const r = await e.tick();          // must not throw
    assert.strictEqual(r.installed, false);
    assert.match(r.error, /HTTP 503/);
    // and the next tick recovers without regenerating the key
    const keyBefore = fs.readFileSync(path.join(dir, 'cap01.key'), 'utf8');
    await e.tick();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cap01.key'), 'utf8'), keyBefore);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-enrolment with a new key drops the dead certificate from disk', { skip }, async () => {
  const dir = tmp();
  const c = fakeConsole();
  try {
    const e = enroller(dir, c);
    await e.tick();
    Object.assign(c.state, sign(c.state.csr));
    await e.tick();
    assert.ok(fs.existsSync(path.join(dir, 'cap01.pem')));

    // A deliberate re-enrolment: new key pair, so the certificate we hold is
    // dead and leaving it on disk is how a node presents a stale certificate.
    csr.ensure({ dir, tenant: 'HAEA', nodeId: 'cap01', force: true });
    assert.ok(!fs.existsSync(path.join(dir, 'cap01.pem')), 'stale certificate left behind');
    assert.strictEqual(csr.state({ dir, nodeId: 'cap01' }).state, 'pending');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI and the automatic path share one implementation', () => {
  // Two code paths that both make a device key would drift, and the drift
  // would only show up as a Portal 401 at a customer site.
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'cflex-csr.js'), 'utf8');
  assert.match(src, /require\('\.\.\/src\/portal\/csr'\)/, 'the CLI must use the module');
  assert.ok(!/ecparam/.test(src), 'the CLI still generates a key itself');
});

test('an HTML catch-all is not mistaken for "no certificate yet"', { skip }, async () => {
  // Found against the real host: fms.runless.co.uk has an nginx catch-all that
  // answers any unknown path with the SPA's index.html — HTTP 200, text/html.
  // A collector pointed at the wrong URL would have retried for ever.
  const dir = tmp();
  try {
    const e = createEnroller({
      consoleUrl: 'https://spa.test', nodeId: 'cap01', tenant: 'HAEA', token: 'k', dir, log: quiet,
      request: async () => ({ status: 200, text: '<!DOCTYPE html><html lang="en"><head>', json: null }),
    });
    const r = await e.tick();
    assert.strictEqual(r.installed, false);
    assert.match(r.error, /body is not JSON/);
    assert.match(r.error, /CFLEX_CONSOLE_URL/, 'the message should name what to fix');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new key pair needs the one-time token, and the message says where to get it', { skip }, async () => {
  const dir = tmp();
  const c = fakeConsole();
  c.state.requireToken = 'one-time-abc';
  try {
    const without = enroller(dir, c);
    let r = await without.tick();
    assert.strictEqual(r.posted, false);
    assert.match(r.error, /enroll_token_invalid/);
    // The common first-run failure: say what to do rather than the status code.
    assert.match(r.error, /CFLEX_ENROLL_TOKEN/);

    const with_ = enroller(dir, c, { enrollToken: 'one-time-abc' });
    r = await with_.tick();
    assert.strictEqual(r.posted, true);
    assert.ok(c.state.csr.includes('CERTIFICATE REQUEST'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the token is sent as a header, never in the body', { skip }, async () => {
  // A token in a logged body is a token in the logs.
  const dir = tmp();
  const seen = [];
  try {
    const e = createEnroller({
      consoleUrl: 'https://app01.test', nodeId: 'cap01', tenant: 'HAEA', token: 'k',
      dir, log: quiet, enrollToken: 'secret-token',
      request: async (o) => { seen.push(o); return { status: 200, json: { ok: true, unchanged: false } }; },
    });
    await e.tick();
    const post = seen.find(o => o.method === 'POST');
    assert.strictEqual(post.headers['X-Enroll-Token'], 'secret-token');
    assert.ok(!post.body.toString().includes('secret-token'), 'the token went into the body');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plaintext to a remote host is refused, loopback is not', { skip }, async () => {
  // These requests carry the collector key and the one-time enrolment token.
  // The transport used to call https.request() whatever the URL said, so an
  // http:// console failed with `EPROTO … wrong version number` — an SSL error
  // naming nothing an operator can act on. Allowing it silently would be worse.
  const t = require('../src/portal/transport');
  await assert.rejects(
    () => t.request({ method: 'GET', url: 'http://console.haeaus.internal/collector/v1/certs', headers: {} }),
    (e) => e.code === 'plaintext_refused' && /credentials/.test(e.message),
  );
  await assert.rejects(
    () => t.request({ method: 'GET', url: 'http://127.0.0.1:1/x', headers: {}, proxy: 'http://p:8080' }),
    (e) => e.code === 'plaintext_refused',
  );
  // Loopback never crosses a network: a console and a collector on one host,
  // and the end-to-end test. Connection refused, not a scheme refusal.
  await assert.rejects(
    () => t.request({ method: 'GET', url: 'http://127.0.0.1:1/x', headers: {} }),
    (e) => e.code !== 'plaintext_refused',
  );
});
