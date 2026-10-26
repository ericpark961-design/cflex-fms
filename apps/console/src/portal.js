// portal.js — the FMS's link to the Portal, contract IFC-CFLEX-2026-1023 v1.2
// (D-13: collectors N → FMS → Portal; WO-INT-012). Moved here from the
// Collector's forwarder.js, rules unchanged:
//
//   POST /api/v1/heartbeat   every 60 s, direct (a stale heartbeat is noise) —
//                            this node's own (role app), and one per collector
//                            that reported in the last 5 minutes (role collector,
//                            collector_id) so the Portal still sees each collector
//   PUT  /api/v1/inventory   on change + daily full, from the devices table
//   POST /api/v1/telemetry   what each collector posted (≤ 500 points), as it came
//   POST /api/v1/events      what each collector posted, merged by device_id
//                            (ingest.js), immediately
//
// node_id is this app node (X-CFlex-Node, certificate CN tenant.app01);
// collector_id says which collector took the reading or raised the event.
//
// Everything but the heartbeat goes through portal_outbox first (PostgreSQL,
// the 7-day buffer of contract §1), in order, with its Idempotency-Key fixed
// at enqueue time. Both app nodes enqueue — a collector posts to either — but
// only the node holding the sender lock (a session advisory lock on a
// connection of its own) drains it, syncs the inventory and relays the
// collector heartbeats. If that node or its connection dies, the lock goes
// with it and the other node takes over on its next tick.
//
// Retry (§1): 5xx / network → exponential 1 s … 5 min, ±20 % jitter, queue
// halts behind the failed item. 429 → wait Retry-After. 409 → retry. Other
// 4xx → drop it (retrying cannot fix it) and count.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { LOCK_NS, LOCKS } = require('./db');
const transport = require('../../../probe-agent/src/net/transport');
const schema = require('../../../probe-agent/src/contract/schema');
const adapt = require('../../../probe-agent/src/contract/adapt');

// Contract minor this FMS speaks (v1.2, collector_id); the Portal also accepts 1.1 and 1.0.
const API_VERSION = '1.2';
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const CLOCK_DRIFT_MS = 60 * 1000;
const COLLECTOR_FRESH_MS = 5 * 60 * 1000;
// Events wait this long for the console's notifier to say what it delivered
// (local_notified); released at once when it answers, sent without it if not.
const NOTIFY_HOLD_MS = 30 * 1000;

const PATHS = {
  heartbeat: '/api/v1/heartbeat',
  inventory: '/api/v1/inventory',
  telemetry: '/api/v1/telemetry',
  events: '/api/v1/events',
};

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function osName() {
  try { return fs.readFileSync('/etc/redhat-release', 'utf8').replace(/release /, '').replace(/\s*\(.*\)\s*$/, '').trim().slice(0, 64); }
  catch { return `${os.type()} ${os.release()}`.slice(0, 64); }
}

function retryAfterMs(h, now) {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const ratio = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * @param {object} o
 * @param {object} o.db        db.js handle
 * @param {object} o.config    config.js load(): nodeId, tenant, defaultSite, portal {…}
 * @param {Function} [o.request]  transport.request, injectable
 * @param {Function} [o.now]
 * @param {Function} [o.random]   0..1, for jitter
 * @param {object} [o.log]
 * @param {string} [o.version]
 */
function createPortalLink({ db, config, request = transport.request, now = Date.now, random = Math.random, log = console, version = '0.0.0' }) {
  const p = config.portal || {};
  const enabled = !!p.enabled;
  const nodeId = String(p.nodeId || config.nodeId || '').toLowerCase();
  const tenant = config.tenant;
  const ctx = { tenant, siteId: config.defaultSite };
  let tls = null;
  const tlsOf = () => (tls = tls || transport.loadTls(p.tls || {}));

  let attempts = 0;
  let nextAt = 0;
  let throttled = false;          // the last wait came from a 429, not an outage
  let flushing = null;
  let lastReachable = null;
  let commandsPending = 0;
  let drift = null;               // { alarm_id } while the clock is off
  let leader = null;              // the connection holding the sender lock
  const stats = { sent: 0, rejected: 0, retried: 0, invalid: 0, blocked_keys: 0, relayed: 0, last_error: null };

  if (enabled && !NODE_ID.test(nodeId)) {
    throw new Error(`CONSOLE_NODE_ID / CFLEX_NODE_ID must be a contract node id (app01): got ${JSON.stringify(nodeId)}`);
  }

  const headers = (key, len) => ({
    'Content-Type': 'application/json',
    'Content-Length': String(len),
    'X-CFlex-Tenant': tenant,
    'X-CFlex-Node': nodeId,
    'X-CFlex-API-Version': API_VERSION,
    'Idempotency-Key': key,
    'User-Agent': `cflex-app/${version}`,
  });

  /** Whitelist (§5) then validate (§7). Returns the body to send, or null. */
  function prepare(name, payload) {
    const { value, blocked } = schema.prune(name, payload);
    if (blocked.length) {
      stats.blocked_keys += blocked.length;
      log.warn(`[portal] ${name}: ${blocked.length} key(s) not in contract, dropped: ${blocked.slice(0, 5).join(', ')}`);
    }
    const v = schema.validate(name, value);
    if (!v.ok) {
      stats.invalid++;
      log.error(`[portal] ${name}: payload fails contract schema, not sent: ${v.errors.slice(0, 5).join('; ')}`);
      return null;
    }
    return value;
  }

  async function enqueue(t, name, method, body, { notBefore = 0 } = {}) {
    const r = await t.run('INSERT INTO portal_outbox (ts, name, method, idem_key, body, not_before) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      now(), name, method, crypto.randomUUID(), JSON.stringify(body), notBefore);
    return r.rows[0].id;
  }

  async function call(method, path, body, key) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return request({
      method, url: p.url.replace(/\/+$/, '') + path, headers: headers(key, buf.length), body: buf,
      tls: tlsOf(), proxy: p.proxy, noProxy: p.noProxy, timeoutMs: p.timeoutMs || 15000,
    });
  }

  function backoff(ms) {
    attempts++;
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    nextAt = now() + (ms ?? Math.round(base * (0.8 + 0.4 * random())));
    return nextAt;
  }

  /** What to do with a response: 'ok' | 'retry' | 'drop'. */
  function verdict(res) {
    if (res.status >= 200 && res.status < 300) return 'ok';
    if (res.status === 429 || res.status === 409 || res.status >= 500) return 'retry';
    return 'drop';
  }

  // ── the sender lock ──────────────────────────────────────────────────────
  /** True while this node holds the sender lock; tries to take it when free. */
  async function lead() {
    if (leader) return true;
    let client;
    try {
      client = await db.pool.connect();
      const r = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_NS, LOCKS.portal]);
      if (!r.rows[0].ok) { client.release(); return false; }
    } catch (e) {
      client?.release(true);
      stats.last_error = `sender lock: ${e.message}`;
      return false;
    }
    leader = client;
    // A broken connection loses the lock in PostgreSQL too: let it go here and try again next tick.
    client.on('error', (e) => { log.warn(`[portal] sender lock connection lost: ${e.message}`); if (leader === client) { leader = null; client.release(true); } });
    log.log(`[portal] ${nodeId} holds the sender lock — this node sends to ${p.url}`);
    return true;
  }

  async function resign() {
    const c = leader;
    leader = null;
    if (!c) return;
    try { await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NS, LOCKS.portal]); } catch { /* connection gone: lock gone too */ }
    c.release();
  }

  // ── the outbox ───────────────────────────────────────────────────────────
  async function flushOnce() {
    if (now() < nextAt) return { sent: 0, waiting_ms: nextAt - now() };
    let sent = 0;
    for (;;) {
      const rows = await db.all('SELECT id, name, method, idem_key, body, not_before FROM portal_outbox ORDER BY id LIMIT 50');
      if (!rows.length) break;
      for (const row of rows) {
        // An event still waiting for local_notified holds the line: order is part of the contract.
        if (row.not_before > now()) return { sent, held: row.id };
        let res;
        try {
          res = await call(row.method, PATHS[row.name], row.body, row.idem_key);
        } catch (e) {
          stats.retried++; stats.last_error = e.message;
          await db.run('UPDATE portal_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', String(e.message).slice(0, 500), row.id);
          backoff();
          return { sent, error: e.message };
        }
        const v = verdict(res);
        if (v === 'ok') {
          await db.run('DELETE FROM portal_outbox WHERE id = ?', row.id);
          sent++; stats.sent++;
          attempts = 0; nextAt = 0; throttled = false; lastReachable = now();
          continue;
        }
        const why = `${row.name} → HTTP ${res.status}${res.json?.error?.code ? ` ${res.json.error.code}` : ''}`;
        stats.last_error = why;
        if (v === 'drop') {
          stats.rejected++;
          log.error(`[portal] ${why}; dropped (4xx is not retried)`);
          await db.run('DELETE FROM portal_outbox WHERE id = ?', row.id);
          continue;
        }
        stats.retried++;
        await db.run('UPDATE portal_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', why, row.id);
        throttled = res.status === 429;
        backoff(throttled ? retryAfterMs(res.headers['retry-after'], now()) ?? undefined : undefined);
        return { sent, error: why };
      }
    }
    return { sent };
  }

  /** Drain the outbox in order — on the node holding the sender lock. Concurrent callers share one pass. */
  function flush() {
    if (!enabled) return Promise.resolve({ sent: 0, disabled: true });
    if (!flushing) {
      flushing = (async () => ((await lead()) ? flushOnce() : { sent: 0, standby: true }))()
        .catch((e) => { stats.last_error = e.message; log.error(`[portal] flush: ${e.message}`); return { sent: 0, error: e.message }; })
        .finally(() => { flushing = null; });
    }
    return flushing;
  }

  // ── what the collectors posted (ingest.js, inside its transaction) ───────
  /** Telemetry points of known devices → one outbox row, each point marked with its collector. */
  async function queueTelemetry(t, points, collectorId) {
    if (!enabled || !points.length) return null;
    const body = prepare('telemetry', { node_id: nodeId, points: collectorId ? points.map(pt => ({ ...pt, collector_id: collectorId })) : points });
    return body ? enqueue(t, 'telemetry', 'POST', body) : null;
  }

  /**
   * Events (already merged: one alarm_id per alarm) → one outbox row, held
   * until release() puts what the console delivered in it.
   */
  async function queueEvents(t, events, collectorId, { hold = true } = {}) {
    if (!enabled || !events.length) return null;
    // The FMS's own node events (CLOCK_DRIFT) have no collector.
    const body = prepare('events', { events: events.map(e => (e.collector_id || collectorId ? { ...e, collector_id: e.collector_id || collectorId } : e)) });
    return body ? enqueue(t, 'events', 'POST', body, { notBefore: hold ? now() + NOTIFY_HOLD_MS : 0 }) : null;
  }

  /** The held events row, with local_notified per event_id where the console delivered something. */
  async function releaseEvents(id, localNotified = {}) {
    if (id == null) return;
    const row = await db.one('SELECT body FROM portal_outbox WHERE id = ?', id);
    if (!row) return;                                  // sent already, after the hold ran out
    const body = JSON.parse(row.body);
    for (const e of body.events) if (localNotified[e.event_id] && !e.local_notified) e.local_notified = localNotified[e.event_id];
    const v = prepare('events', body);
    await db.run('UPDATE portal_outbox SET body = ?, not_before = 0 WHERE id = ?', JSON.stringify(v || JSON.parse(row.body)), id);
  }

  async function postEvents(events) {
    if (!enabled || !events.length) return null;
    const id = await queueEvents(db, events, null, { hold: false });
    await flush();
    return id;
  }

  // ── inventory ────────────────────────────────────────────────────────────
  /** The devices table as the contract inventory; PUT when it changed or a day has passed (§3.2). */
  async function syncInventory() {
    if (!enabled || !(await lead())) return { queued: false };
    const rows = await db.all('SELECT * FROM devices ORDER BY site_id, label, id');
    // Same entries the Collector used to build from the same rows (adapt.inventoryDevice).
    const entries = rows.map(r => ({
      ...adapt.inventoryDevice({ id: r.id, name: r.label, vendor: r.vendor, model: r.model, serial: r.serial, ip: r.nmc_ip, kind: 'ups', site_id: r.site_id }, ctx),
      device_id: r.device_id,
    }));
    const replaced = await db.all('SELECT * FROM device_replaced WHERE sent_at IS NULL ORDER BY created_at');
    for (const x of replaced) entries.push({ device_id: x.device_id, site_id: x.site_id, replaced_by: x.replaced_by });
    if (!entries.length) return { queued: false, empty: true };
    const sig = crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex');
    const last = json((await db.one(`SELECT value FROM settings WHERE key = 'portal.inventory'`))?.value) || {};
    if (sig === last.sig && now() - (last.at || 0) < 24 * 3600 * 1000) return { queued: false, unchanged: true };
    const body = prepare('inventory', { full: true, devices: entries });
    if (!body) return { queued: false, invalid: true };
    await db.tx(async (t) => {
      await enqueue(t, 'inventory', 'PUT', body);
      for (const x of replaced) await t.run('UPDATE device_replaced SET sent_at = ? WHERE device_id = ?', now(), x.device_id);
      await t.run(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('portal.inventory', ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      JSON.stringify({ sig, at: now() }), nodeId, now());
    });
    await flush();
    return { queued: true, devices: entries.length };
  }

  // ── heartbeat ────────────────────────────────────────────────────────────
  async function checkClock(dateHeader) {
    const t = Date.parse(dateHeader || '');
    if (!Number.isFinite(t)) return;
    // Date has one-second resolution; allow for it.
    const off = Math.abs(now() - t) - 1000;
    const base = { device_id: null, site_id: ctx.siteId, ts: adapt.iso(now()), severity: 'P4', code: 'CLOCK_DRIFT', source: 'system' };
    if (off > CLOCK_DRIFT_MS && !drift) {
      drift = { alarm_id: crypto.randomUUID() };
      log.warn(`[portal] clock differs from Portal by ${Math.round((now() - t) / 1000)} s`);
      await postEvents([{ ...base, event_id: crypto.randomUUID(), alarm_id: drift.alarm_id, kind: 'alarm_raise',
        title: 'FMS clock drift > 60 s', detail: { drift_s: Math.round((now() - t) / 1000), node_id: nodeId } }]);
    } else if (off <= CLOCK_DRIFT_MS && drift) {
      const a = drift; drift = null;
      await postEvents([{ ...base, event_id: crypto.randomUUID(), alarm_id: a.alarm_id, kind: 'alarm_clear',
        title: 'FMS clock back within 60 s', detail: { node_id: nodeId } }]);
    }
  }

  /** One heartbeat per collector heard from in the last 5 minutes, in its own words (ingest.js keeps them). */
  async function relayCollectors() {
    const cs = await db.all('SELECT node_id, last_seen, heartbeat FROM collectors WHERE last_seen > ? ORDER BY node_id', now() - COLLECTOR_FRESH_MS);
    let n = 0;
    for (const c of cs) {
      const hb = json(c.heartbeat) || {};
      const body = prepare('heartbeat', {
        node_id: nodeId, role: 'collector', collector_id: c.node_id,
        version: String(hb.version || '0.0.0').slice(0, 32), uptime_s: int(hb.uptime_s), queue_depth: int(hb.queue_depth),
        ...(hb.last_poll_ok_ratio !== undefined ? { last_poll_ok_ratio: ratio(hb.last_poll_ok_ratio) } : {}),
        ...(Number.isFinite(hb.devices_total) ? { devices_total: int(hb.devices_total) } : {}),
        ...(Number.isFinite(hb.devices_unreachable) ? { devices_unreachable: int(hb.devices_unreachable) } : {}),
        clock: ISO.test(hb.clock || '') ? hb.clock : adapt.iso(c.last_seen),
        ...(hb.profile === 'container' || hb.profile === 'bare' ? { profile: hb.profile } : {}),
        ...(hb.os ? { os: String(hb.os).slice(0, 64) } : {}),
      });
      if (!body) continue;
      try {
        const r = await call('POST', PATHS.heartbeat, body, crypto.randomUUID());
        if (r.status < 300) { n++; stats.relayed++; }
      } catch (e) { stats.last_error = e.message; break; }
    }
    return n;
  }

  /** This node's heartbeat; on the sender, the collectors' too, and the outbox goes after it. */
  async function heartbeat() {
    if (!enabled) return { ok: false, disabled: true };
    const queued = (await db.one('SELECT COUNT(*) AS n FROM portal_outbox')).n;
    const devices = (await db.one('SELECT COUNT(*) AS n FROM devices')).n;
    const body = prepare('heartbeat', {
      node_id: nodeId, role: 'app', version, uptime_s: Math.round(process.uptime()), queue_depth: queued,
      devices_total: devices, clock: adapt.iso(now()), profile: p.profile === 'container' ? 'container' : 'bare', os: osName(),
    });
    if (!body) return { ok: false, error: 'invalid heartbeat' };
    let out;
    try {
      const r = await call('POST', PATHS.heartbeat, body, crypto.randomUUID());
      if (r.status >= 300) {
        stats.last_error = `heartbeat → HTTP ${r.status}`;
        out = { ok: false, status: r.status };
      } else {
        lastReachable = now();
        commandsPending = r.json?.commands_pending || 0;
        await checkClock(r.headers.date);
        // The link is up: whatever was waiting out an outage can go now. A 429
        // wait stands — the Portal asked for it.
        if (!throttled) { attempts = 0; nextAt = 0; }
        out = { ok: true, data: r.json };
        if (await lead()) out.collectors = await relayCollectors();
        await flush();
      }
    } catch (e) {
      stats.last_error = e.message;
      out = { ok: false, error: e.message };
    }
    await saveStatus();
    return out;
  }

  async function purge() {
    const cutoff = now() - (p.bufferDays || 7) * 86400e3;
    const r = await db.run('DELETE FROM portal_outbox WHERE ts < ?', cutoff);
    if (r.changes) log.warn(`[portal] purged ${r.changes} undelivered item(s) older than ${p.bufferDays || 7} days`);
    return r.changes;
  }

  function status() {
    return { node_id: nodeId, enabled, sender: !!leader, url: enabled ? p.url : null, last_reachable: lastReachable, last_error: stats.last_error,
      sent: stats.sent, rejected: stats.rejected, relayed: stats.relayed, commands_pending: commandsPending, next_attempt_at: nextAt || null };
  }

  /** Each node's view of the link, for Settings → status on either node. */
  async function saveStatus() {
    try {
      await db.run(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      `portal.link.${nodeId}`, JSON.stringify(status()), nodeId, now());
    } catch (e) { log.warn(`[portal] status not saved: ${e.message}`); }
  }

  /** Every node's last saved view, plus the queue — /v1/console/status. */
  async function links() {
    const queued = (await db.one('SELECT COUNT(*) AS n FROM portal_outbox')).n;
    const rows = await db.all(`SELECT value FROM settings WHERE key LIKE 'portal.link.%' ORDER BY key`);
    return rows.map(r => ({ ...json(r.value), queued }));
  }

  /** The timers (server.js main). Returns stop(). */
  function start({ heartbeatMs = p.heartbeatMs || 60000, flushMs = p.flushMs || 5000, inventoryMs = p.inventoryMs || 5 * 60000 } = {}) {
    if (!enabled) { log.log('[portal] Portal link off (CFLEX_PORTAL_ENABLED=0)'); return { stop: async () => {} }; }
    const swallow = (what) => (e) => log.error(`[portal] ${what}: ${e.message}`);
    const timers = [
      setInterval(() => heartbeat().catch(swallow('heartbeat')), heartbeatMs),
      setInterval(() => flush(), flushMs),
      setInterval(() => syncInventory().catch(swallow('inventory')), inventoryMs),
      setInterval(() => purge().catch(swallow('purge')), 24 * 3600e3),
    ];
    for (const t of timers) t.unref?.();
    syncInventory().catch(swallow('inventory')).finally(() => heartbeat().catch(swallow('heartbeat')));
    return { stop: async () => { for (const t of timers) clearInterval(t); await resign(); } };
  }

  return {
    enabled, nodeId, queueTelemetry, queueEvents, releaseEvents, postEvents, syncInventory, heartbeat, flush, purge,
    status, links, start, resign, isSender: () => !!leader,
    stats: () => ({ ...stats, commands_pending: commandsPending, next_attempt_at: nextAt || null }),
  };
}

const json = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

module.exports = { createPortalLink, API_VERSION, PATHS };
