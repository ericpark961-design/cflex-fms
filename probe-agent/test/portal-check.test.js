// node --test test/portal-check.test.js
//
// cflex-portal-check is a diagnostic, and a diagnostic that lies is worse than
// none: someone on the HAEA floor will act on its verdict. The run against the
// live cflex.fms.support reported three blockers — the valuable test is the
// inverse, that a Portal which DOES satisfy contract 00 comes back clean.
//
// So this points the tool at the same mock the forwarder E2E uses (mTLS
// required, version header, schema validation) and requires PASS on exactly
// the checks that failed live.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startMockPortal } = require('./support/mock-portal');
const { makeCerts, hasOpenssl } = require('./support/certs');

const BIN = path.join(__dirname, '..', 'bin', 'cflex-portal-check.js');
const CSR = path.join(__dirname, '..', 'bin', 'cflex-csr.js');

/**
 * Run the tool and parse its --json report. Exit code is part of the contract.
 *
 * ASYNC, deliberately. execFileSync blocks this process's event loop, and the
 * mock Portal runs IN this process — so the child's TCP connect succeeded (the
 * OS accepts into the listen backlog without us) while the TLS handshake timed
 * out, because nothing was left running to complete it. The first version of
 * this file reported "TLS handshake timeout" against a perfectly good mock.
 */
function run(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }, (err, stdout) => {
      const out = stdout || '';
      const i = out.indexOf('{');
      assert.ok(i >= 0, `no JSON in output:\n${out}`);
      resolve({ report: JSON.parse(out.slice(i)), code: err ? (err.code ?? 1) : 0 });
    });
  });
}
const verdict = (r, id) => r.checks.find(c => c.id === id)?.verdict;

test('a contract-conformant Portal comes back clean', { skip: !hasOpenssl() && 'openssl 없음' }, async () => {
  const certs = makeCerts();
  const portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  try {
    const { report, code } = await run({
      CFLEX_PORTAL_URL: `https://127.0.0.1:${portal.port}`,
      CFLEX_PORTAL_IP: '127.0.0.1',
      TENANT_ID: 'TEST',
      CFLEX_NODE_ID: 'cap01',
      CFLEX_TLS_CERT: certs.client.certPath,
      CFLEX_TLS_KEY: certs.client.keyPath,
      CFLEX_TLS_CA: certs.caPath,
      HTTPS_PROXY: '', NO_PROXY: '',
    });

    // The three that failed against the live host must pass here, or the tool
    // is reporting the same verdict regardless of the Portal.
    assert.strictEqual(verdict(report, 'MTLS'), 'PASS', 'mock requires a client cert; tool said otherwise');
    assert.strictEqual(verdict(report, 'CERT'), 'PASS', JSON.stringify(report.checks.find(c => c.id === 'CERT')));
    assert.strictEqual(verdict(report, 'API'), 'PASS', JSON.stringify(report.checks.find(c => c.id === 'API')));
    assert.strictEqual(verdict(report, 'VERSION'), 'PASS');
    assert.strictEqual(verdict(report, 'TLS'), 'PASS');
    assert.strictEqual(report.summary.fail, 0, `unexpected failures: ${
      report.checks.filter(c => c.verdict === 'FAIL').map(c => c.id).join(',')}`);
    assert.strictEqual(code, 0, 'exit code should be 0 when nothing blocks');
  } finally { await portal.close(); certs.cleanup(); }
});

test('no device certificate is a blocker, not a warning', { skip: !hasOpenssl() && 'openssl 없음' }, async () => {
  const certs = makeCerts();
  const portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  try {
    const { report, code } = await run({
      CFLEX_PORTAL_URL: `https://127.0.0.1:${portal.port}`,
      CFLEX_PORTAL_IP: '127.0.0.1',
      TENANT_ID: 'TEST', CFLEX_NODE_ID: 'cap01',
      CFLEX_TLS_CERT: '', CFLEX_TLS_KEY: '', CFLEX_TLS_CA: certs.caPath,
      HTTPS_PROXY: '', NO_PROXY: '',
    });
    assert.strictEqual(verdict(report, 'CERT'), 'FAIL');
    assert.match(report.checks.find(c => c.id === 'CERT').detail, /cflex-csr/, 'should say how to get one');
    // and the Portal rejecting us is then visible rather than mysterious
    assert.strictEqual(verdict(report, 'MTLS'), 'PASS', 'the mock still requires a cert');
    assert.strictEqual(code, 1);
  } finally { await portal.close(); certs.cleanup(); }
});

test('a CN that does not match tenant.node is caught', { skip: !hasOpenssl() && 'openssl 없음' }, async () => {
  // The Portal keys the node off CN (contract §1). A cert issued for the wrong
  // node authenticates as the wrong node, which is worse than being rejected.
  const certs = makeCerts();
  const portal = await startMockPortal({ server: certs.server, tenant: 'TEST' });
  try {
    const { report } = await run({
      CFLEX_PORTAL_URL: `https://127.0.0.1:${portal.port}`,
      CFLEX_PORTAL_IP: '127.0.0.1',
      TENANT_ID: 'TEST',
      CFLEX_NODE_ID: 'app02',          // cert was issued for a different node
      CFLEX_TLS_CERT: certs.client.certPath,
      CFLEX_TLS_KEY: certs.client.keyPath,
      CFLEX_TLS_CA: certs.caPath,
      HTTPS_PROXY: '', NO_PROXY: '',
    });
    const c = report.checks.find(x => x.id === 'CERT');
    assert.strictEqual(c.verdict, 'FAIL');
    assert.match(c.detail, /TEST\.app02 이어야 한다/);
  } finally { await portal.close(); certs.cleanup(); }
});

test('a closed port is reported as TCP, and nothing downstream is invented', async () => {
  // Port 1 on loopback: nothing listens. Everything after TCP must be absent
  // rather than guessed — a tool that reports "API FAIL" when it never
  // connected sends someone to the wrong team.
  const { report, code } = await run({
    CFLEX_PORTAL_URL: 'https://127.0.0.1:1',
    CFLEX_PORTAL_IP: '127.0.0.1',
    TENANT_ID: 'TEST', CFLEX_NODE_ID: 'cap01',
    CFLEX_TLS_CERT: '', CFLEX_TLS_KEY: '',
    HTTPS_PROXY: '', NO_PROXY: '',
  });
  assert.strictEqual(verdict(report, 'TCP'), 'FAIL');
  for (const id of ['TLS', 'MTLS', 'API', 'CERT']) {
    assert.strictEqual(verdict(report, id), undefined, `${id} was reported without a connection`);
  }
  assert.match(report.checks.find(c => c.id === 'TCP').ref, /443/);
  assert.strictEqual(code, 1);
});

test('clock drift beyond 60s warns, matching the event the probe would raise', { skip: !hasOpenssl() && 'openssl 없음' }, async () => {
  const certs = makeCerts();
  const portal = await startMockPortal({ server: certs.server, tenant: 'TEST', dateOffsetMs: -5 * 60_000 });
  try {
    const { report } = await run({
      CFLEX_PORTAL_URL: `https://127.0.0.1:${portal.port}`,
      CFLEX_PORTAL_IP: '127.0.0.1',
      TENANT_ID: 'TEST', CFLEX_NODE_ID: 'cap01',
      CFLEX_TLS_CERT: certs.client.certPath, CFLEX_TLS_KEY: certs.client.keyPath, CFLEX_TLS_CA: certs.caPath,
      HTTPS_PROXY: '', NO_PROXY: '',
    });
    const c = report.checks.find(x => x.id === 'CLOCK');
    assert.strictEqual(c.verdict, 'WARN');
    assert.match(c.detail, /CLOCK_DRIFT/);
  } finally { await portal.close(); certs.cleanup(); }
});

// ── cflex-csr ───────────────────────────────────────────────────────

test('cflex-csr writes a CSR the Portal CA can sign, and guards the key', { skip: !hasOpenssl() && 'openssl 없음' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-csr-'));
  try {
    const env = { ...process.env, TENANT_ID: 'HAEA', CFLEX_NODE_ID: 'cap01' };
    execFileSync(process.execPath, [CSR, '--dir', dir], { env, stdio: 'pipe' });

    const key = path.join(dir, 'cap01.key');
    const csr = path.join(dir, 'cap01.csr');
    assert.ok(fs.existsSync(key) && fs.existsSync(csr));

    // The key is the thing that must not leak. 0600, and the tool prints the
    // CSR's location rather than the key's contents.
    assert.strictEqual(fs.statSync(key).mode & 0o777, 0o600, 'key is not 0600');

    const info = execFileSync('openssl', ['req', '-in', csr, '-noout', '-subject', '-verify', '-text'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.match(info, /self-signature verify OK/);
    assert.match(info, /CN\s*=\s*HAEA\.cap01/, 'CN must be <tenant>.<node-id> (contract §1)');
    assert.match(info, /DNS:HAEA\.cap01/);
    assert.match(info, /TLS Web Client Authentication/, 'needs clientAuth EKU or the Portal will refuse it');
    assert.ok(!/BEGIN (EC |RSA )?PRIVATE KEY/.test(fs.readFileSync(csr, 'utf8')), 'CSR must not carry the key');

    // Re-running must not silently rotate the key: the Portal holds a
    // certificate signed against it, and a new key takes the node offline.
    let threw = false;
    try { execFileSync(process.execPath, [CSR, '--dir', dir], { env, stdio: 'pipe' }); }
    catch (e) { threw = true; assert.match(String(e.stderr), /already exists/); }
    assert.ok(threw, 'a second run overwrote the key');

    const before = fs.readFileSync(key, 'utf8');
    execFileSync(process.execPath, [CSR, '--dir', dir, '--force'], { env, stdio: 'pipe' });
    assert.notStrictEqual(fs.readFileSync(key, 'utf8'), before, '--force should re-enrol');

    // No stray config left behind — it holds the subject, and clutter in a
    // certs directory is how the wrong file gets shipped.
    assert.deepStrictEqual(
      fs.readdirSync(dir).filter(f => !/^cap01\.(key|csr)$/.test(f)), [],
      'left files behind in the certs directory',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
