#!/usr/bin/env node
// cflex-portal-check — can this node talk to the Portal, and does the Portal
// behave like contract 00 says it does?
//
// The Portal half of `cflex-install verify` / `netcheck` (spec 01 §3.3). It
// exists because "연동이 안 된다" is not a diagnosis: at HAEA there will be a
// proxy, a corporate CA, an egress rule and a device certificate between the
// collector and the Portal, and when it fails someone on site needs to know
// WHICH of those, in one command, without a debugger.
//
// The checks themselves live in src/portal/check.js so the Local Console's
// 포털 연동 page gives the same verdict. Two implementations would drift, and
// then the screen and the CLI would disagree about whether the link is up.
//
// Read-only. Sends no telemetry, writes nothing, never prints key material.
//
//   node bin/cflex-portal-check.js
//   node bin/cflex-portal-check.js --json
'use strict';
const fs = require('node:fs');
const cfg = require('../src/config');
const { runChecks } = require('../src/portal/check');

const JSON_OUT = process.argv.includes('--json');
const readMaybe = (p) => { try { return p ? fs.readFileSync(p) : null; } catch { return null; } };

(async () => {
  const tenant = process.env.TENANT_ID || cfg.tenantId || 'HAEA';
  const nodeId = cfg.portal.nodeId;

  if (!JSON_OUT) {
    process.stdout.write(`\ncflex-portal-check  ${cfg.portal.url}  node=${nodeId} tenant=${tenant}\n\n`);
  }

  const report = await runChecks({
    url: cfg.portal.url,
    tenant,
    nodeId,
    tls: {
      cert: readMaybe(cfg.portal.tls.certPath),
      key: readMaybe(cfg.portal.tls.keyPath),
      ca: [readMaybe(cfg.portal.tls.caPath), readMaybe(cfg.portal.tls.proxyCaPath)],
    },
    // Contract §1 pins the destination IP; CFLEX_PORTAL_IP overrides it for a
    // mock or a site where DNS is not delegated yet.
    pinnedIp: process.env.CFLEX_PORTAL_IP ?? '40.114.79.164',
    proxy: cfg.portal.proxy,
  });

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      portal: cfg.portal.url, node: nodeId, tenant, ...report,
    }, null, 2) + '\n');
  } else {
    const MARK = { PASS: '  ok  ', WARN: ' warn ', FAIL: ' FAIL ', SKIP: ' skip ' };
    for (const c of report.checks) {
      process.stdout.write(`${MARK[c.verdict]} ${c.id}  ${c.title}\n`);
      for (const line of c.detail.split('\n')) if (line) process.stdout.write(`        ${line}\n`);
      if (c.ref) process.stdout.write(`        → ${c.ref}\n`);
    }
    const s = report.summary;
    process.stdout.write(`\n  ${s.pass} pass · ${s.warn} warn · ${s.fail} fail\n`);
    if (report.blockers.length) {
      process.stdout.write('\n  연동을 막는 것:\n');
      for (const b of report.blockers) {
        process.stdout.write(`    ${b.id}  ${b.title}${b.ref ? `  (${b.ref})` : ''}\n`);
      }
    }
    process.stdout.write('\n');
  }
  process.exit(report.summary.fail ? 1 : 0);
})().catch((e) => {
  process.stderr.write(`cflex-portal-check: ${e.stack}\n`);
  process.exit(3);
});
