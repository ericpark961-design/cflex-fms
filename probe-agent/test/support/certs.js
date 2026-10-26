// A throwaway CA, a Portal server cert and node client certs, for the E2E
// tests. Since D-13 the node that holds a Portal client certificate is an app
// node (app01; more with `clients`). Made with the openssl CLI (present on RHEL and macOS) in a temp dir
// that is deleted afterwards — nothing here is a real credential.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeCerts({ clients = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflex-certs-'));
  const p = (f) => path.join(dir, f);
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const ext = (name, body) => { fs.writeFileSync(p(name), body); return p(name); };

  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=cflex-test-ca',
    '-keyout', p('ca.key'), '-out', p('ca.pem'));

  const leaf = (name, cn, extFile) => {
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`, '-keyout', p(`${name}.key`), '-out', p(`${name}.csr`));
    ssl('x509', '-req', '-in', p(`${name}.csr`), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
      '-days', '1', '-out', p(`${name}.pem`), '-extfile', extFile);
  };
  leaf('server', 'localhost', ext('server.ext', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'));
  const clientExt = ext('client.ext', 'extendedKeyUsage=clientAuth\n');
  leaf('client', 'TEST.app01', clientExt);
  const more = {};
  for (const n of clients) {
    leaf(`client-${n}`, `TEST.${n}`, clientExt);
    more[n] = { certPath: p(`client-${n}.pem`), keyPath: p(`client-${n}.key`), caPath: p('ca.pem') };
  }
  // A second CA's client: valid cert, wrong issuer — must be refused.
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=TEST.rogue',
    '-keyout', p('rogue.key'), '-out', p('rogue.pem'));

  return {
    dir,
    caPath: p('ca.pem'),
    server: { cert: fs.readFileSync(p('server.pem')), key: fs.readFileSync(p('server.key')), ca: fs.readFileSync(p('ca.pem')) },
    client: { certPath: p('client.pem'), keyPath: p('client.key'), caPath: p('ca.pem') },
    clients: more,
    rogue: { certPath: p('rogue.pem'), keyPath: p('rogue.key'), caPath: p('ca.pem') },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { makeCerts, hasOpenssl };
