#!/usr/bin/env node
// cflex-portal-check — can this node talk to the Portal, and does the Portal
// behave like contract 00 says it does?
//
// This is the Portal half of `cflex-install verify` / `netcheck` (spec 01
// §3.3), and it exists because "연동이 안 된다" is not a diagnosis. At HAEA
// there will be a proxy, a corporate CA, an egress rule and a device
// certificate between the collector and the Portal, and when it fails someone
// on site needs to know WHICH of those, in one command, without a debugger.
//
// Checks in dependency order and stops describing downstream state once a
// prerequisite fails — a 403 means nothing if TLS never completed.
//
// Read-only. Sends no telemetry, writes nothing, and never prints key material.
//
//   node bin/cflex-portal-check.js
//   node bin/cflex-portal-check.js --json
//   CFLEX_TLS_CERT=… CFLEX_TLS_KEY=… node bin/cflex-portal-check.js
'use strict';
const tls = require('node:tls');
const net = require('node:net');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const { URL } = require('node:url');
const { execFileSync } = require('node:child_process');
const cfg = require('../src/config');

const JSON_OUT = process.argv.includes('--json');
const U = new URL(cfg.portal.url);
const HOST = U.hostname;
const PORT = Number(U.port || 443);
const TENANT = process.env.TENANT_ID || cfg.tenantId || 'HAEA';
const NODE = cfg.portal.nodeId;
const EXPECT_CN = `${TENANT}.${NODE}`;

// Contract §1 pins the destination IP. A collector that resolves it elsewhere
// is either behind a split-horizon DNS or being redirected, and both matter.
const PINNED_IP = process.env.CFLEX_PORTAL_IP || '40.114.79.164';

const results = [];
const add = (id, verdict, title, detail, ref) => {
  results.push({ id, verdict, title, detail, ref });
  if (!JSON_OUT) {
    const mark = { PASS: '  ok  ', WARN: ' warn ', FAIL: ' FAIL ', SKIP: ' skip ' }[verdict];
    process.stdout.write(`${mark} ${id}  ${title}\n`);
    for (const line of String(detail).split('\n')) if (line) process.stdout.write(`        ${line}\n`);
    if (ref) process.stdout.write(`        → ${ref}\n`);
  }
};

const readMaybe = (p) => { try { return p ? fs.readFileSync(p) : null; } catch { return null; } };

async function main() {
  if (!JSON_OUT) {
    process.stdout.write(`\ncflex-portal-check  ${cfg.portal.url}  node=${NODE} tenant=${TENANT}\n\n`);
  }

  // ── 1. DNS ────────────────────────────────────────────────────────
  let addrs = [];
  // A literal IP is a legitimate target — a mock, or a site where DNS is not
  // delegated yet. Resolving it would just fail and mask the real checks.
  if (net.isIP(HOST)) {
    addrs = [HOST];
    add('DNS', 'SKIP', `${HOST} 는 IP 리터럴`, '이름 해석 건너뜀');
  } else {
  try {
    addrs = (await dns.resolve4(HOST)).sort();
    const pinned = addrs.includes(PINNED_IP) || !!process.env.CFLEX_PORTAL_IP;
    add('DNS', pinned ? 'PASS' : 'WARN', `${HOST} 해석`,
      `${addrs.join(', ')}${pinned ? '' : `\n계약서가 지정한 ${PINNED_IP} 가 없다 — split-horizon DNS 또는 리다이렉션`}`,
      pinned ? null : '계약 §1 (공인 IP 40.114.79.164, static)');
  } catch (e) {
    add('DNS', 'FAIL', `${HOST} 해석 실패`, e.message, '방화벽 요청서: DNS 아웃바운드');
    return finish();
  }
  }

  // ── 2. TCP ────────────────────────────────────────────────────────
  const proxy = cfg.portal.proxy;
  if (proxy) {
    add('PROXY', 'WARN', 'HTTPS_PROXY 설정됨',
      `${proxy.replace(/\/\/[^@]*@/, '//***@')}\n이 점검은 프록시를 경유하지 않는다 — 프록시 경유는 forwarder 의 E2E 테스트가 검증한다`,
      '계약 §1 (프록시)');
  }
  const tcp = await new Promise((res) => {
    const s = net.connect({ host: addrs[0], port: PORT, timeout: 8000 });
    s.once('connect', () => { s.destroy(); res({ ok: true }); });
    s.once('timeout', () => { s.destroy(); res({ ok: false, why: 'timeout 8s' }); });
    s.once('error', (e) => res({ ok: false, why: e.message }));
  });
  if (!tcp.ok) {
    add('TCP', 'FAIL', `${addrs[0]}:${PORT} 연결 실패`, tcp.why,
      '방화벽 요청서: collector/app → cflex.fms.support TCP 443 out');
    return finish();
  }
  add('TCP', 'PASS', `${addrs[0]}:${PORT} 연결`, 'open');

  // ── 3. TLS, and the question that matters: is mTLS even on? ───────
  const ourCert = readMaybe(cfg.portal.tls.certPath);
  const ourKey = readMaybe(cfg.portal.tls.keyPath);
  const extraCa = [readMaybe(cfg.portal.tls.caPath), readMaybe(cfg.portal.tls.proxyCaPath)].filter(Boolean);

  const hs = await new Promise((res) => {
    const sock = tls.connect({
      host: HOST, port: PORT, servername: HOST, minVersion: 'TLSv1.2',
      cert: ourCert || undefined, key: ourKey || undefined,
      ca: extraCa.length ? [...tls.rootCertificates, ...extraCa] : undefined,
      timeout: 10_000,
    });
    // `OCSPRequest`/`session` fire too early; the client-cert request shows up
    // as the server asking during the handshake, which node surfaces only via
    // the raw socket's `_handle`. The portable signal is whether a handshake
    // WITHOUT a cert succeeds — see MTLS below.
    sock.once('secureConnect', () => {
      const peer = sock.getPeerCertificate(false);
      res({
        ok: true, authorized: sock.authorized, err: sock.authorizationError,
        proto: sock.getProtocol(), cipher: sock.getCipher()?.name,
        peer: {
          subject: peer?.subject?.CN, issuer: peer?.issuer?.O || peer?.issuer?.CN,
          from: peer?.valid_from, to: peer?.valid_to,
          san: peer?.subjectaltname,
        },
      });
      sock.destroy();
    });
    sock.once('timeout', () => { sock.destroy(); res({ ok: false, why: 'TLS handshake timeout' }); });
    sock.once('error', (e) => res({ ok: false, why: `${e.code || ''} ${e.message}`.trim() }));
  });

  if (!hs.ok) {
    add('TLS', 'FAIL', 'TLS 핸드셰이크 실패', hs.why, '계약 §1 (TLS 1.2+)');
    return finish();
  }
  const daysLeft = Math.round((new Date(hs.peer.to) - Date.now()) / 86_400_000);
  add('TLS', hs.authorized ? 'PASS' : 'FAIL', `TLS ${hs.proto}`,
    `서버 CN=${hs.peer.subject}  발급 ${hs.peer.issuer}  만료 ${hs.peer.to} (${daysLeft}일)`
    + `\n암호 ${hs.cipher}`
    + (hs.authorized ? '' : `\n검증 실패: ${hs.err}`),
    hs.authorized ? null : '계약 §1');
  if (daysLeft < 21) {
    add('TLS-EXP', 'WARN', '서버 인증서 만료 임박', `${daysLeft}일 남음 — 갱신 확인`, null);
  }

  // ── 4. mTLS: does the Portal require a device certificate? ────────
  // The handshake above carried our cert if we have one. The discriminating
  // test is the opposite: connect with NO cert. If that succeeds, the Portal
  // is not enforcing mTLS, and contract §1's authentication does not exist
  // yet — which is a finding, not a pass.
  const anon = await new Promise((res) => {
    const s = tls.connect({ host: HOST, port: PORT, servername: HOST, timeout: 10_000 });
    s.once('secureConnect', () => { res({ handshook: true }); s.destroy(); });
    s.once('timeout', () => { s.destroy(); res({ handshook: false, why: 'timeout' }); });
    s.once('error', (e) => res({ handshook: false, why: `${e.code || ''} ${e.message}`.trim() }));
  });
  if (anon.handshook) {
    add('MTLS', 'FAIL', '포털이 장치 인증서를 요구하지 않는다',
      '클라이언트 인증서 없이 TLS 핸드셰이크가 성립했다.\n'
      + 'mTLS 미구성 — 누구나 이 엔드포인트에 붙을 수 있다.',
      '계약 §1 (인증: mTLS 장치 인증서) · 포털 WO-PTL-002');
  } else {
    add('MTLS', 'PASS', '포털이 장치 인증서를 요구한다', `인증서 없는 연결 거부: ${anon.why}`);
  }

  // ── 5. our own device certificate ─────────────────────────────────
  if (!ourCert || !ourKey) {
    add('CERT', 'FAIL', '이 노드의 장치 인증서가 없다',
      `CFLEX_TLS_CERT=${cfg.portal.tls.certPath || '(미설정)'}\n`
      + `CFLEX_TLS_KEY=${cfg.portal.tls.keyPath || '(미설정)'}\n`
      + `발급 절차: node bin/cflex-csr.js → CSR 을 포털에 등록 → ${NODE}.pem 수령`,
      '계약 §6-1');
  } else {
    let info = {};
    try {
      const out = execFileSync('openssl', ['x509', '-noout', '-subject', '-enddate', '-ext', 'extendedKeyUsage'],
        { input: ourCert, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      info.cn = (out.match(/CN\s*=\s*([^\n,/]+)/) || [])[1]?.trim();
      info.to = (out.match(/notAfter=(.+)/) || [])[1]?.trim();
      info.clientAuth = /TLS Web Client Authentication/.test(out);
    } catch (e) { info.err = e.message; }
    const cnOk = info.cn === EXPECT_CN;
    const left = info.to ? Math.round((new Date(info.to) - Date.now()) / 86_400_000) : null;
    add('CERT', cnOk && info.clientAuth && (left ?? 1) > 0 ? 'PASS' : 'FAIL',
      '장치 인증서',
      `CN=${info.cn || '?'} ${cnOk ? '' : `← ${EXPECT_CN} 이어야 한다`}\n`
      + `만료 ${info.to || '?'}${left != null ? ` (${left}일)` : ''}\n`
      + `clientAuth ${info.clientAuth ? 'O' : 'X'}`,
      cnOk ? null : '계약 §1 (CN=<tenant>.<node-id>)');
    if (left != null && left < 60) {
      add('CERT-EXP', 'WARN', '장치 인증서 만료 60일 이내',
        `${left}일 — 포털이 cert_renew 명령을 발행해야 한다`, '계약 §1, §6-2');
    }
  }

  // ── 6. the contract endpoints ─────────────────────────────────────
  const EPS = [
    ['POST', '/api/v1/heartbeat'],
    ['PUT', '/api/v1/inventory'],
    ['POST', '/api/v1/telemetry'],
    ['POST', '/api/v1/events'],
    ['POST', '/api/v1/files'],
    ['GET', `/api/v1/commands?node_id=${encodeURIComponent(NODE)}`],
    ['GET', `/api/v1/config?node_id=${encodeURIComponent(NODE)}&since=0`],
  ];
  const seen = [];
  for (const [method, p] of EPS) {
    const r = await request(method, p, { cert: ourCert, key: ourKey, ca: extraCa });
    seen.push({ method, path: p, ...r });
  }

  const redirected = seen.filter(s => [301, 302, 303, 307, 308].includes(s.status));
  const versioned = seen.filter(s => s.version);
  if (redirected.length === seen.length) {
    add('API', 'FAIL', '계약 엔드포인트가 없다',
      `§3 의 7개 경로 전부 ${redirected[0].status} → ${redirected[0].location}\n`
      + '세션 로그인 게이트가 앞에 있고 /api/v1 은 구현되지 않았다.',
      '계약 §3 · 포털 WO-PTL-001');
  } else {
    const bad = seen.filter(s => s.status >= 500 || s.status === 0);
    add('API', bad.length ? 'WARN' : 'PASS', `계약 엔드포인트 ${seen.length - bad.length}/${seen.length} 응답`,
      seen.map(s => `${String(s.status).padEnd(4)} ${s.method} ${s.path.split('?')[0]}${s.note ? `  ${s.note}` : ''}`).join('\n'),
      bad.length ? '계약 §3' : null);
  }
  add('VERSION', versioned.length ? 'PASS' : 'WARN',
    '응답 헤더 X-CFlex-API-Version',
    versioned.length ? versioned[0].version : '없음 — 계약 §1 은 1.0/1.1 을 응답에 싣게 되어 있다',
    versioned.length ? null : '계약 §1 (버전)');

  // ── 7. mock namespace (§7) ────────────────────────────────────────
  const mock = await request('POST', '/api/v1/_mock/heartbeat', { cert: ourCert, key: ourKey, ca: extraCa });
  add('MOCK', mock.status === 0 || mock.status >= 400 || [301, 302, 303].includes(mock.status) ? 'WARN' : 'PASS',
    '목 서버 /api/v1/_mock',
    `${mock.status}${mock.location ? ` → ${mock.location}` : ''}`
    + (mock.status === 303 ? '\n없음 — Probe 의 SAT 와 계약 테스트가 자체 목에 의존하게 된다' : ''),
    '계약 §7 · 포털 WO-PTL-001');

  // ── 8. clock drift ────────────────────────────────────────────────
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

  finish();
}

function request(method, path, { cert, key, ca }) {
  return new Promise((res) => {
    const https = require('node:https');
    const req = https.request({
      host: HOST, port: PORT, path, method, servername: HOST,
      cert: cert || undefined, key: key || undefined,
      ca: ca?.length ? [...tls.rootCertificates, ...ca] : undefined,
      headers: {
        'X-CFlex-Tenant': TENANT,
        'X-CFlex-Node': NODE,
        'Content-Type': 'application/json',
        'Idempotency-Key': require('node:crypto').randomUUID(),
        'User-Agent': 'cflex-portal-check',
      },
      timeout: 10_000,
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
        res({
          status: r.statusCode,
          location: r.headers.location,
          version: r.headers['x-cflex-api-version'],
          date: r.headers.date,
          note: body && r.statusCode >= 400 ? body.slice(0, 80) : '',
        });
      });
    });
    req.once('timeout', () => { req.destroy(); res({ status: 0, note: 'timeout' }); });
    req.once('error', (e) => res({ status: 0, note: `${e.code || ''} ${e.message}`.trim() }));
    // An empty JSON body: this is a reachability probe, not a real submission,
    // and the Portal should reject it on schema grounds rather than store it.
    req.end(method === 'GET' ? undefined : '{}');
  });
}

function finish() {
  const n = (v) => results.filter(r => r.verdict === v).length;
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      portal: cfg.portal.url, node: NODE, tenant: TENANT,
      summary: { pass: n('PASS'), warn: n('WARN'), fail: n('FAIL'), skip: n('SKIP') },
      checks: results,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`\n  ${n('PASS')} pass · ${n('WARN')} warn · ${n('FAIL')} fail\n`);
    const blockers = results.filter(r => r.verdict === 'FAIL');
    if (blockers.length) {
      process.stdout.write('\n  연동을 막는 것:\n');
      for (const b of blockers) process.stdout.write(`    ${b.id}  ${b.title}${b.ref ? `  (${b.ref})` : ''}\n`);
    }
    process.stdout.write('\n');
  }
  process.exit(n('FAIL') ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`cflex-portal-check: ${e.stack}\n`); process.exit(3); });
