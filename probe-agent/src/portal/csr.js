// csr.js — this node's device key and CSR (contract §6).
//
// Extracted from bin/cflex-csr.js because the collector now enrols ITSELF: on
// boot, if it has no key, it makes one and posts the CSR to the Local Console.
// An operator then copies the CSR out of the 포털 연동 page and pastes back the
// signed certificate. Nobody runs a CLI and nobody moves a file by hand.
//
// THE KEY NEVER LEAVES THE NODE. That is the whole point of generating here
// rather than anywhere more convenient, and it is why only the CSR and the
// public-key fingerprint are returned.
//
// Shells out to openssl rather than hand-rolling ASN.1: RHEL 8.10 always has
// it, it is auditable, and a bespoke DER writer for the key that guards a
// customer's telemetry is not a good trade.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const hasOpenssl = () => { try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } };

/** SHA-256 of the SPKI, the fingerprint the Portal records against the CSR. */
function pubkeySha256(csrPem) {
  const spki = execFileSync('openssl', ['req', '-pubkey', '-noout'], { input: csrPem, encoding: 'utf8' });
  return crypto.createHash('sha256')
    .update(crypto.createPublicKey(spki).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

const paths = (dir, nodeId) => ({
  key: path.join(dir, `${nodeId}.key`),
  csr: path.join(dir, `${nodeId}.csr`),
  cert: path.join(dir, `${nodeId}.pem`),
  ca: path.join(dir, 'ringon-ca.pem'),
});

/**
 * Make sure this node has a key and a CSR, creating them only if absent.
 *
 * Idempotent on purpose: this runs on every boot, and a key that already
 * exists must not be replaced. The Portal holds a certificate signed against
 * it, so rotating silently would take the node offline at the next poll —
 * `force` is the deliberate re-enrolment path and nothing calls it on a timer.
 *
 * @returns {{created: boolean, cn: string, csr: string, pubkey_sha256: string, paths: object}}
 */
function ensure({ dir, tenant, nodeId, force = false }) {
  if (!tenant || !nodeId) throw new Error('csr.ensure: tenant and nodeId are required');
  if (!hasOpenssl()) throw new Error('csr.ensure: openssl not found (RHEL: in the base system)');

  const cn = `${tenant}.${nodeId}`;
  const p = paths(dir, nodeId);

  if (fs.existsSync(p.key) && fs.existsSync(p.csr) && !force) {
    const csr = fs.readFileSync(p.csr, 'utf8');
    return { created: false, cn, csr, pubkey_sha256: pubkeySha256(csr), paths: p };
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // P-256: a smaller handshake than RSA-2048 at equivalent strength, supported
  // by every TLS 1.2+ stack in this path.
  if (!fs.existsSync(p.key) || force) {
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p.key], { stdio: 'pipe' });
    fs.chmodSync(p.key, 0o600);
    // A new key pair makes any certificate we hold dead. Leaving it on disk is
    // how a node ends up presenting a certificate that no longer matches.
    for (const f of [p.cert]) if (fs.existsSync(f)) fs.rmSync(f);
  }

  // SAN carries the node id as well as the CN: some servers match SAN and
  // ignore CN entirely, and supplying both costs nothing.
  const conf = path.join(dir, `.${nodeId}.csr.cnf`);
  fs.writeFileSync(conf, [
    '[req]', 'prompt = no', 'distinguished_name = dn', 'req_extensions = ext', '',
    '[dn]', 'C = US', 'O = RingOn Service Corp', 'OU = C-Flex FMS Probe', `CN = ${cn}`, '',
    '[ext]', `subjectAltName = DNS:${cn}, DNS:${nodeId}`,
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = clientAuth', '',
  ].join('\n'), { mode: 0o600 });
  try {
    execFileSync('openssl', ['req', '-new', '-key', p.key, '-out', p.csr, '-config', conf, '-sha256'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(conf, { force: true });
  }
  fs.chmodSync(p.csr, 0o644);

  const csr = fs.readFileSync(p.csr, 'utf8');
  return { created: true, cn, csr, pubkey_sha256: pubkeySha256(csr), paths: p };
}

/**
 * Install a signed certificate (and optional CA chain) next to the key.
 *
 * Refuses a certificate whose public key is not this node's: the collector
 * picks these up unattended, and installing someone else's would mean every
 * Portal call fails with nothing on disk explaining why.
 */
function install({ dir, tenant, nodeId, cert, ca }) {
  const p = paths(dir, nodeId);
  if (!fs.existsSync(p.key)) throw new Error(`install: no key at ${p.key} — enrol first`);

  const x = new crypto.X509Certificate(cert);
  const cn = (x.subject || '').split('\n').map(s => s.trim()).find(s => s.startsWith('CN='))?.slice(3);
  if (cn !== `${tenant}.${nodeId}`) {
    throw new Error(`install: certificate CN=${cn}, expected ${tenant}.${nodeId}`);
  }
  // The check that matters: does this certificate belong to OUR key?
  const ours = crypto.createPublicKey(fs.readFileSync(p.key)).export({ type: 'spki', format: 'der' });
  const theirs = x.publicKey.export({ type: 'spki', format: 'der' });
  if (!ours.equals(theirs)) {
    throw new Error('install: certificate public key does not match this node\'s key');
  }
  if (new Date(x.validTo) <= new Date()) throw new Error(`install: already expired (${x.validTo})`);

  fs.writeFileSync(p.cert, cert.endsWith('\n') ? cert : `${cert}\n`, { mode: 0o644 });
  if (ca) fs.writeFileSync(p.ca, ca.endsWith('\n') ? ca : `${ca}\n`, { mode: 0o644 });
  return { installed: true, cn, to: x.validTo, paths: p };
}

/** What this node currently holds, for a heartbeat or a status page. */
function state({ dir, nodeId }) {
  const p = paths(dir, nodeId);
  const has = (f) => fs.existsSync(f);
  if (!has(p.key)) return { state: 'none', paths: p };
  if (!has(p.cert)) return { state: 'pending', paths: p };
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(p.cert));
    const left = Math.round((new Date(x.validTo) - Date.now()) / 86_400_000);
    return { state: left > 0 ? 'signed' : 'expired', to: x.validTo, days_left: left, paths: p };
  } catch (e) { return { state: 'unreadable', error: e.message, paths: p }; }
}

module.exports = { ensure, install, state, pubkeySha256, paths, hasOpenssl };
