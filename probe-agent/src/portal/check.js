// check.js — "can this node talk to the Portal, and does the Portal behave
// like contract 00 says it does?", as a function.
//
// Extracted from bin/cflex-portal-check.js because the Local Console needs the
// same answer on its 포털 연동 page. Two implementations of this would drift,
// and then the CLI and the screen would disagree about whether the link is up
// — which is worse than having neither.
//
// Takes everything as arguments: no process.env, no process.exit, no printing.
// The CLI owns argument parsing and output; the console owns rendering.
'use strict';
const tls = require('node:tls');
const net = require('node:net');
const dns = require('node:dns').promises;
const { URL } = require('node:url');
const crypto = require('node:crypto');

/** Contract §3 — the seven endpoints a Probe calls. */
const ENDPOINTS = (nodeId) => [
  ['POST', '/api/v1/heartbeat'],
  ['PUT', '/api/v1/inventory'],
  ['POST', '/api/v1/telemetry'],
  ['POST', '/api/v1/events'],
  ['POST', '/api/v1/files'],
  ['GET', `/api/v1/commands?node_id=${encodeURIComponent(nodeId)}`],
  ['GET', `/api/v1/config?node_id=${encodeURIComponent(nodeId)}&since=0`],
];

/**
 * Parse a PEM certificate without shelling out — the console runs inside a
 * container that may not carry the openssl binary, and node's X509Certificate
 * gives us everything the checks need.
 */
function certInfo(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    const cn = (x.subject || '').split('\n').map(l => l.trim())
      .find(l => l.startsWith('CN='))?.slice(3) || null;
    return {
      cn,
      subject: x.subject,
      issuer: x.issuer,
      from: x.validFrom,
      to: x.validTo,
      serial: x.serialNumber,
      // keyUsage holds the EKU OIDs; clientAuth is 1.3.6.1.5.5.7.3.2.
      clientAuth: (x.keyUsage || []).includes('1.3.6.1.5.5.7.3.2'),
      pubkeySha256: crypto.createHash('sha256')
        .update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    };
  } catch (e) { return { error: e.message }; }
}

/**
 * @param {object} o
 * @param {string} o.url            portal base URL
 * @param {string} o.tenant
 * @param {string} o.nodeId
 * @param {{cert?: Buffer|string, key?: Buffer|string, ca?: Array<Buffer|string>}} [o.tls]
 * @param {string} [o.pinnedIp]     contract §1 pins 40.114.79.164; '' disables the check
 * @param {string} [o.proxy]        reported, not used — the forwarder owns proxy transport
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{summary: object, checks: Array}>}
 */
async function runChecks({
  url, tenant, nodeId, tls: material = {}, pinnedIp = '40.114.79.164',
  proxy = '', timeoutMs = 10_000,
} = {}) {
  const checks = [];
  const add = (id, verdict, title, detail, ref = null) =>
    checks.push({ id, verdict, title, detail: String(detail ?? ''), ref });

  let U;
  try { U = new URL(url); } catch {
    add('URL', 'FAIL', '포털 URL 이 올바르지 않다', String(url), '계약 §1');
    return done(checks);
  }
  const HOST = U.hostname;
  const PORT = Number(U.port || 443);
  const expectCn = `${tenant}.${nodeId}`;

  // ── 1. DNS ──────────────────────────────────────────────────────
  let addrs;
  if (net.isIP(HOST)) {
    addrs = [HOST];
    add('DNS', 'SKIP', `${HOST} 는 IP 리터럴`, '이름 해석 건너뜀');
  } else {
    try {
      addrs = (await dns.resolve4(HOST)).sort();
      const ok = !pinnedIp || addrs.includes(pinnedIp);
      add('DNS', ok ? 'PASS' : 'WARN', `${HOST} 해석`,
        `${addrs.join(', ')}${ok ? '' : `\n계약서가 지정한 ${pinnedIp} 가 없다 — split-horizon DNS 또는 리다이렉션`}`,
        ok ? null : '계약 §1 (공인 IP 40.114.79.164, static)');
    } catch (e) {
      add('DNS', 'FAIL', `${HOST} 해석 실패`, e.message, '방화벽 요청서: DNS 아웃바운드');
      return done(checks);
    }
  }

  if (proxy) {
    add('PROXY', 'WARN', 'HTTPS_PROXY 설정됨',
      `${String(proxy).replace(/\/\/[^@]*@/, '//***@')}\n이 점검은 프록시를 경유하지 않는다 — 프록시 경유는 forwarder 의 E2E 테스트가 검증한다`,
      '계약 §1 (프록시)');
  }

  // ── 2. TCP ──────────────────────────────────────────────────────
  const tcp = await new Promise((res) => {
    const s = net.connect({ host: addrs[0], port: PORT, timeout: Math.min(8000, timeoutMs) });
    s.once('connect', () => { s.destroy(); res({ ok: true }); });
    s.once('timeout', () => { s.destroy(); res({ ok: false, why: 'timeout' }); });
    s.once('error', (e) => res({ ok: false, why: e.message }));
  });
  if (!tcp.ok) {
    add('TCP', 'FAIL', `${addrs[0]}:${PORT} 연결 실패`, tcp.why,
      '방화벽 요청서: collector/app → cflex.fms.support TCP 443 out');
    return done(checks);
  }
  add('TCP', 'PASS', `${addrs[0]}:${PORT} 연결`, 'open');

  const ca = (material.ca || []).filter(Boolean);
  const caOpt = ca.length ? [...tls.rootCertificates, ...ca] : undefined;

  // ── 3. TLS ──────────────────────────────────────────────────────
  const hs = await connect({ host: HOST, port: PORT, cert: material.cert, key: material.key, ca: caOpt, timeoutMs });
  if (!hs.ok) {
    add('TLS', 'FAIL', 'TLS 핸드셰이크 실패', hs.why, '계약 §1 (TLS 1.2+)');
    return done(checks);
  }
  const serverDays = Math.round((new Date(hs.peer.to) - Date.now()) / 86_400_000);
  add('TLS', hs.authorized ? 'PASS' : 'FAIL', `TLS ${hs.proto}`,
    `서버 CN=${hs.peer.cn}  발급 ${hs.peer.issuer}  만료 ${hs.peer.to} (${serverDays}일)\n암호 ${hs.cipher}`
    + (hs.authorized ? '' : `\n검증 실패: ${hs.err}`),
    hs.authorized ? null : '계약 §1');
  if (serverDays < 21) {
    add('TLS-EXP', 'WARN', '서버 인증서 만료 임박', `${serverDays}일 남음`, null);
  }

  // ── 4. does the Portal require a device certificate? ────────────
  // Asked in reverse: try WITHOUT a certificate. If that gets an answer, mTLS
  // is not enforced and contract §1's authentication does not exist yet — a
  // finding, not a pass.
  //
  // It has to be a REQUEST, not just a handshake. Under TLS 1.3 the server's
  // certificate request is not a handshake-time failure: `secureConnect` fires
  // for an anonymous client and the rejection lands on the first write. An
  // earlier version tested the handshake and "passed" against a mock only
  // because it withheld the CA and the SERVER cert failed to verify — the
  // right answer for the wrong reason, which is how a diagnostic starts lying.
  const anon = await probe('POST', '/api/v1/heartbeat', { anonymous: true });
  if (anon.status > 0) {
    add('MTLS', 'FAIL', '포털이 장치 인증서를 요구하지 않는다',
      `클라이언트 인증서 없이 ${anon.status} 응답을 받았다.\n`
      + 'mTLS 미구성 — 누구나 이 엔드포인트에 붙을 수 있다.',
      '계약 §1 (인증: mTLS 장치 인증서) · 포털 WO-PTL-002');
  } else {
    add('MTLS', 'PASS', '포털이 장치 인증서를 요구한다',
      `인증서 없는 요청 거부: ${anon.note}`);
  }

  // ── 5. our own device certificate ───────────────────────────────
  if (!material.cert || !material.key) {
    add('CERT', 'FAIL', '이 노드의 장치 인증서가 없다',
      `발급 절차: cflex-csr 로 CSR 생성 → 포털에 등록 → ${nodeId}.pem 수령`,
      '계약 §6-1');
  } else {
    const info = certInfo(material.cert);
    if (info.error) {
      add('CERT', 'FAIL', '장치 인증서를 읽을 수 없다', info.error, '계약 §6-1');
    } else {
      const cnOk = info.cn === expectCn;
      const left = Math.round((new Date(info.to) - Date.now()) / 86_400_000);
      add('CERT', cnOk && info.clientAuth && left > 0 ? 'PASS' : 'FAIL', '장치 인증서',
        `CN=${info.cn || '?'}${cnOk ? '' : `  ← ${expectCn} 이어야 한다`}\n`
        + `만료 ${info.to} (${left}일)\nclientAuth ${info.clientAuth ? 'O' : 'X'}`,
        cnOk ? null : '계약 §1 (CN=<tenant>.<node-id>)');
      if (left > 0 && left < 60) {
        add('CERT-EXP', 'WARN', '장치 인증서 만료 60일 이내',
          `${left}일 — 포털이 cert_renew 명령을 발행해야 한다`, '계약 §1, §6-2');
      }
    }
  }

  // ── 6. the contract endpoints ───────────────────────────────────
  const seen = [];
  for (const [method, p] of ENDPOINTS(nodeId)) {
    seen.push({ method, path: p, ...await probe(method, p) });
  }
  const REDIRECT = [301, 302, 303, 307, 308];
  const redirected = seen.filter(s => REDIRECT.includes(s.status));
  if (redirected.length === seen.length) {
    add('API', 'FAIL', '계약 엔드포인트가 없다',
      `§3 의 7개 경로 전부 ${redirected[0].status} → ${redirected[0].location}\n`
      + '세션 로그인 게이트가 앞에 있고 /api/v1 은 구현되지 않았다.',
      '계약 §3 · 포털 WO-PTL-001');
  } else {
    const answered = seen.filter(s => s.status > 0 && !REDIRECT.includes(s.status));
    const lines = seen.map(s => `${String(s.status).padEnd(4)} ${s.method} ${s.path.split('?')[0]}${s.note ? `  ${s.note}` : ''}`);
    // A 503 carrying the contract's own error envelope is not a broken
    // endpoint — it is an implemented one that is deliberately gated. The
    // Portal says so ("mtls_ingress_not_activated"), and calling that
    // "0/7 응답" would send someone to debug a route that already works.
    const gated = seen.filter(s => s.status === 503 && /"code"\s*:\s*"[a-z_]+"/.test(s.note));
    const broken = seen.filter(s => s.status === 0 || (s.status >= 500 && !gated.includes(s)));
    if (gated.length === seen.length) {
      const code = (gated[0].note.match(/"code"\s*:\s*"([a-z_]+)"/) || [])[1] || '?';
      add('API', 'WARN', `계약 엔드포인트 ${seen.length}/${seen.length} 구현, 전부 503 게이트`,
        `${lines.join('\n')}\n\n코드 ${code} — 경로는 있고 포털이 의도적으로 막아둔 상태다.\n`
        + '503 이므로 Probe 는 백오프로 재시도하고 큐를 버리지 않는다.',
        '계약 §3 — 게이트 해제는 MTLS 선행');
    } else {
      add('API', broken.length ? 'WARN' : 'PASS',
        `계약 엔드포인트 ${answered.length}/${seen.length} 응답`,
        lines.join('\n'), broken.length ? '계약 §3' : null);
    }
  }
  const version = seen.map(s => s.version).find(Boolean);
  add('VERSION', version ? 'PASS' : 'WARN', '응답 헤더 X-CFlex-API-Version',
    version || '없음 — 계약 §1 은 버전을 응답에 싣게 되어 있다',
    version ? null : '계약 §1 (버전)');

  // ── 7. mock namespace ──────────────────────────────────────────
  const mock = await probe('POST', '/api/v1/_mock/heartbeat');
  const mockUp = mock.status > 0 && mock.status < 400 && !REDIRECT.includes(mock.status);
  add('MOCK', mockUp ? 'PASS' : 'WARN', '목 서버 /api/v1/_mock',
    `${mock.status}${mock.location ? ` → ${mock.location}` : ''}`
    + (mockUp ? '' : '\n없음 — Probe 의 SAT 와 계약 테스트가 자체 목에 의존하게 된다'),
    mockUp ? null : '계약 §7 · 포털 WO-PTL-001');

  // ── 8. clock drift ─────────────────────────────────────────────
  const dateHeader = seen.map(s => s.date).find(Boolean) || mock.date;
  if (dateHeader) {
    const drift = Math.round((Date.now() - new Date(dateHeader)) / 1000);
    add('CLOCK', Math.abs(drift) > 60 ? 'WARN' : 'PASS', '시계 차이',
      `${drift >= 0 ? '+' : ''}${drift}s (로컬 − 포털 Date 헤더)`
      + (Math.abs(drift) > 60 ? '\n60초 초과 — Probe 가 CLOCK_DRIFT 경고 이벤트를 낸다' : ''),
      Math.abs(drift) > 60 ? '계약 §1 (시간)' : null);
  } else {
    add('CLOCK', 'SKIP', '시계 차이', 'Date 응답 헤더를 받지 못했다');
  }

  return done(checks);

  function probe(method, path, { anonymous = false } = {}) {
    return new Promise((res) => {
      const https = require('node:https');
      const req = https.request({
        host: HOST, port: PORT, path, method, servername: net.isIP(HOST) ? undefined : HOST,
        cert: anonymous ? undefined : (material.cert || undefined),
        key: anonymous ? undefined : (material.key || undefined),
        ca: caOpt,
        headers: {
          'X-CFlex-Tenant': tenant,
          'X-CFlex-Node': nodeId,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'User-Agent': 'cflex-portal-check',
        },
        timeout: timeoutMs,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
          res({
            status: r.statusCode, location: r.headers.location,
            version: r.headers['x-cflex-api-version'], date: r.headers.date,
            note: body && r.statusCode >= 400 ? body.slice(0, 80) : '',
          });
        });
      });
      req.once('timeout', () => { req.destroy(); res({ status: 0, note: 'timeout' }); });
      req.once('error', (e) => res({ status: 0, note: `${e.code || ''} ${e.message}`.trim() }));
      // An empty body: this is a reachability probe, not a submission, and the
      // Portal should reject it on schema grounds rather than store it.
      req.end(method === 'GET' ? undefined : '{}');
    });
  }
}

function connect({ host, port, cert, key, ca, timeoutMs }) {
  return new Promise((res) => {
    const s = tls.connect({
      host, port, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2',
      cert: cert || undefined, key: key || undefined, ca, timeout: timeoutMs,
    });
    s.once('secureConnect', () => {
      const peer = s.getPeerCertificate(false);
      res({
        ok: true, authorized: s.authorized, err: s.authorizationError,
        proto: s.getProtocol(), cipher: s.getCipher()?.name,
        peer: {
          cn: peer?.subject?.CN, issuer: peer?.issuer?.O || peer?.issuer?.CN,
          from: peer?.valid_from, to: peer?.valid_to,
        },
      });
      s.destroy();
    });
    s.once('timeout', () => { s.destroy(); res({ ok: false, why: 'handshake timeout' }); });
    s.once('error', (e) => res({ ok: false, why: `${e.code || ''} ${e.message}`.trim() }));
  });
}

function done(checks) {
  const n = (v) => checks.filter(c => c.verdict === v).length;
  const blockers = checks.filter(c => c.verdict === 'FAIL');
  return {
    summary: { pass: n('PASS'), warn: n('WARN'), fail: n('FAIL'), skip: n('SKIP') },
    linked: blockers.length === 0,
    blockers: blockers.map(b => ({ id: b.id, title: b.title, ref: b.ref })),
    checks,
  };
}

module.exports = { runChecks, certInfo, ENDPOINTS };
