#!/usr/bin/env node
// cflex-sat — the Probe side of the joint acceptance test (인계 가이드 §7).
//
// Runs TWO probes with SEPARATE device certificates through the contract
// sequence and then prints the report the handoff asks for: per-node response
// codes, last receive time, queue depth, whether anything was stored twice,
// and what errors are left.
//
// Default target is a local mock that enforces the contract the way the Portal
// must (mTLS required, CN = tenant.node, Idempotency-Key cache, schema
// validation). That is deliberate: the Portal's own ingress is closed with 503
// until its CA and mTLS edge are configured, so this proves the Probe half
// without waiting, and the same run points at the real Portal when it opens.
//
//   node bin/cflex-sat.js                 # local mock, two nodes
//   node bin/cflex-sat.js --json
//   node bin/cflex-sat.js --url https://cflex.fms.support \
//        --node cap01 --cert /etc/cflex/pki/cap01.pem --key /etc/cflex/pki/cap01.key
//
// Sends no e-mail and touches no device: no notifier is attached and the probe
// has no SNMP SET path. Synthetic identifiers only (TEST / TEST-SITE), per the
// guide's rule that synthetic data stays in the KMX/isolated test scope.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createForwarder } = require('../src/forwarder');
const transport = require('../src/portal/transport');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes(n);
const JSON_OUT = has('--json');

const TENANT = flag('--tenant', 'TEST');
const SITE = flag('--site', 'TEST-SITE');

if (has('--help')) {
  process.stdout.write(`cflex-sat — 양측 인수 시험 (인계 가이드 §7), Probe 쪽

  --url <u>     포털 URL. 생략하면 로컬 목을 띄운다
  --node <id>   실 포털 모드에서 쓸 노드 (기본 cap01)
  --cert/--key  그 노드의 장치 인증서·키
  --ca <path>   서버 TLS 검증용 CA (사설 서버 인증서일 때만)
  --tenant/--site
  --json
`);
  process.exit(0);
}

// ── an in-memory queue with the shape the forwarder expects ─────────
// Real runs use the SQLite buffer; here the queue must be inspectable so the
// report can state depth and whether a retry duplicated anything.
function memQueue() {
  let seq = 1;
  const rows = [];
  return {
    // payload is stored as a STRING, the way buffer.js does it — the
    // forwarder does JSON.parse(row.payload), so an object here throws.
    enqueue: (kind, payload) => { rows.push({ id: seq++, ts: Date.now(), kind, payload: JSON.stringify(payload), attempts: 0, last_error: null }); },
    dequeue: (n) => rows.filter(r => !r.done).slice(0, n),
    ack: (ids) => { for (const r of rows) if (ids.includes(r.id)) r.done = true; },
    fail: (id, err) => { const r = rows.find(x => x.id === id); if (r) { r.attempts++; r.last_error = String(err).slice(0, 200); } },
    // `pending` is the name the forwarder reads (heartbeat queue_depth).
    stats: () => { const d = rows.filter(r => !r.done).length; return { pending: d, depth: d, total: rows.length }; },
    _rows: rows,
  };
}

const findings = [];
// `ok === null` means inconclusive — something this harness cannot decide, as
// opposed to something that failed. Collapsing the two with `!!ok` reported a
// FAIL for a check the local mock is simply not able to make.
const step = (node, name, ok, detail) => {
  findings.push({ node, name, ok: ok === null ? null : !!ok, detail: String(detail ?? '') });
  if (!JSON_OUT) {
    const mark = ok === null ? ' ?? ' : ok ? ' ok ' : 'FAIL';
    process.stdout.write(`  ${mark}  ${String(node).padEnd(6)} ${name}\n`);
    for (const l of String(detail ?? '').split('\n')) if (l) process.stdout.write(`          ${l}\n`);
  }
};

/** One probe: its forwarder, its queue, and a record of what the server said. */
function makeNode({ nodeId, cert, key, ca, url, version = '0.1.0', paths = null }) {
  const queue = memQueue();
  const codes = [];
  let skew = 0;                       // advanced by the outage step
  const now = () => Date.now() + skew;
  const fwd = createForwarder({
    now,
    random: () => 0.5,                // no jitter: a report should be reproducible
    portal: {
      enabled: true, url, tenant: TENANT, nodeId, siteId: SITE, profile: 'bare',
      tls: { cert, key, ca }, proxy: '', noProxy: '',
    },
    queue,
    version,
    log: { log() {}, warn() {}, error() {} },   // quiet: the report is the output
    // No notifier and no alarm persistence: this must not send e-mail or a
    // ServiceNow ticket, and the handoff says so explicitly.
    notifier: null,
    request: async (opts) => {
      const r = await transport.request(opts);
      codes.push({ at: Date.now(), path: String(opts.path || opts.url || ''), status: r.status });
      return r;
    },
  });
  return { nodeId, fwd, queue, codes, paths, advance: (ms) => { skew += ms; } };
}

const UUID = () => crypto.randomUUID();
const ISO = (t = Date.now()) => new Date(t).toISOString();

// One synthetic device per node, in the shape the POLLERS produce — the SAT
// drives the forwarder exactly as src/index.js does rather than hand-building
// contract bodies, so what passes here is what production runs.
const deviceFor = (nodeId) => ({
  kind: 'ups',
  id: `sat-${nodeId}`,
  name: `SAT ${nodeId} UPS`,
  vendor: 'APC',
  model: 'SRT5KRMXLT',
  serial: `SAT-${nodeId.toUpperCase()}-0001`,
  site_id: SITE,
});

/** What adapt.deviceIdFor will derive for it — needed to read the server side. */
const deviceIdFor = (nodeId) => require('../src/contract/adapt')
  .inventoryDevice(deviceFor(nodeId), { tenant: TENANT, siteId: SITE }).device_id;

async function main() {
  let mock = null;
  let certs = null;
  let nodes;

  if (flag('--url')) {
    // Real Portal: one node, the certificate the operator registered.
    const url = flag('--url');
    const certPath = flag('--cert');
    const keyPath = flag('--key');
    if (!certPath || !keyPath) {
      process.stderr.write('cflex-sat: --url 에는 --cert 와 --key 가 필요하다 (장치 인증서 없이는 mTLS 가 성립하지 않는다)\n');
      process.exit(2);
    }
    nodes = [makeNode({
      nodeId: flag('--node', 'cap01'),
      cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath),
      ca: flag('--ca') ? [fs.readFileSync(flag('--ca'))] : [],
      url,
    })];
    if (!JSON_OUT) process.stdout.write(`\ncflex-sat  ${url}  tenant=${TENANT} site=${SITE}  (1 노드)\n\n`);
  } else {
    const { startMockPortal } = require('../test/support/mock-portal');
    const { makeCerts, hasOpenssl } = require('../test/support/certs');
    if (!hasOpenssl()) { process.stderr.write('cflex-sat: openssl 이 필요하다\n'); process.exit(2); }
    certs = makeCerts();
    mock = await startMockPortal({ server: certs.server, tenant: TENANT });
    const read = (c) => ({ cert: fs.readFileSync(c.certPath), key: fs.readFileSync(c.keyPath), ca: [fs.readFileSync(c.caPath)] });
    // §7.1 — two different nodes with SEPARATE certificates.
    nodes = ['cap01', 'cap02'].map((id) => {
      const c = certs.issueClient(`${TENANT}.${id}`);
      return makeNode({ nodeId: id, url: mock.url, paths: c, ...read(c) });
    });
    if (!JSON_OUT) process.stdout.write(`\ncflex-sat  ${mock.url} (로컬 목)  tenant=${TENANT} site=${SITE}  (2 노드)\n\n`);
  }

  try {
    // ── §7.2 heartbeat → inventory → telemetry → events, per node ──
    for (const n of nodes) {
      const hb = await n.fwd.heartbeat({ last_poll_ok_ratio: 1, devices_total: 1, devices_unreachable: 0 });
      step(n.nodeId, 'heartbeat', hb?.ok !== false && lastStatus(n) === 200,
        `HTTP ${lastStatus(n)} commands_pending=${hb?.commands_pending ?? 0}`);

      // syncInventory enqueues and flushes (contract §3.2). The guide insists
      // a 2xx is not enough — `rejected` has to be read.
      await n.fwd.syncInventory([deviceFor(n.nodeId)]);
      const inv = served(mock, 'PUT /api/v1/inventory', n.nodeId);
      step(n.nodeId, 'inventory', lastStatus(n) === 200 && (inv?.rejected?.length ?? 0) === 0,
        mock ? `accepted=${inv?.accepted ?? '-'} rejected=${inv?.rejected?.length ?? 0}` : `HTTP ${lastStatus(n)}`);

      // A poller reading succeeds → metrics → telemetry points → flush.
      await n.fwd.sendEvent('metrics', {
        device_id: deviceFor(n.nodeId).id, device_name: deviceFor(n.nodeId).name, kind: 'ups',
        ts: Date.now(),
        metrics: [
          { metric: 'load_pct', value: 37, source: 'measured' },
          { metric: 'bat_pct', value: 100, source: 'measured' },
        ],
      });
      n.fwd.flushTelemetry();
      await n.fwd.drain(50);
      step(n.nodeId, 'telemetry', lastStatus(n) === 200,
        `HTTP ${lastStatus(n)} points=${mock ? (countOf(mock, 'POST /api/v1/telemetry', n.nodeId)) : '-'}`);

      // A contract event (§3.4) comes out of the alarm engine, and the engine
      // is fed by kind 'alert' — kind 'metrics' only adds telemetry points.
      // Two earlier attempts got events=0 against a correct engine: a failed
      // poll is UPS_COMM_LOST, held 30 minutes by design, and an onBattery
      // reading sent as 'metrics' never reaches a rule at all.
      await n.fwd.sendEvent('alert', {
        device_id: deviceFor(n.nodeId).id, device_name: deviceFor(n.nodeId).name, kind: 'ups',
        ts: Date.now(), metric: 'output_source', value: 'onBattery', severity: 'P1',
      });
      await n.fwd.drain(50);
      await n.fwd.drain(50);
      const evCount = mock ? countOf(mock, 'POST /api/v1/events', n.nodeId) : null;
      step(n.nodeId, 'events', lastStatus(n) === 200 && (evCount === null || evCount > 0),
        `HTTP ${lastStatus(n)} events=${evCount ?? '-'} (알림기 미연결 — 이메일 발송 없음)`);
    }

    // ── §7.1 cross-identity must be refused ───────────────────────
    if (nodes.length === 2 && mock) {
      const [a, b] = nodes;
      const swapped = makeNode({
        nodeId: b.nodeId,                       // claims cap02 …
        url: mock.url,
        cert: fs.readFileSync(a.paths.certPath),   // … with cap01's certificate
        key: fs.readFileSync(a.paths.keyPath),
        ca: [fs.readFileSync(certs.caPath)],
      });
      await swapped.fwd.heartbeat({ last_poll_ok_ratio: 1 });
      step('cross', 'Tenant/Node 교차 요청 거부', lastStatus(swapped) === 401,
        `HTTP ${lastStatus(swapped)} — 인증서 CN 과 X-CFlex-Node 가 다르면 거부돼야 한다`);
    }

    // ── §7.3 단절 → 재전송 → 중복 없음 ────────────────────────────
    if (mock) {
      const n = nodes[0];
      const before = mock.state.received.length;
      // Exactly one fault. The first 503 arms the 1s→5min backoff, so any
      // further injected faults are never collected here and surface later in
      // an unrelated step — which is how the rotation check briefly "failed"
      // with an HTTP 500 that had nothing to do with certificates.
      mock.state.faults.push({ status: 503, headers: { 'Retry-After': '1' } });
      const attempts = [];
      for (let i = 0; i < 2; i++) {
        await n.fwd.sendEvent('metrics', {
          device_id: deviceFor(n.nodeId).id, kind: 'ups', ts: Date.now(),
          metrics: [{ metric: 'load_pct', value: 40 + i, source: 'measured' }],
        });
        n.fwd.flushTelemetry();
        await n.fwd.drain(50);
        attempts.push(lastStatus(n));
      }
      const depthDuring = n.queue.stats().pending;
      // Past the 1s→5min backoff the outage armed. Without this the forwarder
      // correctly declines to retry and the step reads as a failure.
      n.advance(6 * 60_000);
      const drained = await n.fwd.drain(50);
      const after = mock.state.received.length;
      // Nothing injected may outlive this step.
      mock.state.faults.length = 0;
      step(n.nodeId, '복구 후 재전송', n.queue.stats().pending === 0 && after > before,
        `큐 ${depthDuring} → ${n.queue.stats().pending}, 서버 수신 ${before} → ${after}, drained=${drained?.drained ?? '-'}`);

      // §7.3 — the same Idempotency-Key must not be stored twice. The
      // forwarder fixes the key when the row is enqueued, so a retry carries
      // the same one; the server answers from cache.
      const keys = mock.state.requests.map(r => r.headers['idempotency-key']).filter(Boolean);
      const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
      const storedKeys = mock.state.received.map(r => r.headers['idempotency-key']);
      const storedTwice = storedKeys.filter((k, i) => storedKeys.indexOf(k) !== i);
      step(n.nodeId, '중복 저장 없음', storedTwice.length === 0,
        `재시도로 같은 키가 ${dupKeys.length}회 재전송됐고, 저장은 ${storedTwice.length}회 중복`);
    }

    // ── §7.4 인증서 교체: 새 인증서는 통하고 옛것은 거부 ──────────
    if (mock) {
      const old = nodes[0].paths;
      const fresh = certs.issueClient(`${TENANT}.${nodes[0].nodeId}`);
      const rotated = makeNode({
        nodeId: nodes[0].nodeId, url: mock.url,
        cert: fs.readFileSync(fresh.certPath), key: fs.readFileSync(fresh.keyPath),
        ca: [fs.readFileSync(certs.caPath)],
      });
      await rotated.fwd.heartbeat({ last_poll_ok_ratio: 1 });
      step(nodes[0].nodeId, '인증서 교체 후 전송', lastStatus(rotated) === 200,
        `같은 CA 가 서명한 새 인증서로 HTTP ${lastStatus(rotated)}`);
      // The local mock trusts any certificate from its CA, so it cannot prove
      // the OLD one is blocked — that is the Portal's registration check
      // (SHA-256 of the registered certificate). Said rather than implied.
      step(nodes[0].nodeId, '옛 인증서 차단', null,
        `목은 CA 서명만 보므로 확인 불가. 포털이 등록 인증서 SHA-256 으로 차단한다 (가이드 §2-6). 옛 인증서 지문 ${sha256Of(old.certPath).slice(0, 16)}…`);
    }

    // ── §5 report ─────────────────────────────────────────────────
    const report = {
      portal: mock ? `${mock.url} (local mock)` : flag('--url'),
      tenant: TENANT, site: SITE,
      nodes: nodes.map(n => ({
        node_id: n.nodeId,
        response_codes: tally(n.codes.map(c => c.status)),
        last_response_at: n.codes.length ? ISO(n.codes[n.codes.length - 1].at) : null,
        queue_depth: n.queue.stats().pending,
        queue_total: n.queue.stats().total,
        stats: n.fwd.stats(),
        last_reachable: n.fwd.lastReachable() ? ISO(n.fwd.lastReachable()) : null,
      })),
      server: mock ? {
        stored: tally(mock.state.received.map(r => r.route)),
        requests: mock.state.requests.length,
        duplicate_stores: (() => {
          const k = mock.state.received.map(r => r.headers['idempotency-key']);
          return k.filter((x, i) => k.indexOf(x) !== i).length;
        })(),
        legacy_path_hits: mock.state.legacy.length,
      } : null,
      findings,
      failed: findings.filter(f => f.ok === false).map(f => `${f.node}/${f.name}`),
      inconclusive: findings.filter(f => f.ok === null).map(f => `${f.node}/${f.name}`),
    };

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write('\n  ── 노드별 보고 (가이드 §5) ──\n');
      for (const n of report.nodes) {
        process.stdout.write(`\n  ${n.node_id}\n`);
        process.stdout.write(`    응답 코드      ${Object.entries(n.response_codes).map(([k, v]) => `${k}×${v}`).join(' ')}\n`);
        process.stdout.write(`    마지막 응답    ${n.last_response_at || '—'}\n`);
        process.stdout.write(`    큐 잔량        ${n.queue_depth} (누적 ${n.queue_total})\n`);
        process.stdout.write(`    전송/거부/재시도 ${n.stats.sent} / ${n.stats.rejected} / ${n.stats.retried}\n`);
        process.stdout.write(`    남은 오류      ${n.stats.last_error || '없음'}\n`);
      }
      if (report.server) {
        process.stdout.write('\n  서버 측\n');
        process.stdout.write(`    저장          ${Object.entries(report.server.stored).map(([k, v]) => `${k} ×${v}`).join('  ')}\n`);
        process.stdout.write(`    요청 총계     ${report.server.requests}\n`);
        process.stdout.write(`    중복 저장     ${report.server.duplicate_stores}\n`);
        process.stdout.write(`    구 경로 유입  ${report.server.legacy_path_hits}\n`);
      }
      process.stdout.write(`\n  실패 ${report.failed.length}건${report.failed.length ? ': ' + report.failed.join(', ') : ''}`);
      process.stdout.write(`\n  확인 불가 ${report.inconclusive.length}건${report.inconclusive.length ? ': ' + report.inconclusive.join(', ') : ''}\n\n`);
    }
    process.exitCode = report.failed.length ? 1 : 0;
  } finally {
    if (mock) await mock.close();
    if (certs) certs.cleanup();
  }

  function sha256Of(p) {
    const pem = fs.readFileSync(p, 'utf8');
    return crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
  }
}

/** The last HTTP status this node saw — the forwarder reports queue state, not codes. */
const lastStatus = (n) => (n.codes.length ? n.codes[n.codes.length - 1].status : null);
/** The server's reply body for a route from a node, when running against the mock. */
const served = (mock, route, nodeId) => (!mock ? null : (() => {
  const hit = [...mock.state.received].reverse().find(r => r.route === route && r.headers['x-cflex-node'] === nodeId);
  return hit ? mock.state.idem.get(hit.headers['idempotency-key'])?.body : null;
})());
const countOf = (mock, route, nodeId) =>
  mock.state.received.filter(r => r.route === route && r.headers['x-cflex-node'] === nodeId).length;

const tally = (xs) => xs.reduce((a, x) => { a[x] = (a[x] || 0) + 1; return a; }, {});

main().catch((e) => { process.stderr.write(`cflex-sat: ${e.stack}\n`); process.exit(3); });
