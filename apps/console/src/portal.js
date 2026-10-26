// portal.js — the Local Console's 포털 연동 page, server side.
//
// WHAT THIS IS FOR. The Portal connection belongs to the COLLECTOR, not to
// this app node: cap01's forwarder dials out, holds the queue and carries the
// device certificate. Until now the console could only display what the
// collector happened to report in its heartbeat, so "연동이 안 된다" meant
// ssh-ing to cap01 and reading a .env.
//
// So this stores the Portal settings here and the collector PULLS them
// (`GET /collector/v1/config`), which is the channel that already exists and
// the only direction contract 00 allows — the app never dials the collector.
//
// ── the device key never moves ──
//
// Enrolment is the awkward part. Contract §6 says the Probe generates the CSR
// and the key never leaves the node, but the person who talks to the CA is an
// admin sitting in front of this console. So:
//
//   collector  POST /collector/v1/enroll   { csr, pubkey_sha256 }   ← key stays home
//   admin      reads the CSR here, gets it signed, pastes the certificate
//   collector  GET  /collector/v1/certs    { cert, ca }             ← picks it up
//
// The certificate is public; only the key is secret, and it is never in this
// database, this process, or this screen.
'use strict';
const crypto = require('node:crypto');
const { runChecks, certInfo } = require('../../../probe-agent/src/portal/check');

const bad = (code, message, extra) =>
  Object.assign(new Error(message || code), { status: 400, code, extra });

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const clean = (v, n = 256) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
const int = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// Contract §1 / D-07 defaults. These are what the collector gets if an admin
// never touches the page, and they are the contract's numbers, not guesses.
const DEFAULTS = Object.freeze({
  enabled: true,
  url: 'https://cflex.fms.support',
  ip_pin: '40.114.79.164',
  proxy: null,
  heartbeat_ms: 60_000,          // 계약 §3.1
  poll_ms: 60_000,               // spec 01 §2.1, 최소 10s
  telemetry_flush_ms: 60_000,    // 계약 §3.3
  buffer_days: 7,                // 계약 §1, D-07
  legacy_forward: false,         // 구 /v1/probe/event — 기본 off
});

function createPortal(db, { sealer, tenant, checker = runChecks, now = Date.now } = {}) {
  const getSetting = (k, d) => {
    try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value); }
    catch { return d; }
  };
  const putSetting = (k, v, by) => db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(k, JSON.stringify(v), by || null, now());

  // ── config ──────────────────────────────────────────────────────

  /**
   * @param {boolean} open  include the proxy password in the clear. Only the
   *                        collector config pull does this; the screen never does.
   */
  function get({ open = false } = {}) {
    const s = { ...DEFAULTS, ...(getSetting('portal', {}) || {}) };
    if (s.proxy_password?.sealed) {
      s.proxy_password = open ? sealer.open(s.proxy_password.sealed).v : { set: true };
    } else if (!open) {
      delete s.proxy_password;
    }
    return s;
  }

  function put(b = {}, by) {
    const cur = getSetting('portal', {}) || {};
    const next = { ...cur };

    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (b.legacy_forward !== undefined) next.legacy_forward = !!b.legacy_forward;

    if (b.url !== undefined) {
      const u = clean(b.url, 512);
      if (!u) throw bad('invalid_url', 'url 은 비울 수 없다');
      let parsed;
      try { parsed = new URL(u); } catch { throw bad('invalid_url', u); }
      // http:// to the managed service would carry a device certificate and
      // customer telemetry in the clear. Contract §1 says HTTPS.
      if (parsed.protocol !== 'https:') throw bad('invalid_url', 'https 만 허용된다 (계약 §1)');
      next.url = u.replace(/\/+$/, '');
    }

    if (b.ip_pin !== undefined) {
      const ip = clean(b.ip_pin, 45);
      if (ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw bad('invalid_ip_pin', ip);
      next.ip_pin = ip;   // null disables the pin check
    }

    if (b.proxy !== undefined) {
      const p = clean(b.proxy, 512);
      if (p) { try { new URL(p); } catch { throw bad('invalid_proxy', p); } }
      next.proxy = p;
    }
    // `{set:true}` comes back from a GET; it means "leave it alone".
    if (b.proxy_password !== undefined && !(b.proxy_password && b.proxy_password.set)) {
      next.proxy_password = b.proxy_password
        ? { sealed: sealer.seal({ v: String(b.proxy_password) }) }
        : undefined;
    }

    if (b.heartbeat_ms !== undefined) next.heartbeat_ms = int(b.heartbeat_ms, 30_000, 600_000, DEFAULTS.heartbeat_ms);
    // spec 01 §2.1 floors polling at 10 s; below that a 48-device fleet cannot
    // finish a cycle and every tick is skipped.
    if (b.poll_ms !== undefined) next.poll_ms = int(b.poll_ms, 10_000, 3_600_000, DEFAULTS.poll_ms);
    if (b.telemetry_flush_ms !== undefined) next.telemetry_flush_ms = int(b.telemetry_flush_ms, 10_000, 600_000, DEFAULTS.telemetry_flush_ms);
    if (b.buffer_days !== undefined) next.buffer_days = int(b.buffer_days, 1, 30, DEFAULTS.buffer_days);

    putSetting('portal', next, by);
    return get();
  }

  // ── enrolment ───────────────────────────────────────────────────

  const PEM = (label) => new RegExp(`-----BEGIN ${label}-----[\\s\\S]+-----END ${label}-----`);

  /**
   * The collector posts its CSR. Idempotent: the same CSR re-posted is a no-op.
   *
   * A NEW CSR — first enrolment or a new key pair — additionally requires a
   * one-time token (see issueEnrollToken). Re-posting the same CSR does not:
   * a collector restart must not need an operator.
   */
  function enroll(nodeId, { csr, pubkey_sha256, enroll_token } = {}) {
    const node = clean(nodeId, 64);
    if (!node) throw bad('node_required');
    const pem = String(csr || '').trim();
    if (!PEM('CERTIFICATE REQUEST').test(pem)) throw bad('invalid_csr', 'PEM CERTIFICATE REQUEST 가 아니다');
    if (pem.length > 8192) throw bad('invalid_csr', 'too large');

    const row = db.prepare('SELECT * FROM enrollments WHERE node_id = ?').get(node);
    if (row && row.csr === pem) return { node_id: node, unchanged: true, state: state(row) };
    // An operator may have pre-registered this node (state 'expected', empty
    // csr). The collector's CSR fills that row in; it is not a conflict.
    //
    // But a new key pair is an identity change, so it costs a token.
    consumeEnrollToken(node, enroll_token, pem);

    // A new CSR means a new key pair, so any certificate we hold is dead.
    db.prepare(
      `INSERT INTO enrollments (node_id, csr, pubkey_sha256, requested_at, cert, ca, signed_at, signed_by)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(node_id) DO UPDATE SET csr = excluded.csr, pubkey_sha256 = excluded.pubkey_sha256,
         requested_at = excluded.requested_at, cert = NULL, ca = NULL, signed_at = NULL, signed_by = NULL`,
    ).run(node, pem, clean(pubkey_sha256, 64), now());
    return { node_id: node, unchanged: false, state: 'pending' };
  }

  /** What the collector picks up once an admin has pasted the signed certificate. */
  function certsFor(nodeId) {
    const r = db.prepare('SELECT cert, ca, signed_at FROM enrollments WHERE node_id = ?').get(clean(nodeId, 64));
    if (!r?.cert) return { pending: true };
    return { pending: false, cert: r.cert, ca: r.ca || null, signed_at: r.signed_at };
  }

  /**
   * An admin pastes the certificate the CA signed.
   *
   * Validated hard, because the failure it prevents is silent: paste the wrong
   * node's certificate and the collector installs it, the Portal rejects every
   * call, and nothing on this screen says why. The public key must match the
   * CSR we hold — that is the check that catches it.
   */
  function signCert(nodeId, { cert, ca } = {}, by) {
    const node = clean(nodeId, 64);
    const row = db.prepare('SELECT * FROM enrollments WHERE node_id = ?').get(node);
    if (!row) throw bad('no_enrollment', `${node} 의 CSR 이 없다 — collector 가 먼저 등록해야 한다`);

    const pem = String(cert || '').trim();
    if (!PEM('CERTIFICATE').test(pem)) throw bad('invalid_cert', 'PEM CERTIFICATE 가 아니다');
    if (pem.length > 32_768) throw bad('invalid_cert', 'too large');
    const caPem = ca ? String(ca).trim() : null;
    if (caPem && !PEM('CERTIFICATE').test(caPem)) throw bad('invalid_ca', 'PEM CERTIFICATE 가 아니다');

    const info = certInfo(pem);
    if (info.error) throw bad('invalid_cert', info.error);

    const expect = `${tenant}.${node}`;
    if (info.cn !== expect) {
      throw bad('cn_mismatch', `인증서 CN=${info.cn} 인데 ${expect} 이어야 한다 (계약 §1)`, { cn: info.cn, expect });
    }
    if (!info.clientAuth) {
      throw bad('no_client_auth', 'clientAuth EKU 가 없다 — 포털이 거부한다');
    }
    // The injected clock, not new Date(): the expiry path is exactly what a
    // test needs to move time for, and mixing the two makes it untestable.
    if (new Date(info.to).getTime() <= now()) {
      throw bad('expired', `이미 만료됐다 (${info.to})`);
    }
    // The one that catches a mixed-up paste.
    if (row.pubkey_sha256 && info.pubkeySha256 !== row.pubkey_sha256) {
      throw bad('key_mismatch',
        '이 인증서의 공개키가 등록된 CSR 과 다르다 — 다른 노드의 인증서이거나 CSR 이 그 사이에 재생성됐다',
        { cert: info.pubkeySha256.slice(0, 16), csr: row.pubkey_sha256.slice(0, 16) });
    }

    db.prepare('UPDATE enrollments SET cert = ?, ca = ?, signed_at = ?, signed_by = ? WHERE node_id = ?')
      .run(pem, caPem, now(), clean(by, 64), node);
    return listEnrollments().find(e => e.node_id === node);
  }

  /**
   * Pre-register a node an operator expects, before its collector has ever
   * connected. Without this the page is empty until a CSR happens to arrive,
   * which gives an operator nothing to act on and no way to tell "not deployed
   * yet" from "deployed and silent".
   *
   * Creates a row with no CSR. The collector's own enrolment fills it in.
   */
  function addNode(b = {}, by) {
    const node = clean(b.node_id, 32);
    if (!node) throw bad('node_required');
    // Contract §1 / 인계 가이드 §1: lower case, digits, _ and -.
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(node)) {
      throw bad('invalid_node_id', '소문자·숫자·_·- 로 시작하는 32자 이내여야 한다');
    }
    const site = clean(b.site_id, 32);
    if (site && !/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(site)) {
      throw bad('invalid_site_id', '대문자·숫자·- 로 시작하는 32자 이내여야 한다');
    }
    const role = clean(b.role, 16) || 'collector';
    if (!['collector', 'app'].includes(role)) throw bad('invalid_role', 'collector 또는 app');

    if (db.prepare('SELECT node_id FROM enrollments WHERE node_id = ?').get(node)) {
      throw bad('exists', `${node} 는 이미 등록돼 있다`);
    }
    // Collector ID and Site ID are separate. A collector may reach devices at
    // several sites, and the server must not take the node's word for which —
    // so the allowed set is recorded here and checked on every submission.
    const allowed = Array.isArray(b.allowed_sites) ? b.allowed_sites : (site ? [site] : []);
    const sites = [...new Set(allowed.map(x => clean(x, 32)).filter(Boolean))];
    for (const x of sites) {
      if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(x)) throw bad('invalid_site_id', x);
    }
    db.prepare(
      `INSERT INTO enrollments (node_id, csr, pubkey_sha256, requested_at, site_id, role, added_by, allowed_sites)
         VALUES (?, '', NULL, ?, ?, ?, ?, ?)`,
    ).run(node, now(), site, role, clean(by, 64), JSON.stringify(sites));
    return listEnrollments().find(e => e.node_id === node);
  }

  function removeNode(nodeId, by) {
    const node = clean(nodeId, 32);
    const r = db.prepare('SELECT csr, cert FROM enrollments WHERE node_id = ?').get(node);
    if (!r) throw bad('no_enrollment', node);
    // A node that has enrolled is not deleted from here: its certificate is
    // live and removing the row would lose the audit trail. Revoke first.
    if (r.cert) throw bad('has_cert', '인증서를 먼저 내려야 한다 (인증서 내리기)');
    db.prepare('DELETE FROM enrollments WHERE node_id = ?').run(node);
    return { removed: node };
  }

  const state = (r) => (r.cert ? 'signed' : (r.csr ? 'pending' : 'expected'));

  function listEnrollments() {
    return db.prepare('SELECT * FROM enrollments ORDER BY node_id').all().map((r) => {
      const info = r.cert ? certInfo(r.cert) : null;
      const left = info && !info.error ? Math.round((new Date(info.to) - now()) / 86_400_000) : null;
      return {
        node_id: r.node_id,
        state: state(r),
        site_id: r.site_id || null,
        allowed_sites: sitesOf(r),
        role: r.role || null,
        added_by: r.added_by || null,
        requested_at: r.requested_at,
        signed_at: r.signed_at,
        signed_by: r.signed_by,
        pubkey_sha256: r.pubkey_sha256 ? `${r.pubkey_sha256.slice(0, 16)}…` : null,
        expect_cn: `${tenant}.${r.node_id}`,
        // The CSR is public and the admin has to copy it out of here.
        csr: r.csr || null,
        cert: info && !info.error
          ? { cn: info.cn, issuer: info.issuer?.split('\n')[0] || null, to: info.to, days_left: left, client_auth: info.clientAuth }
          : null,
        // Contract §1: the Portal issues cert_renew 60 days out.
        renew_due: left != null && left < 60,
      };
    });
  }

  function revoke(nodeId, by) {
    const node = clean(nodeId, 64);
    const r = db.prepare('SELECT node_id FROM enrollments WHERE node_id = ?').get(node);
    if (!r) throw bad('no_enrollment', node);
    // The CSR stays: the collector still holds the matching key, so the node
    // can be re-signed without regenerating it.
    db.prepare('UPDATE enrollments SET cert = NULL, ca = NULL, signed_at = NULL, signed_by = ? WHERE node_id = ?')
      .run(clean(by, 64), node);
    return listEnrollments().find(e => e.node_id === node);
  }


  // ── allowed sites ───────────────────────────────────────────────

  const sitesOf = (r) => {
    try {
      const a = JSON.parse(r?.allowed_sites || 'null');
      if (Array.isArray(a)) return a;
    } catch { /* fall through */ }
    return r?.site_id ? [r.site_id] : [];
  };

  /**
   * May this node submit data for this site?
   *
   * Enforced server-side because the node supplies `site_id` in its own
   * payloads: trusting it would let one site's collector write another site's
   * devices, and multi-site isolation is the thing the registration exists to
   * guarantee. An unregistered node is refused outright.
   */
  function assertSite(nodeId, siteId) {
    const node = clean(nodeId, 32);
    const site = clean(siteId, 32);
    const r = db.prepare('SELECT site_id, allowed_sites FROM enrollments WHERE node_id = ?').get(node);
    if (!r) throw bad('node_not_registered', `${node} 는 등록돼 있지 않다`);
    const allowed = sitesOf(r);
    if (!site) throw bad('site_required', 'site_id 가 없다');
    if (!allowed.includes(site)) {
      throw bad('site_not_allowed',
        `${node} 는 ${site} 로 보낼 수 없다 (허용: ${allowed.join(', ') || '없음'})`,
        { node_id: node, site_id: site, allowed });
    }
    return { node_id: node, site_id: site, allowed };
  }

  function setAllowedSites(nodeId, list, by) {
    const node = clean(nodeId, 32);
    if (!db.prepare('SELECT node_id FROM enrollments WHERE node_id = ?').get(node)) throw bad('no_enrollment', node);
    const sites = [...new Set((Array.isArray(list) ? list : []).map(x => clean(x, 32)).filter(Boolean))];
    for (const x of sites) if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(x)) throw bad('invalid_site_id', x);
    db.prepare('UPDATE enrollments SET allowed_sites = ? WHERE node_id = ?').run(JSON.stringify(sites), node);
    return listEnrollments().find(e => e.node_id === node);
  }

  // ── one-time enrolment tokens ───────────────────────────────────

  /**
   * The credential a node needs to enrol, or to RE-enrol with a new key pair.
   *
   * Scoped to one node, expiring, and consumed on first use. The collector key
   * is not enough on its own: it is permanent and reusable, so a leaked one
   * would let anyone replace that node's key pair for ever — taking over its
   * identity while every call still authenticates.
   */
  function issueEnrollToken(nodeId, { ttlMinutes = 60 } = {}, by) {
    const node = clean(nodeId, 32);
    if (!db.prepare('SELECT node_id FROM enrollments WHERE node_id = ?').get(node)) {
      throw bad('no_enrollment', `${node} 를 먼저 등록하라 (노드 추가)`);
    }
    const ttl = Math.min(1440, Math.max(5, parseInt(ttlMinutes, 10) || 60));
    const token = crypto.randomBytes(32).toString('base64url');
    // Only the hash is kept. The token is shown once and cannot be recovered.
    db.prepare(
      `INSERT INTO enroll_tokens (token_hash, tenant, node_id, expires_at, issued_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sha(token), tenant, node, now() + ttl * 60_000, clean(by, 64), now());
    return { node_id: node, token, expires_at: now() + ttl * 60_000, ttl_minutes: ttl };
  }

  /** Consume a token for this node, or throw. Single use, enforced by the write. */
  function consumeEnrollToken(nodeId, token, csrPem) {
    const node = clean(nodeId, 32);
    if (!token) throw bad('enroll_token_required', '최초/재등록에는 1회용 등록 토큰이 필요하다');
    const row = db.prepare('SELECT * FROM enroll_tokens WHERE token_hash = ?').get(sha(String(token)));
    // The same message for every failure mode on purpose: an attacker must not
    // learn whether a token exists, belongs to another node, or is spent.
    const refuse = () => { throw bad('enroll_token_invalid', '등록 토큰이 유효하지 않다'); };
    if (!row) refuse();
    if (row.node_id !== node) refuse();
    if (row.tenant !== tenant) refuse();
    if (row.used_at) refuse();
    if (row.expires_at <= now()) refuse();
    const r = db.prepare('UPDATE enroll_tokens SET used_at = ?, used_by_csr = ? WHERE token_hash = ? AND used_at IS NULL')
      .run(now(), csrPem ? sha(csrPem).slice(0, 16) : null, row.token_hash);
    // Lost the race with a concurrent use: the token was single-use and the
    // other caller got it.
    if (!r.changes) refuse();
    return { node_id: node, consumed_at: now() };
  }

  const listEnrollTokens = () => db.prepare(
    'SELECT node_id, expires_at, used_at, issued_by, created_at FROM enroll_tokens ORDER BY created_at DESC LIMIT 50',
  ).all().map(r => ({
    ...r,
    state: r.used_at ? 'used' : (r.expires_at <= now() ? 'expired' : 'open'),
  }));


  // ── registration stages ─────────────────────────────────────────
  //
  // Six stages, because "a certificate is registered" is not "the node
  // installed it" is not "it connected" is not "data is flowing". Collapsing
  // them is how a screen reads healthy while the Portal has never received a
  // heartbeat — which is exactly what happened before this existed.
  //
  // Each stage carries WHO says so:
  //
  //   console   this console's own record. A fact we own.
  //   probe     the node's self-report, from its heartbeat. Trust it only as
  //             far as `as_of` — a node that stopped reporting keeps its last
  //             answer, and a stale answer is not a current one.
  //   verified  this console reached the Portal itself (portal.check()). The
  //             only stage evidence that does not come from the node.
  //
  // Nothing here infers a later stage from an earlier one.
  const STAGE_MS = 5 * 60_000;          // a report older than this is stale

  function stagesFor(enr, report) {
    const hb = report?.portal || null;
    const cert = report?.cert || null;
    const seen = report?.last_seen ?? null;
    const stale = seen == null || (now() - seen) > STAGE_MS;

    const st = (key, label, by, state, detail, asOf = null) => ({
      key, label, by, state, detail,
      as_of: asOf,
      // A probe-reported stage whose report is old is not "ok" — it is unknown.
      stale: by === 'probe' ? stale : false,
    });

    const haveCsr = !!enr.csr;
    const haveCert = !!enr.cert;
    // revoke() clears cert but keeps signed_by, so a row that was signed and
    // now is not has been withdrawn rather than never issued.
    const revoked = !haveCert && !!enr.signed_by;

    const out = [
      st('registered', '등록 대기', 'console', 'ok',
        `${enr.node_id} · ${enr.site_id || '사이트 미지정'} · ${enr.role || 'collector'}`,
        enr.requested_at),

      st('csr', 'CSR 접수', 'console', haveCsr ? 'ok' : 'waiting',
        haveCsr ? `공개키 ${enr.pubkey_sha256 || '?'}` : 'collector 가 아직 올리지 않았다',
        haveCsr ? enr.requested_at : null),

      st('issued', '승인·발급', 'console',
        revoked ? 'revoked' : haveCert ? 'ok' : haveCsr ? 'waiting' : 'blocked',
        revoked ? '인증서가 내려졌다 — CSR 은 남아 있어 재서명 가능'
          : haveCert ? `CN=${enr.cert.cn} · 만료 ${enr.cert.to}`
            : haveCsr ? 'CA 서명 후 등록 대기' : 'CSR 이 먼저다',
        enr.signed_at),
    ];

    // ── 4. installed — the node's own answer, never inferred from §3 ──
    if (!cert) {
      out.push(st('installed', '설치 확인', 'probe', haveCert ? 'unknown' : 'blocked',
        haveCert ? 'collector 보고 없음 — 가져갔는지 알 수 없다' : '발급이 먼저다', seen));
    } else if (cert.state === 'signed' && cert.in_use) {
      out.push(st('installed', '설치 확인', 'probe', 'ok',
        `노드가 보유·사용 중 · 만료 ${cert.to} (${cert.days_left}일)`, seen));
    } else if (cert.state === 'signed') {
      // On disk but not loaded: the forwarder reads its TLS material at
      // construction, so this needs a restart before it can connect.
      out.push(st('installed', '설치 확인', 'probe', 'warn',
        '디스크에 있으나 사용 중이 아니다 — 프로브 재시작이 필요하다', seen));
    } else if (cert.state === 'expired') {
      out.push(st('installed', '설치 확인', 'probe', 'expired',
        `노드의 인증서가 만료됐다 (${cert.to})`, seen));
    } else {
      out.push(st('installed', '설치 확인', 'probe', 'waiting',
        `노드 상태: ${cert.state}`, seen));
    }

    // ── 5. mTLS link — reachability, as the node saw it ──
    const reach = hb?.last_reachable ?? null;
    if (!hb) {
      out.push(st('linked', 'mTLS 연결 확인', 'probe', 'unknown', 'collector 보고 없음', seen));
    } else if (hb.enabled === false) {
      out.push(st('linked', 'mTLS 연결 확인', 'probe', 'off', '포털 전송이 꺼져 있다', seen));
    } else if (reach) {
      out.push(st('linked', 'mTLS 연결 확인', 'probe', 'ok',
        `마지막 성공 ${new Date(reach).toISOString()}`, seen));
    } else {
      out.push(st('linked', 'mTLS 연결 확인', 'probe', 'failed',
        hb.last_error ? `아직 성공 없음 — ${hb.last_error}` : '아직 성공 없음', seen));
    }

    // ── 6. data flowing ──
    if (!hb) {
      out.push(st('flowing', '수집·전송', 'probe', 'unknown', 'collector 보고 없음', seen));
    } else if ((hb.sent || 0) > 0 && reach) {
      out.push(st('flowing', '수집·전송', 'probe', 'ok',
        `전송 ${hb.sent} · 거부 ${hb.rejected || 0} · 큐 ${hb.queued || 0}`, seen));
    } else if ((hb.queued || 0) > 0) {
      out.push(st('flowing', '수집·전송', 'probe', 'warn',
        `큐 ${hb.queued} 대기 — 연결되면 나간다`, seen));
    } else {
      out.push(st('flowing', '수집·전송', 'probe', 'waiting', '전송 0건', seen));
    }

    // ── flags, separate from the stage line ──
    const flags = [];
    if (revoked) flags.push({ key: 'revoked', label: '폐기', detail: `by ${enr.signed_by}` });
    if (enr.cert && enr.cert.days_left != null && enr.cert.days_left <= 0) {
      flags.push({ key: 'expired', label: '만료', detail: enr.cert.to });
    } else if (enr.renew_due) {
      flags.push({ key: 'renew_due', label: '갱신 예정', detail: `${enr.cert?.days_left}일 남음 (계약 §1·§6-2: 60일 창)` });
    }
    if (hb && hb.enabled !== false && !reach && hb.last_error) {
      flags.push({ key: 'link_failed', label: '연결 실패', detail: hb.last_error });
    }
    if (haveCert && stale) {
      flags.push({ key: 'no_report', label: '보고 없음', detail: seen ? `마지막 보고 ${Math.round((now() - seen) / 60000)}분 전` : '보고 이력 없음' });
    }

    // The furthest stage actually reached — never guessed from a later one.
    let reached = null;
    for (const x of out) { if (x.state === 'ok' && !x.stale) reached = x.key; else break; }

    return { stages: out, flags, reached, report_as_of: seen, report_stale: stale };
  }

  // ── the check ───────────────────────────────────────────────────

  /**
   * Run the same checks `cflex-portal-check` runs, from this node, with the
   * certificate we hold for `nodeId`.
   *
   * This node is not the collector, so TCP/TLS/mTLS/API results describe the
   * app host's path to the Portal. That is still the answer an admin wants —
   * both hosts have the same egress rule (spec 01 §1) — and the report says so.
   */
  async function check({ node_id } = {}) {
    const cfg = get({ open: true });
    const node = clean(node_id, 64) || null;
    const enr = node ? db.prepare('SELECT cert, ca FROM enrollments WHERE node_id = ?').get(node) : null;

    const report = await checker({
      url: cfg.url,
      tenant,
      nodeId: node || 'app01',
      tls: enr?.cert ? { cert: enr.cert, key: null, ca: [enr.ca].filter(Boolean) } : {},
      pinnedIp: cfg.ip_pin || '',
      proxy: cfg.proxy || '',
    });

    return {
      ...report,
      ran_from: 'app',
      node_id: node,
      // Said plainly rather than left for someone to infer from a green screen.
      note: enr?.cert
        ? '이 점검은 app 노드에서 실행됐고 개인키는 collector 에 있다. CERT 는 인증서 내용만 검사한다 — 실제 mTLS 접속 성립은 collector 의 heartbeat 로 확인한다.'
        : 'collector 의 장치 인증서가 아직 없어 익명으로 점검했다.',
    };
  }

  return {
    DEFAULTS, get, put, enroll, certsFor, signCert, listEnrollments,
    addNode, removeNode, revoke, check,
    assertSite, setAllowedSites, sitesOf, stagesFor, STAGE_MS,
    issueEnrollToken, consumeEnrollToken, listEnrollTokens,
  };
}

module.exports = { createPortal, DEFAULTS };
