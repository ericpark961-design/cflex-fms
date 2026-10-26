// node --test apps/console/test/enroll.e2e.test.js
//
// Registration, end to end, for real: the console over HTTP with its own
// Redis and database, and the ACTUAL probe-agent enroller talking to it. No
// mock on either side.
//
// Everything before this verified one half against a stand-in — the console
// against a fake collector, the enroller against a fake console. Those can
// both pass while the two disagree about a header name, a field name, or who
// is allowed to do what. This is the first run where the two real pieces meet.
//
// What an operator does, in order:
//   1. 노드 추가            (node id, site, allowed sites)
//   2. 1회용 등록 토큰 발급
//   3. …collector enrols itself, CSR appears…
//   4. CSR 을 CA 에 주고 서명
//   5. 서명된 인증서 붙여넣기
//   6. …collector picks it up and installs…
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { startMiniRedis } = require('./support/mini-redis');
const { createApp } = require('../src/server');
const { createRedis } = require('../src/redis');
const dbmod = require('../src/db');

// The real probe-agent pieces, not copies.
const { createEnroller } = require('../../../probe-agent/src/portal/enroll');
const csrmod = require('../../../probe-agent/src/portal/csr');
const transport = require('../../../probe-agent/src/portal/transport');

const quiet = { log() {}, warn() {}, error() {} };
const hasOpenssl = () => { try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } };
const skip = !hasOpenssl() && 'openssl 없음';

let tmp, redisSrv, app, url, admin, cookie;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-e2e-'));
  fs.mkdirSync(path.join(tmp, 'twin', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'twin', 'index.html'), '<!doctype html><title>twin</title>');
  redisSrv = await startMiniRedis();

  const base = require('../src/config').load();
  const config = {
    ...base, nodeId: 'app01', redisUrl: redisSrv.url,
    dbPath: path.join(tmp, 'console.db'), secretKey: crypto.randomBytes(32).toString('hex'),
    cookieSecure: false, twinDir: path.join(tmp, 'twin'), tenant: 'HAEA', tenantName: 'HAEA',
  };
  const db = dbmod.open(config.dbPath);
  app = createApp({ config, db, redis: createRedis(config.redisUrl), log: quiet });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;

  app.settings.createUser({ username: 'admin', role: 'admin', password: 'Initial-Root-2026!', display_name: 'Admin' });
  // Log in and get past the forced password change, the way a person would.
  const login = async (pw) => {
    const r = await fetch(`${url}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: pw }),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  await login('Initial-Root-2026!');
  await fetch(`${url}/v1/auth/password`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    // `next`, not `password` — the first version silently left the account in
    // must_change and every admin call came back 403 password_change_required.
    body: JSON.stringify({ current: 'Initial-Root-2026!', next: 'Changed-Root-2026#' }),
  });
  await login('Changed-Root-2026#');

  admin = async (method, p, body) => {
    const r = await fetch(url + p, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
});

test.after(async () => {
  if (app?.server?.listening) await new Promise(r => app.server.close(r));
  app?.redis?.close?.();
  await redisSrv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** The CA the operator takes the CSR to. Not part of either service. */
function signCsr(csrPem, caDir) {
  const p = (f) => path.join(caDir, f);
  const ssl = (...a) => execFileSync('openssl', a, { cwd: caDir, stdio: 'pipe' });
  if (!fs.existsSync(p('ca.pem'))) {
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=ringon-test-ca',
      '-keyout', p('ca.key'), '-out', p('ca.pem'));
  }
  fs.writeFileSync(p('in.csr'), csrPem);
  fs.writeFileSync(p('ext'), 'extendedKeyUsage=clientAuth\n');
  ssl('x509', '-req', '-in', p('in.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
    '-days', '730', '-out', p('out.pem'), '-extfile', p('ext'));
  return { cert: fs.readFileSync(p('out.pem'), 'utf8'), ca: fs.readFileSync(p('ca.pem'), 'utf8') };
}

test('registration, end to end: console over HTTP and the real enroller', { skip }, async () => {
  const pki = path.join(tmp, 'pki-cap01');     // the collector's own directory
  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-ca-'));

  try {
    // ── 1. operator adds the node ──────────────────────────────────
    const add = await admin('POST', '/v1/console/portal/nodes', {
      node_id: 'cap01', site_id: 'HMA-FV', role: 'collector',
      allowed_sites: ['HMA-FV', 'KUS-IRV'],
    });
    assert.strictEqual(add.status, 201, JSON.stringify(add.json));
    assert.strictEqual(add.json.enrollment.state, 'expected',
      '전 단계에서는 collector 미접속으로 보여야 한다');

    // The collector needs a key to talk to the console at all.
    const k = await admin('POST', '/v1/console/collectors/cap01/key');
    const collectorKey = k.json.key;

    // ── 2. one-time enrolment token ────────────────────────────────
    const tok = await admin('POST', '/v1/console/portal/enrollments/cap01/enroll-token', { ttlMinutes: 30 });
    assert.strictEqual(tok.status, 200, JSON.stringify(tok.json));
    assert.ok(tok.json.token.length >= 40);

    const enroller = () => createEnroller({
      consoleUrl: url, nodeId: 'cap01', tenant: 'HAEA',
      token: collectorKey, dir: pki, request: transport.request, log: quiet,
      enrollToken: tok.json.token,
    });

    // ── 2b. without the token it is refused ────────────────────────
    const noToken = createEnroller({
      consoleUrl: url, nodeId: 'cap01', tenant: 'HAEA',
      token: collectorKey, dir: path.join(tmp, 'pki-notoken'), request: transport.request, log: quiet,
    });
    const refused = await noToken.tick();
    assert.strictEqual(refused.posted, false, '토큰 없이 등록이 통과했다');
    assert.match(refused.error, /enroll_token/);

    // ── 3. the collector enrols itself ─────────────────────────────
    const first = await enroller().tick();
    assert.strictEqual(first.generated, true, '키를 스스로 만들지 않았다');
    assert.strictEqual(first.posted, true, 'CSR 을 올리지 않았다');
    assert.strictEqual(first.installed, false, '아직 서명된 인증서가 없어야 한다');

    // the key is on the collector, 0600, and nowhere else
    assert.strictEqual(fs.statSync(path.join(pki, 'cap01.key')).mode & 0o777, 0o600);

    // ── 4. the operator sees the CSR ───────────────────────────────
    let view = await admin('GET', '/v1/console/portal');
    let row = view.json.enrollments.find(e => e.node_id === 'cap01');
    assert.strictEqual(row.state, 'pending', 'CSR 접수 상태로 보여야 한다');
    assert.ok(row.csr.includes('CERTIFICATE REQUEST'));
    assert.strictEqual(row.expect_cn, 'HAEA.cap01');
    assert.deepStrictEqual(row.allowed_sites, ['HMA-FV', 'KUS-IRV']);
    // What must never be here.
    assert.ok(!JSON.stringify(view.json).includes('PRIVATE KEY'), '개인키가 콘솔로 넘어왔다');

    // ── 5. CA signs, operator pastes ───────────────────────────────
    const signed = signCsr(row.csr, caDir);
    const put = await admin('POST', '/v1/console/portal/enrollments/cap01/cert', {
      cert: signed.cert, ca: signed.ca,
    });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));
    assert.strictEqual(put.json.enrollment.cert.cn, 'HAEA.cap01');
    assert.strictEqual(put.json.enrollment.cert.client_auth, true);

    // ── 6. the collector picks it up, unattended ───────────────────
    const second = await enroller().tick();
    assert.strictEqual(second.installed, true, '인증서를 가져오지 않았다');
    assert.strictEqual(second.state, 'signed');
    assert.ok(fs.existsSync(path.join(pki, 'cap01.pem')));
    assert.ok(fs.existsSync(path.join(pki, 'ringon-ca.pem')));

    // the installed certificate really matches the key that never moved
    const ours = crypto.createPublicKey(fs.readFileSync(path.join(pki, 'cap01.key')))
      .export({ type: 'spki', format: 'der' });
    const inst = new crypto.X509Certificate(fs.readFileSync(path.join(pki, 'cap01.pem')))
      .publicKey.export({ type: 'spki', format: 'der' });
    assert.ok(ours.equals(inst), '설치된 인증서가 이 노드의 키와 맞지 않는다');

    // ── 7. the page shows it as done, and the token is spent ───────
    view = await admin('GET', '/v1/console/portal');
    row = view.json.enrollments.find(e => e.node_id === 'cap01');
    assert.strictEqual(row.state, 'signed');
    assert.strictEqual(row.renew_due, false);
    assert.ok(row.cert.days_left > 700);

    // Re-enrolling with a NEW key pair must cost a fresh token: the one above
    // is spent, which is the whole point of it being single use.
    const rotated = createEnroller({
      consoleUrl: url, nodeId: 'cap01', tenant: 'HAEA',
      token: collectorKey, dir: path.join(tmp, 'pki-rotate'), request: transport.request, log: quiet,
      enrollToken: tok.json.token,
    });
    const reuse = await rotated.tick();
    assert.strictEqual(reuse.posted, false, '소진된 토큰이 재사용됐다');
    assert.match(reuse.error, /enroll_token_invalid/);

    // ── 8. an idle tick does nothing at all ────────────────────────
    const third = await enroller().tick();
    assert.strictEqual(third.state, 'signed');
    assert.strictEqual(third.generated, false);
    assert.strictEqual(third.installed, false);
  } finally {
    fs.rmSync(caDir, { recursive: true, force: true });
  }
});

test('the collector cannot send for a site it was not registered for', { skip }, async () => {
  // The same registration governs data, not just certificates: Collector ID
  // and Site ID are separate and the server checks the pairing.
  const k = await admin('POST', '/v1/console/collectors/cap01/key');
  const post = (site) => fetch(`${url}/collector/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cflex-node': 'cap01', authorization: `Bearer ${k.json.key}` },
    body: JSON.stringify({
      events: [{
        event_id: crypto.randomUUID(), alarm_id: crypto.randomUUID(),
        device_id: 'deadbeefdeadbeef', site_id: site,
        ts: new Date().toISOString(), kind: 'info', severity: 'P4',
        code: 'UPS_SELFTEST_OK', title: 'e2e', source: 'rule',
      }],
    }),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  assert.strictEqual((await post('HMA-FV')).status, 200);
  const bad = await post('HAEA-HQ');
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.error, 'site_not_allowed');
});
