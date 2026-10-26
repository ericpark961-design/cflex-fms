#!/usr/bin/env node
// cflex-csr — generate this node's device key and CSR for the Portal's CA.
//
// Contract §6: the Probe generates the CSR and THE KEY NEVER LEAVES THE NODE.
// So this runs on the collector/app host, writes the key 0600, and prints only
// the CSR — the thing that is meant to travel. An installer or engineer hands
// the CSR to the Portal, which returns a signed certificate.
//
// CN is fixed by contract §1: `<tenant>.<node-id>`, e.g. `HAEA.cap01`. Getting
// that wrong means the Portal cannot tell which node is calling, so it is
// derived from config rather than typed.
//
// Shells out to openssl rather than hand-rolling ASN.1. RHEL 8.10 always has
// it (the TLS stack depends on it), it is auditable, and a bespoke DER writer
// for a key that guards a customer's telemetry is not a good trade. This is a
// CLI, not the daemon — the daemon still has zero dependencies.
//
//   node bin/cflex-csr.js                      # write key + CSR, print CSR
//   node bin/cflex-csr.js --dir /opt/app/cflex/certs
//   node bin/cflex-csr.js --show               # print the CSR subject/SAN only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const csrmod = require('../src/portal/csr');
const cfg = require('../src/config');

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const has = (n) => argv.includes(n);

const TENANT = process.env.TENANT_ID || cfg.tenantId || 'HAEA';
const NODE = cfg.portal.nodeId;
const CN = `${TENANT}.${NODE}`;
const DIR = path.resolve(String(flag('--dir', path.join(process.cwd(), 'certs'))));
const KEY = path.join(DIR, `${NODE}.key`);
const CSR = path.join(DIR, `${NODE}.csr`);

const die = (msg, code = 2) => { process.stderr.write(`cflex-csr: ${msg}\n`); process.exit(code); };

if (has('--help')) {
  process.stdout.write(`cflex-csr — device key + CSR for the Portal CA (contract §6)

  --dir <path>   where to write (default ./certs)
  --show         print the existing CSR's subject and exit
  --force        overwrite an existing key — DESTRUCTIVE, the old
                 certificate stops working the moment the Portal
                 signs a new one
  --help

CN is \${TENANT_ID}.\${CFLEX_NODE_ID} = ${CN}
`);
  process.exit(0);
}

if (!csrmod.hasOpenssl()) die('openssl not found — install it (RHEL: it is in the base system)');

if (has('--show')) {
  if (!fs.existsSync(CSR)) die(`no CSR at ${CSR} — run without --show first`);
  process.stdout.write(execFileSync('openssl', ['req', '-in', CSR, '-noout', '-subject', '-verify'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  process.exit(0);
}

// A key that already exists is not replaced by accident: the Portal has (or
// will have) a certificate signed against it, and regenerating silently would
// take the node offline at the next poll.
if (fs.existsSync(KEY) && !has('--force')) {
  die(`${KEY} already exists.\n`
    + `  The Portal has (or will have) a certificate signed against this key.\n`
    + `  Re-run with --force only if you intend to re-enrol this node.`, 3);
}

const r = csrmod.ensure({ dir: DIR, tenant: TENANT, nodeId: NODE, force: has('--force') });

process.stdout.write(`
  CN            ${r.cn}
  SAN           DNS:${r.cn}, DNS:${NODE}
  key           ${r.paths.key}  (0600 — keep on this node, never send it)
  CSR           ${r.paths.csr}
  pubkey sha256 ${r.pubkey_sha256.slice(0, 32)}…   ← compare with the Portal's record

Send the CSR, not the key:

  cat ${r.paths.csr}

The Portal signs it (contract §6-1) and returns ${NODE}.pem.

이 CLI 를 안 써도 됩니다 — collector 가 부팅할 때 키가 없으면 스스로 만들고
콘솔의 "포털 연동" 화면에 CSR 을 올립니다 (src/portal/enroll.js). 여기서는
운영자가 CSR 을 복사해 CA 에 주고, 서명된 인증서를 그 화면에 붙여넣으면 됩니다.
이 CLI 는 수동·현장 경로입니다.
`);
