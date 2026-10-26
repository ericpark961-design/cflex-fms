// server.js — the Local Console API (cflex-app), spec 01 §2.2.
//
//   /v1/auth/*, /v1/me          local accounts, sessions in Redis
//   /v1/fms/*                   what apps/twin reads (same keys as before)
//   /v1/console/*               alarms detail/comment, maintenance, settings, users, status
//   /collector/v1/*             the Collector: telemetry/events/heartbeat in, devices/config out;
//                               alarm events are notified from here (notify.js)
//   /twin/*                     the existing UI (apps/twin, console build)
//   /login, /settings           the two pages twin does not have
//
// Behind nginx on 443; listens on 0.0.0.0 (config.js). Stateless: app01 and
// app02 run this same file against the same database and Redis.
const http = require('http');
const { HttpError, readBody, parseCookies, send, serveFile, createRouter } = require('./http');
const auth = require('./auth');
const { createViews } = require('./views');
const { createIngest } = require('./ingest');
const { createSettings } = require('./settings');
const { createSealer } = require('./seal');
const { createConsoleNotify, announces, netFrom } = require('./notify');

const COOKIE = 'cflex_sid';

/**
 * @param {object} o
 * @param {object} o.config     config.js load()
 * @param {object} o.db         db.js open()
 * @param {object} o.redis      redis.js client
 * @param {Function} [o.now]
 * @param {object} [o.notifyDeps]  injected into the notifier: {http, smtpSend} (tests)
 * @param {object} [o.log]
 */
function createApp({ config, db, redis, now = Date.now, notifyDeps = null, log = console }) {
  const sessions = auth.createSessions(redis, config.session);
  const lockout = auth.createLockout(redis, config.lockout);
  const views = createViews(db, { staleMs: config.staleMs, now });
  const ingest = createIngest(db, { now });
  const sealer = createSealer(config.secretKey);
  const settings = createSettings(db, { sealer, tenant: config.tenant, now });
  const notify = createConsoleNotify({
    db, settings, deps: notifyDeps || {}, now, log, replayMaxAgeMs: config.notify?.replayMaxMs, net: netFrom(config.notify),
  });
  const router = createRouter();
  const R = (m, p, role, h) => router.add(m, p, { role }, h);

  const audit = (c, action, target, detail) => db.run('INSERT INTO audit_log (ts, actor, action, target, detail, ip, node) VALUES (?, ?, ?, ?, ?, ?, ?)',
    now(), c.session?.username || c.collector?.node_id || null, action,
    target == null ? null : String(target), detail == null ? null : JSON.stringify(detail), c.ip, config.nodeId);

  const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${config.cookieSecure ? '; Secure' : ''}; Max-Age=${maxAge}`;
  const intId = (v) => { const n = parseInt(v, 10); if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_id'); return n; };
  const devRow = (ref) => {
    // twin passes the numeric id, or 'ups-<id>' from an alert row.
    const m = /^(?:ups-)?(\d+)$/.exec(String(ref));
    return m ? db.one('SELECT * FROM devices WHERE id = ?', +m[1]) : db.one('SELECT * FROM devices WHERE device_id = ?', String(ref));
  };

  // ── auth ─────────────────────────────────────────────────────────────────
  R('POST', '/v1/auth/login', null, async (c) => {
    const { username, password } = c.body || {};
    const u = String(username || '').trim();
    if (!u || !password) throw new HttpError(400, 'credentials_required');
    if (await lockout.locked(u)) { await audit(c, 'login_locked', u); throw new HttpError(423, 'locked', 'too many failed attempts; try again later'); }
    const row = await db.one('SELECT * FROM users WHERE lower(username) = lower(?)', u);
    const ok = auth.verifyPassword(password, row ? row.pw_hash : auth.DUMMY_HASH) && row && !row.disabled;
    if (!ok) {
      const n = await lockout.fail(u);
      await audit(c, 'login_failed', u, { attempt: n });
      throw new HttpError(401, 'invalid_credentials');
    }
    await lockout.clear(u);
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), row.id);
    const { token } = await sessions.create(row, { ip: c.ip });
    c.session = { username: row.username };
    await audit(c, 'login', row.username);
    return { status: 200, headers: { 'Set-Cookie': cookie(token, config.session.absoluteS) },
      body: { ok: true, user: settings.userOut(row), must_change: !!row.must_change } };
  });

  R('POST', '/v1/auth/logout', 'any', async (c) => {
    await sessions.destroy(c.token);
    await audit(c, 'logout', c.session.username);
    return { status: 200, headers: { 'Set-Cookie': cookie('', 0) }, body: { ok: true } };
  });

  R('POST', '/v1/auth/password', 'any', async (c) => {
    const { current, next } = c.body || {};
    const row = await db.one('SELECT * FROM users WHERE id = ?', c.session.uid);
    if (!row || !auth.verifyPassword(current || '', row.pw_hash)) throw new HttpError(401, 'invalid_credentials');
    const why = auth.passwordProblem(next, row.username);
    if (why) throw new HttpError(400, 'weak_password', why);
    if (auth.verifyPassword(next, row.pw_hash)) throw new HttpError(400, 'weak_password', 'must differ from the current password');
    await db.run('UPDATE users SET pw_hash = ?, pw_changed_at = ?, must_change = 0 WHERE id = ?', auth.hashPassword(next), now(), row.id);
    await audit(c, 'password_change', row.username);
    return { ok: true };
  });

  R('GET', '/v1/me', 'any', async (c) => {
    const u = await db.one('SELECT * FROM users WHERE id = ?', c.session.uid);
    return {
      userId: u.id, email: u.email || '', displayName: u.display_name || u.username, username: u.username,
      role: u.role, persona: u.role, must_change: !!u.must_change,
      tenantId: 1, tenantName: config.tenantName,
      tenant: { id: 1, name: config.tenant, display_name: config.tenantName, status: 'active', mode: 'prod', skus: ['fms'] },
      sku: ['fms'], teamIds: [], landingRoute: '/twin/', console: { node: config.nodeId, saml: config.saml.enabled },
    };
  });

  // ── what twin reads (viewer) ─────────────────────────────────────────────
  R('GET', '/v1/fms/summary', 'viewer', (c) => views.summary(c.query.cbu));
  R('GET', '/v1/fms/assets', 'viewer', async (c) => { const a = await views.assets(c.query.cbu); return { ok: true, count: a.length, assets: a }; });
  R('GET', '/v1/fms/assets/:id', 'viewer', async (c) => {
    const d = await devRow(c.params.id);
    const r = d && await views.assetDetail(d.id, c.query.range);
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  });
  R('GET', '/v1/fms/assets/:id/thresholds', 'viewer', async (c) => {
    const d = await devRow(c.params.id);
    if (!d) throw new HttpError(404, 'not_found');
    return { ok: true, thresholds: await views.thresholds(d) };
  });
  R('GET', '/v1/fms/floor', 'viewer', (c) => views.floor(c.query.cbu));
  R('GET', '/v1/fms/alerts', 'viewer', (c) => views.alerts({
    hours: Math.min(24 * 90, Math.max(1, parseInt(c.query.hours, 10) || 24)),
    state: c.query.state, priority: c.query.priority, cbu: c.query.cbu, limit: parseInt(c.query.limit, 10) || 500,
  }));
  R('GET', '/v1/fms/fleet-live', 'viewer', (c) => views.fleetLive(parseInt(c.query.minutes, 10) || 60, c.query.cbu));
  R('GET', '/v1/fms/channels/health', 'viewer', async () => ({ ok: true, channels: await settings.channelsHealth() }));
  // Alarm routing and device control are the Portal's (D-01) and device
  // writes are forbidden (D-05). The internal build (Q-2026-10-25-09 (B))
  // has no screen that asks, so it does not answer at all — 404, like
  // copilot, power chain, topology, tickets and incidents. A `portal`
  // profile keeps the honest empty lists the full twin build reads instead
  // of falling back to its sample data.
  if (config.profile === 'portal') {
    R('GET', '/v1/fms/routes', 'viewer', () => ({ ok: true, routes: [], stats: {}, note: 'alarm routing is configured in the portal' }));
    R('GET', '/v1/fms/control/actions', 'viewer', () => ({ ok: true, actions: [] }));
  }

  // ── alarms: detail, ACK, comments (operator) ─────────────────────────────
  R('GET', '/v1/fms/alerts/:id', 'viewer', async (c) => {
    const r = await views.alertDetail(intId(c.params.id));
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  });
  const alarmRow = async (id) => {
    const a = await db.one('SELECT * FROM alarms WHERE id = ?', intId(id));
    if (!a) throw new HttpError(404, 'not_found');
    return a;
  };
  R('POST', '/v1/fms/alerts/:id/ack', 'operator', async (c) => {
    const a = await alarmRow(c.params.id);
    const t = now();
    const by = c.session.username;
    await db.run('UPDATE alarms SET acked_at = ?, acked_by = ? WHERE id = ?', t, by, a.id);
    await db.run(`INSERT INTO alarm_comments (alarm_id, ts, author, kind, text) VALUES (?, ?, ?, 'ack', ?)`, a.alarm_id, t, by, clip(c.body?.comment, 1000));
    await audit(c, 'alarm_ack', a.alarm_id, { code: a.code });
    return { ok: true, id: a.id, acked_at: t, acked_by: by };
  });
  R('POST', '/v1/fms/alerts/:id/unack', 'operator', async (c) => {
    const a = await alarmRow(c.params.id);
    await db.run('UPDATE alarms SET acked_at = NULL, acked_by = NULL WHERE id = ?', a.id);
    await db.run(`INSERT INTO alarm_comments (alarm_id, ts, author, kind, text) VALUES (?, ?, ?, 'unack', NULL)`, a.alarm_id, now(), c.session.username);
    await audit(c, 'alarm_unack', a.alarm_id);
    return { ok: true, id: a.id, acked_at: null };
  });
  R('POST', '/v1/fms/alerts/:id/comments', 'operator', async (c) => {
    const a = await alarmRow(c.params.id);
    const text = clip(c.body?.text, 1000);
    if (!text) throw new HttpError(400, 'text_required');
    const r = await db.run(`INSERT INTO alarm_comments (alarm_id, ts, author, kind, text) VALUES (?, ?, ?, 'comment', ?) RETURNING id`, a.alarm_id, now(), c.session.username, text);
    await audit(c, 'alarm_comment', a.alarm_id);
    return { ok: true, id: r.rows[0].id };
  });

  // ── maintenance mode (operator) — twin's mute button is this ─────────────
  async function addMaintenance(c, { device_id = null, site_id = null, minutes, starts_at, ends_at, reason }) {
    const t = now();
    const from = Number.isFinite(+starts_at) && starts_at ? +starts_at : t;
    const until = Number.isFinite(+ends_at) && ends_at ? +ends_at : from + Math.min(7 * 24 * 60, Math.max(1, parseInt(minutes, 10) || 60)) * 60e3;
    if (until <= from) throw new HttpError(400, 'invalid_window');
    if (until - from > 31 * 86400e3) throw new HttpError(400, 'window_too_long', 'at most 31 days');
    const r = await db.run('INSERT INTO maintenance (device_id, site_id, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      device_id, site_id, from, until, clip(reason, 200), c.session.username, t);
    await audit(c, 'maintenance_set', device_id || site_id || 'node', { from, until, reason: clip(reason, 200) });
    return { id: r.rows[0].id, starts_at: from, ends_at: until };
  }
  R('POST', '/v1/fms/devices/:id/mute', 'operator', async (c) => {
    const d = await devRow(c.params.id);
    if (!d) throw new HttpError(404, 'not_found');
    const w = await addMaintenance(c, { device_id: d.device_id, minutes: c.body?.minutes, reason: c.body?.reason });
    return { ok: true, id: d.id, muted_until: w.ends_at, maintenance_id: w.id };
  });
  R('POST', '/v1/fms/devices/:id/unmute', 'operator', async (c) => {
    const d = await devRow(c.params.id);
    if (!d) throw new HttpError(404, 'not_found');
    const t = now();
    await db.run('UPDATE maintenance SET ends_at = ? WHERE device_id = ? AND ends_at > ?', t, d.device_id, t);
    await audit(c, 'maintenance_end', d.device_id);
    return { ok: true, id: d.id, muted_until: null };
  });
  R('GET', '/v1/console/maintenance', 'viewer', async () => ({ ok: true, windows: await db.all('SELECT * FROM maintenance WHERE ends_at > ? ORDER BY starts_at, id', now()) }));
  R('POST', '/v1/console/maintenance', 'operator', async (c) => {
    const b = c.body || {};
    const site = b.site_id ? await settings.resolveSite(b.site_id) : null;
    if (b.site_id && !site) throw new HttpError(400, 'unknown_site');
    const dev = b.device ? await devRow(b.device) : null;
    if (b.device && !dev) throw new HttpError(400, 'unknown_device');
    return { ok: true, ...await addMaintenance(c, { device_id: dev?.device_id || null, site_id: site, minutes: b.minutes, starts_at: b.starts_at, ends_at: b.ends_at, reason: b.reason }) };
  });
  R('DELETE', '/v1/console/maintenance/:id', 'operator', async (c) => {
    const id = intId(c.params.id);
    const t = now();
    const r = await db.run('UPDATE maintenance SET ends_at = ? WHERE id = ? AND ends_at > ?', t, id, t);
    if (!r.changes) throw new HttpError(404, 'not_found');
    await audit(c, 'maintenance_end', `window:${id}`);
    return { ok: true };
  });

  // ── settings (admin) ─────────────────────────────────────────────────────
  R('GET', '/v1/console/sites', 'viewer', async () => ({ ok: true, sites: await settings.listSites() }));
  R('PUT', '/v1/console/sites/:id', 'admin', async (c) => { const s = await settings.putSite(c.params.id, c.body || {}); await audit(c, 'site_put', s.id, s); return { ok: true, site: s }; });

  R('GET', '/v1/console/devices', 'viewer', async () => ({ ok: true, devices: await db.all('SELECT * FROM devices ORDER BY site_id, label') }));
  R('POST', '/v1/console/devices', 'admin', async (c) => {
    const r = await settings.saveDevice(c.body || {});
    await audit(c, 'device_create', r.device.device_id, { label: r.device.label, warnings: r.warnings.map(w => w.code) });
    return { status: 201, body: { ok: true, ...r } };
  });
  R('PUT', '/v1/console/devices/:id', 'admin', async (c) => {
    const r = await settings.saveDevice(c.body || {}, { id: intId(c.params.id) });
    await audit(c, 'device_update', r.device.device_id, { label: r.device.label, warnings: r.warnings.map(w => w.code) });
    return { ok: true, ...r };
  });
  R('DELETE', '/v1/console/devices/:id', 'admin', async (c) => { const id = intId(c.params.id); await settings.deleteDevice(id); await audit(c, 'device_delete', id); return { ok: true }; });
  R('POST', '/v1/console/import', 'admin', async (c) => {
    const r = await settings.importCsv(c.raw.toString('utf8'), { dryRun: c.query.dry_run === '1', by: c.session.username });
    await audit(c, r.dry_run ? 'import_dry_run' : 'import', null, { created: r.created, updated: r.updated, failed: r.failed });
    return r;
  });

  R('GET', '/v1/console/credentials', 'admin', async () => ({ ok: true, credentials: await settings.listCredentials() }));
  R('PUT', '/v1/console/credentials', 'admin', async (c) => {
    await settings.putCredential(c.body || {}, c.session.username);
    await audit(c, 'credential_put', c.body?.device_id || c.body?.site_id, { version: c.body?.version });   // never the secret
    return { ok: true, credentials: await settings.listCredentials() };
  });

  R('GET', '/v1/console/thresholds', 'viewer', async () => ({ ok: true, thresholds: await settings.getThresholds() }));
  R('PUT', '/v1/console/thresholds', 'admin', async (c) => { const t = await settings.putThresholds(c.body || {}, c.session.username); await audit(c, 'thresholds_put', null, c.body); return { ok: true, thresholds: t }; });

  R('GET', '/v1/console/notify', 'admin', async () => ({ ok: true, notify: await settings.getNotify() }));
  R('PUT', '/v1/console/notify', 'admin', async (c) => {
    const n = await settings.putNotify(c.body || {}, c.session.username);
    await audit(c, 'notify_put', null, { keys: Object.keys(c.body || {}) });
    return { ok: true, notify: n };
  });
  // SOW acceptance: the "test ticket" button. Same channels and code path as
  // the alarm notifications (notify.js → probe-agent local-notify testTicket).
  R('POST', '/v1/console/notify/test-ticket', 'admin', async (c) => {
    const r = await notify.testTicket({ resolve: c.body?.resolve !== false });
    await audit(c, 'test_ticket', r.number || null, { ok: r.ok, step: r.step || null });
    return { ok: !!r.ok, ...r };
  });

  R('GET', '/v1/console/users', 'admin', async () => ({ ok: true, users: await settings.listUsers() }));
  R('POST', '/v1/console/users', 'admin', async (c) => {
    const u = await settings.createUser(c.body || {});
    await audit(c, 'user_create', u.username, { role: u.role });
    return { status: 201, body: { ok: true, user: u } };
  });
  R('PUT', '/v1/console/users/:id', 'admin', async (c) => {
    const id = intId(c.params.id);
    const u = await settings.updateUser(id, c.body || {});
    if (c.body?.unlock) await lockout.clear(u.username);
    await audit(c, 'user_update', u.username, { role: c.body?.role, disabled: c.body?.disabled, password_reset: c.body?.password != null, unlock: !!c.body?.unlock });
    return { ok: true, user: u };
  });

  R('POST', '/v1/console/collectors/:node/key', 'admin', async (c) => {
    const k = await settings.issueCollectorKey(c.params.node);
    await audit(c, 'collector_key_issued', k.node_id);
    return { ok: true, ...k, note: 'shown once; store it in the collector as a 0600 file' };
  });
  R('GET', '/v1/console/status', 'viewer', async () => {
    let redisOk = false;
    try { redisOk = (await redis.ping()) === 'PONG'; } catch { /* reported */ }
    const collectors = await settings.listCollectors();
    return {
      ok: true, node: config.nodeId, redis: redisOk, secret_key: sealer.available,
      collectors: collectors.map(c => ({ ...c, stale: !c.last_seen || now() - c.last_seen > 5 * 60e3 })),
      // The Portal link as the collectors last reported it (their forwarder owns that connection).
      portal: collectors.map(c => ({ node_id: c.node_id, ...(c.heartbeat?.portal || {}) })),
    };
  });
  R('GET', '/v1/console/audit', 'admin', async (c) => ({
    ok: true,
    entries: await db.all('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?',
      parseInt(c.query.before, 10) || Number.MAX_SAFE_INTEGER, Math.min(500, parseInt(c.query.limit, 10) || 100)),
  }));

  // ── collector (key auth) ─────────────────────────────────────────────────
  R('POST', '/collector/v1/heartbeat', 'collector', (c) => ingest.heartbeat(c.collector.node_id, c.body));
  R('POST', '/collector/v1/telemetry', 'collector', (c) => ingest.telemetry(c.body));
  // Alarm events: stored, then notified here (Q-2026-10-25-10 (A)). The answer
  // carries event_id → local_notified, which the Collector puts in the event
  // it sends the Portal. A replayed event gets what was delivered the first
  // time; nobody is told twice.
  R('POST', '/collector/v1/events', 'collector', async (c) => {
    const r = await ingest.events(c.body);
    const sent = await notify.forEvents(r.fresh, { replay: c.req.headers['x-cflex-replay'] === '1' });
    const localNotified = {};
    for (const [id, ln] of Object.entries(r.prior)) if (ln) localNotified[id] = ln;
    for (const ev of r.fresh) {
      const ln = sent[ev.event_id];
      if (!ln) continue;
      await ingest.recordNotified(ev, ln, { announces: announces(ev) });
      localNotified[ev.event_id] = ln;
    }
    return { accepted: r.accepted, duplicate: r.duplicate, local_notified: localNotified };
  });
  R('GET', '/collector/v1/devices', 'collector', async () => ({ ok: true, devices: await settings.collectorDevices() }));
  // No notification channels in here: the Collector does not notify, so the
  // SMTP / Teams / ServiceNow secrets never leave the console.
  R('GET', '/collector/v1/config', 'collector', async () => {
    const t = now();
    const devs = new Map((await db.all('SELECT device_id, id FROM devices')).map(d => [d.device_id, d.id]));
    return {
      ok: true, thresholds: await settings.getThresholds(),
      // In the shape probe-agent's alarm engine takes (setMaintenance).
      maintenance: (await db.all('SELECT * FROM maintenance WHERE ends_at > ? ORDER BY id', t)).map(w => ({
        device_id: w.device_id, ledger_id: w.device_id ? devs.get(w.device_id) ?? null : null, site_id: w.site_id,
        from: new Date(w.starts_at).toISOString(), until: new Date(w.ends_at).toISOString(), reason: w.reason,
      })),
    };
  });

  R('GET', '/healthz', null, async () => {
    let redisOk = false;
    try { redisOk = (await redis.ping()) === 'PONG'; } catch { /* below */ }
    await db.one('SELECT 1');
    return { status: redisOk ? 200 : 503, body: { ok: redisOk, node: config.nodeId, redis: redisOk } };
  });

  // ── dispatch ─────────────────────────────────────────────────────────────
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    const c = {
      req, res, query: Object.fromEntries(url.searchParams), params: {}, body: null, raw: null,
      ip: config.trustProxy ? (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress) : req.socket.remoteAddress,
    };
    try {
      const hit = router.match(req.method, pathname);
      if (!hit) return serveStatic(req, res, pathname);
      if (hit.methodNotAllowed) throw new HttpError(405, 'method_not_allowed');
      const { route, params } = hit;
      c.params = params;
      const role = route.opts.role;

      if (role === 'collector') {
        const key = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
        c.collector = await ingest.authCollector(req.headers['x-cflex-node'], key);
        if (!c.collector) throw new HttpError(401, 'unauthorized');
      } else if (role) {
        c.token = parseCookies(req.headers.cookie)[COOKIE] || /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || null;
        c.session = c.token ? await sessions.get(c.token) : null;
        if (!c.session) throw new HttpError(401, 'unauthorized');
        // Role changes and disabling take effect at once, not at the next login.
        const u = await db.one('SELECT role, disabled, must_change FROM users WHERE id = ?', c.session.uid);
        if (!u || u.disabled) { await sessions.destroy(c.token); throw new HttpError(401, 'unauthorized'); }
        c.session.role = u.role;
        const exempt = pathname === '/v1/me' || pathname.startsWith('/v1/auth/');
        if (u.must_change && !exempt) throw new HttpError(403, 'password_change_required');
        if (role !== 'any' && !auth.can(u.role, role)) throw new HttpError(403, 'forbidden', `requires ${role}`);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Cross-site forms can only send urlencoded, multipart or text/plain;
        // insisting on JSON (or CSV for the import) closes CSRF alongside SameSite=Strict.
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const raw = await readBody(req);
        if (raw.length) {
          if (ct === 'application/json') {
            try { c.body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
          } else if (ct === 'text/csv' && pathname === '/v1/console/import') {
            c.raw = raw;
          } else throw new HttpError(415, 'unsupported_media_type');
        } else if (ct && ct !== 'application/json' && role !== 'collector' && role !== null) {
          throw new HttpError(415, 'unsupported_media_type');
        }
        c.raw = c.raw || raw;
      }

      const out = await route.handler(c);
      if (out && typeof out === 'object' && 'status' in out && 'body' in out) return send(res, out.status, out.body, out.headers);
      return send(res, 200, out);
    } catch (e) {
      const status = e.status || (e instanceof HttpError ? e.status : 500);
      if (status >= 500) log.error(`[console] ${req.method} ${pathname}: ${e.stack || e.message}`);
      const body = { ok: false, error: e.code || (status >= 500 ? 'internal_error' : 'error') };
      if (status < 500 && e.message && e.message !== e.code) body.message = e.message;
      if (e.extra) body.details = e.extra;
      // Redis down: the console cannot authenticate anyone; say so plainly.
      if (e.redisDown) return send(res, 503, { ok: false, error: 'session_store_unavailable' });
      return send(res, status, body);
    }
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 404, { ok: false, error: 'not_found' });
    if (pathname === '/' ) { res.writeHead(302, { Location: '/twin/' }); return res.end(); }
    if (pathname === '/login' || pathname === '/settings') return serveFile(res, config.publicDir, `${pathname}.html`) || send(res, 404, { ok: false, error: 'not_found' });
    if (pathname.startsWith('/static/')) return serveFile(res, config.publicDir, pathname.slice('/static/'.length)) || send(res, 404, { ok: false, error: 'not_found' });
    if (pathname === '/twin' ) { res.writeHead(301, { Location: '/twin/' }); return res.end(); }
    if (pathname.startsWith('/twin/')) {
      // The UI shell is public (it holds no data); every /v1 call it makes is authenticated.
      return serveFile(res, config.twinDir, pathname.slice('/twin/'.length), { fallback: 'index.html' })
        || send(res, 503, { ok: false, error: 'ui_not_built', message: 'build apps/twin with: npm run build:console' });
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  return { server, router, sessions, settings, views, ingest, notify };
}

const clip = (v, n) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));

async function main() {
  const config = require('./config').load();
  const partitionOpts = { ...config.retention, aheadMonths: config.partitions.aheadMonths };
  // Migrations (advisory lock: once, whichever node is first) and this month's partitions.
  const db = await require('./db').open(config.db, { partitionOpts, log: console });
  // Month partitions ahead, retention behind: both nodes run the timer, the lock holder does the round.
  const partitions = require('./partitions').schedule(db, { ...partitionOpts, intervalMs: config.partitions.intervalH * 3600e3 }, console);
  const redis = require('./redis').createRedis(config.redisUrl, { password: config.redisPassword });
  const { server } = createApp({ config, db, redis });
  server.listen(config.port, config.bind, () => console.log(`[console] ${config.nodeId} listening on ${config.bind}:${config.port}`));
  const stop = (sig) => {
    console.log(`[console] ${sig}, closing`);
    partitions.stop();
    server.close(() => { redis.close(); db.close().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) main().catch((e) => { console.error(`[console] start failed: ${e.code ? `${e.code}: ` : ''}${e.message}`); process.exit(1); });

module.exports = { createApp, COOKIE };
