// node --test test/sat.test.js
//
// cflex-sat is the Probe half of the joint acceptance test, and its output is
// what gets reported to the Portal team. A SAT harness that drifts into
// passing vacuously is worse than none, so this runs the real thing and checks
// the shape of the verdict rather than just the exit code.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { hasOpenssl } = require('./support/certs');

const BIN = path.join(__dirname, '..', 'bin', 'cflex-sat.js');

const run = () => new Promise((resolve) => {
  // Async: the mock Portal runs inside the child here, but execFileSync in a
  // parent that also serves would deadlock — the same trap portal-check hit.
  execFile(process.execPath, [BIN, '--json'], { encoding: 'utf8', timeout: 60_000 },
    (err, stdout) => resolve({ report: JSON.parse(stdout.slice(stdout.indexOf('{'))), code: err ? (err.code ?? 1) : 0 }));
});

test('the two-node SAT passes against a contract-conformant portal', { skip: !hasOpenssl() && 'openssl 없음' }, async () => {
  const { report, code } = await run();

  assert.strictEqual(report.failed.length, 0, `failed: ${report.failed.join(', ')}`);
  assert.strictEqual(code, 0);

  // Two nodes, separate certificates (guide §7.1).
  assert.deepStrictEqual(report.nodes.map(n => n.node_id), ['cap01', 'cap02']);

  // The four contract calls reached the server for BOTH nodes, which is the
  // thing the handoff actually asked to be demonstrated.
  for (const route of ['POST /api/v1/heartbeat', 'PUT /api/v1/inventory',
    'POST /api/v1/telemetry', 'POST /api/v1/events']) {
    assert.ok((report.server.stored[route] || 0) >= 2, `${route} stored ${report.server.stored[route] || 0}×, expected ≥2`);
  }

  // §5 report fields are the deliverable; an empty one is a silent failure.
  for (const n of report.nodes) {
    assert.ok(Object.keys(n.response_codes).length > 0, `${n.node_id}: no response codes`);
    assert.ok(n.last_response_at, `${n.node_id}: no last response time`);
    assert.strictEqual(n.queue_depth, 0, `${n.node_id}: queue not drained`);
  }

  // Nothing stored twice, and nothing reached the old path.
  assert.strictEqual(report.server.duplicate_stores, 0);
  assert.strictEqual(report.server.legacy_path_hits, 0, 'legacy /v1/probe/* must stay off');

  // Cross-identity refused, certificate rotation accepted.
  const by = (name) => report.findings.find(f => f.name.includes(name));
  assert.strictEqual(by('교차 요청 거부').ok, true);
  assert.strictEqual(by('인증서 교체 후 전송').ok, true);
  assert.strictEqual(by('복구 후 재전송').ok, true);
  assert.strictEqual(by('중복 저장 없음').ok, true);

  // And the one thing a local mock cannot decide is reported as inconclusive,
  // not quietly as a pass.
  assert.strictEqual(by('옛 인증서 차단').ok, null);
  assert.deepStrictEqual(report.inconclusive, ['cap01/옛 인증서 차단']);
});
