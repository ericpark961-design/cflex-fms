// forwarder.js — outbound to the Portal per contract IFC-CFLEX-2026-1023 v1.0.
//
//   POST /api/v1/heartbeat   every 60 s, direct (a stale heartbeat is noise)
//   PUT  /api/v1/inventory   on change + daily full
//   POST /api/v1/telemetry   batched: every 60 s or 500 points
//   POST /api/v1/events      immediately
//
// Everything except the heartbeat goes through the local queue first, in
// order, with its Idempotency-Key fixed at enqueue time — so a retry after a
// lost response is the same request, and the Portal answers it from its
// 24-hour cache instead of storing it twice.
//
// Retry (§1): 5xx / network → exponential 1 s … 5 min, ±20 % jitter, queue
// halts behind the failed item. 429 → wait Retry-After. 409 → retry. Other
// 4xx → drop it (retrying cannot fix it) and count.
//
// The old cloud path (/v1/probe/event, X-Probe-Key) survives behind
// CFLEX_LEGACY_FORWARD=1, off by default.
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const transport = require('./portal/transport');
const schema = require('./contract/schema');
const adapt = require('./contract/adapt');

const MAX_POINTS = 500;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const CLOCK_DRIFT_MS = 60 * 1000;

const PATHS = {
  heartbeat: '/api/v1/heartbeat',
  inventory: '/api/v1/inventory',
  telemetry: '/api/v1/telemetry',
  events: '/api/v1/events',
};

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

/**
 * @param {object} o
 * @param {object} o.portal   { enabled, url, tenant, nodeId, role, siteId, profile, tls, proxy, noProxy, timeoutMs }
 * @param {object} o.queue    { enqueue(kind,payload), dequeue(n), ack(ids), fail(id,err), stats() }
 * @param {object} [o.legacy] { enabled, url, token, probeId, tenantId }
 * @param {Function} [o.request]  transport.request, injectable
 * @param {Function} [o.now]
 * @param {Function} [o.random]   0..1, for jitter
 * @param {object} [o.log]
 * @param {string} [o.version]
 */
function createForwarder(o) {
  const portal = o.portal;
  const queue = o.queue;
  const legacy = o.legacy || { enabled: false };
  const request = o.request || transport.request;
  const now = o.now || Date.now;
  const random = o.random || Math.random;
  const log = o.log || console;
  const version = o.version || '0.0.0';
  const ctx = { tenant: portal.tenant, siteId: portal.siteId };
  const book = new adapt.AlarmBook();

  let points = [];
  let attempts = 0;
  let nextAt = 0;
  let throttled = false;          // the last wait came from a 429, not an outage
  let flushing = null;
  let lastReachable = null;
  let commandsPending = 0;
  let drift = null;               // { alarm_id } while the clock is off
  const stats = { sent: 0, rejected: 0, retried: 0, invalid: 0, blocked_keys: 0, unmapped_alerts: 0, last_error: null };

  const headers = (key, len) => ({
    'Content-Type': 'application/json',
    'Content-Length': String(len),
    'X-CFlex-Tenant': portal.tenant,
    'X-CFlex-Node': portal.nodeId,
    'Idempotency-Key': key,
    'User-Agent': `cflex-probe/${version}`,
  });

  /** Whitelist (§5) then validate (§7). Returns the body to send, or null. */
  function prepare(name, payload) {
    const { value, blocked } = schema.prune(name, payload);
    if (blocked.length) {
      stats.blocked_keys += blocked.length;
      log.warn(`[forwarder] ${name}: ${blocked.length} key(s) not in contract, dropped: ${blocked.slice(0, 5).join(', ')}`);
    }
    const v = schema.validate(name, value);
    if (!v.ok) {
      stats.invalid++;
      log.error(`[forwarder] ${name}: payload fails contract schema, not sent: ${v.errors.slice(0, 5).join('; ')}`);
      return null;
    }
    return value;
  }

  function enqueuePortal(name, method, body) {
    queue.enqueue('portal', { name, method, path: PATHS[name], key: crypto.randomUUID(), body });
  }

  async function call(method, path, body, key) {
    const buf = Buffer.from(JSON.stringify(body));
    return request({
      method, url: portal.url.replace(/\/+$/, '') + path, headers: headers(key, buf.length), body: buf,
      tls: portal.tls, proxy: portal.proxy, noProxy: portal.noProxy, timeoutMs: portal.timeoutMs,
    });
  }

  async function callLegacy(kind, payload, bufferedTs) {
    const body = Buffer.from(JSON.stringify({ kind, payload, ...(bufferedTs ? { buffered_ts: bufferedTs } : {}) }));
    return request({
      method: 'POST', url: legacy.url.replace(/\/+$/, '') + '/v1/probe/event', body,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': String(body.length),
        'X-Probe-Key': legacy.token, 'X-Probe-Id': legacy.probeId, 'X-Tenant-Id': legacy.tenantId,
      },
      // Same trust store and proxy as the Portal; the old cloud never asks
      // for a client certificate, so offering one changes nothing there.
      tls: portal.tls, proxy: portal.proxy, noProxy: portal.noProxy, timeoutMs: portal.timeoutMs,
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

  async function flushOnce() {
    if (now() < nextAt) return { sent: 0, waiting_ms: nextAt - now() };
    let sent = 0;
    for (;;) {
      const rows = queue.dequeue(50);
      if (!rows.length) break;
      for (const row of rows) {
        const item = JSON.parse(row.payload);
        // Rows written before this version are old-cloud events ({kind} in
        // the row, payload bare). They belong to the legacy path either way.
        const isPortal = row.kind === 'portal';
        let res;
        try {
          if (!isPortal) {
            if (!legacy.enabled) {
              stats.rejected++;
              log.warn(`[forwarder] discarding buffered old-cloud row ${row.id} (${row.kind}); CFLEX_LEGACY_FORWARD is off`);
              queue.ack([row.id]);
              continue;
            }
            res = row.kind === 'legacy'
              ? await callLegacy(item.kind, item.payload, row.ts)
              : await callLegacy(row.kind, item, row.ts);
          } else {
            res = await call(item.method, item.path, item.body, item.key);
          }
        } catch (e) {
          stats.retried++; stats.last_error = e.message;
          queue.fail(row.id, e.message);
          backoff();
          return { sent, error: e.message };
        }
        const v = verdict(res);
        if (v === 'ok') {
          queue.ack([row.id]); sent++; stats.sent++;
          attempts = 0; nextAt = 0; throttled = false; lastReachable = now();
          continue;
        }
        const why = `${isPortal ? item.name : 'legacy'} → HTTP ${res.status}${res.json?.error?.code ? ` ${res.json.error.code}` : ''}`;
        stats.last_error = why;
        if (v === 'drop') {
          stats.rejected++;
          log.error(`[forwarder] ${why}; dropped (4xx is not retried)`);
          queue.ack([row.id]);
          continue;
        }
        stats.retried++;
        queue.fail(row.id, why);
        throttled = res.status === 429;
        backoff(throttled ? retryAfterMs(res.headers['retry-after'], now()) ?? undefined : undefined);
        return { sent, error: why };
      }
    }
    return { sent };
  }

  /** Drain the queue in order. Concurrent callers share one pass. */
  function flush() {
    if (!portal.enabled && !legacy.enabled) return Promise.resolve({ sent: 0, disabled: true });
    if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
    return flushing;
  }

  function flushTelemetry() {
    while (points.length) {
      const batch = points.splice(0, MAX_POINTS);
      const body = prepare('telemetry', { node_id: portal.nodeId, points: batch });
      if (body) enqueuePortal('telemetry', 'POST', body);
    }
  }

  function addPoint(p) {
    points.push(p);
    if (points.length >= MAX_POINTS) flushTelemetry();
  }

  async function postEvents(events) {
    if (!events.length) return { queued: 0 };
    const body = prepare('events', { events });
    if (!body) return { queued: 0, invalid: true };
    enqueuePortal('events', 'POST', body);
    await flush();
    return { queued: events.length };
  }

  async function putInventory(devices, { full = true } = {}) {
    const body = prepare('inventory', { full, devices });
    if (!body) return { queued: false };
    enqueuePortal('inventory', 'PUT', body);
    await flush();
    return { queued: true };
  }

  // The ledger, by ledger id. The pollers' payloads carry only the ledger id;
  // the contract device_id needs serial and site, and telemetry, events and
  // inventory must all derive the same one.
  const ledger = new Map();
  let inventorySig = null;
  let inventoryAt = 0;

  /** Register the ledger; PUT the full inventory when it changed or a day has passed (§3.2). */
  async function syncInventory(list) {
    ledger.clear();
    for (const d of list) ledger.set(String(d.id), d);
    if (!portal.enabled) return { queued: false };
    const entries = list.map(d => adapt.inventoryDevice(d, ctx));
    const sig = crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex');
    if (sig === inventorySig && now() - inventoryAt < 24 * 3600 * 1000) return { queued: false, unchanged: true };
    const r = await putInventory(entries, { full: true });
    if (r.queued) { inventorySig = sig; inventoryAt = now(); }
    return r;
  }

  const deviceFor = (p) => ledger.get(String(p.device_id)) || { id: p.device_id, site_id: p.site_id, serial: p.serial };

  /**
   * The pollers' interface, unchanged: ('telemetry'|'metrics'|'alert', payload).
   * Translated to the contract here, so no poller had to change.
   */
  async function sendEvent(kind, payload) {
    if (legacy.enabled) queue.enqueue('legacy', { kind, payload });
    if (portal.enabled) {
      const device = deviceFor(payload);
      if (kind === 'telemetry') {
        addPoint(Array.isArray(payload.metrics)
          ? adapt.collectorPoint(device, payload, ctx)
          : adapt.upsPoint(device, payload, ctx));
        if (payload.ok !== false && payload.kind === 'ups') {
          const clears = book.onPoll(device, ctx, payload.ts);
          if (clears.length) await postEvents(clears);
        }
      } else if (kind === 'metrics') {
        addPoint(adapt.collectorPoint(device, payload, ctx));
      } else if (kind === 'alert') {
        const ev = book.fromAlert(device, payload, ctx);
        if (ev) await postEvents([ev]);
        else stats.unmapped_alerts++;
      }
    }
    if (legacy.enabled) await flush();
    return { ok: true, queued: true };
  }

  async function checkClock(dateHeader) {
    const t = Date.parse(dateHeader || '');
    if (!Number.isFinite(t)) return;
    // Date has one-second resolution; allow for it.
    const off = Math.abs(now() - t) - 1000;
    const base = { device_id: null, site_id: portal.siteId, ts: adapt.iso(now()), severity: 'P4', code: 'CLOCK_DRIFT', source: 'system' };
    if (off > CLOCK_DRIFT_MS && !drift) {
      drift = { alarm_id: crypto.randomUUID() };
      log.warn(`[forwarder] clock differs from Portal by ${Math.round((now() - t) / 1000)} s`);
      await postEvents([{ ...base, event_id: crypto.randomUUID(), alarm_id: drift.alarm_id, kind: 'alarm_raise',
        title: 'Probe clock drift > 60 s', detail: { drift_s: Math.round((now() - t) / 1000) } }]);
    } else if (off <= CLOCK_DRIFT_MS && drift) {
      const a = drift; drift = null;
      await postEvents([{ ...base, event_id: crypto.randomUUID(), alarm_id: a.alarm_id, kind: 'alarm_clear',
        title: 'Probe clock back within 60 s', detail: {} }]);
    }
  }

  /**
   * @param {object} s  { devices_total, devices_unreachable, last_poll_ok_ratio }
   */
  async function heartbeat(s = {}) {
    const results = {};
    if (legacy.enabled) {
      try {
        const body = { probe_id: legacy.probeId, tenant_id: legacy.tenantId, version, buffer_stats: queue.stats(), ts: now(), ...s };
        const buf = Buffer.from(JSON.stringify(body));
        const r = await request({
          method: 'POST', url: legacy.url.replace(/\/+$/, '') + '/v1/probe/heartbeat', body: buf,
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(buf.length), 'X-Probe-Key': legacy.token, 'X-Probe-Id': legacy.probeId, 'X-Tenant-Id': legacy.tenantId },
          tls: portal.tls, proxy: portal.proxy, noProxy: portal.noProxy, timeoutMs: portal.timeoutMs,
        });
        results.legacy = { ok: r.status < 300, status: r.status };
      } catch (e) { results.legacy = { ok: false, error: e.message }; }
    }
    if (!portal.enabled) return { ok: !!results.legacy?.ok, ...results };

    const body = prepare('heartbeat', {
      node_id: portal.nodeId, role: portal.role || 'collector', version,
      uptime_s: Math.round(process.uptime()), queue_depth: queue.stats().pending,
      ...(s.last_poll_ok_ratio !== undefined ? { last_poll_ok_ratio: s.last_poll_ok_ratio } : {}),
      ...(s.devices_total !== undefined ? { devices_total: s.devices_total } : {}),
      ...(s.devices_unreachable !== undefined ? { devices_unreachable: s.devices_unreachable } : {}),
      clock: adapt.iso(now()), profile: portal.profile || 'bare', os: osName(),
    });
    if (!body) return { ok: false, error: 'invalid heartbeat' };
    try {
      const r = await call('POST', PATHS.heartbeat, body, crypto.randomUUID());
      if (r.status >= 300) {
        stats.last_error = `heartbeat → HTTP ${r.status}`;
        return { ok: false, status: r.status, ...results };
      }
      lastReachable = now();
      commandsPending = r.json?.commands_pending || 0;
      await checkClock(r.headers.date);
      // The link is up: whatever was waiting out an outage can go now. A 429
      // wait stands — the Portal asked for it.
      if (!throttled) { attempts = 0; nextAt = 0; }
      await flush();
      return { ok: true, data: r.json, ...results };
    } catch (e) {
      stats.last_error = e.message;
      return { ok: false, error: e.message, ...results };
    }
  }

  return {
    sendEvent, postEvents, putInventory, syncInventory, addPoint, flushTelemetry, flush, heartbeat,
    drain: async () => { const r = await flush(); return { drained: r.sent || 0, ...r }; },
    stats: () => ({ ...stats, queued_points: points.length, commands_pending: commandsPending, next_attempt_at: nextAt || null }),
    lastReachable: () => lastReachable,
    _book: book,
  };
}

// ── the process-wide instance, built from env on first use ─────────────────
let instance = null;
let cfg = null;
function get() {
  if (instance) return instance;
  cfg = require('./config');
  instance = createForwarder({
    portal: {
      enabled: cfg.portal.enabled, url: cfg.portal.url, tenant: cfg.tenantId, nodeId: cfg.portal.nodeId,
      role: 'collector', siteId: cfg.portal.siteId, profile: cfg.portal.profile,
      tls: transport.loadTls(cfg.portal.tls), proxy: cfg.portal.proxy, noProxy: cfg.portal.noProxy,
      timeoutMs: 15000,
    },
    legacy: { enabled: cfg.legacy.enabled, url: cfg.cflexUrl, token: cfg.cflexToken, probeId: cfg.probeId, tenantId: cfg.tenantId },
    queue: require('./buffer'),
    version: require('../package.json').version,
  });
  return instance;
}

// Device config is still pulled from the old cloud until the Local Console
// inventory API exists (WO-INT-004). Pulling is not forwarding, so it is not
// behind the legacy flag — only behind having a token for that cloud at all.
async function legacyGet(path) {
  get();
  if (!cfg.cflexToken) return null;
  const r = await transport.request({
    method: 'GET', url: cfg.cflexUrl.replace(/\/+$/, '') + path,
    headers: { 'X-Probe-Key': cfg.cflexToken, 'X-Probe-Id': cfg.probeId, 'X-Tenant-Id': cfg.tenantId },
    proxy: cfg.portal.proxy, noProxy: cfg.portal.noProxy, timeoutMs: 15000,
  });
  return r;
}

async function fetchDeviceConfig() {
  try {
    const r = await legacyGet(`/v1/probe/devices?tenant=${encodeURIComponent(cfg?.tenantId || '')}`);
    return r && r.status < 300 ? r.json?.devices || [] : [];
  } catch (e) {
    console.error('[forwarder] fetchDeviceConfig failed:', e.message);
    return [];
  }
}

/**
 * The non-UPS inventory: PDUs, NetBotz, CRACs, switches. A server that does
 * not have this endpoint yet answers 404, and the agent carries on with the
 * UPS feed alone.
 */
async function fetchObjectConfig() {
  try {
    const r = await legacyGet(`/v1/probe/objects?tenant=${encodeURIComponent(cfg?.tenantId || '')}`);
    return r && r.status < 300 ? r.json?.devices || [] : [];
  } catch (e) {
    console.error('[forwarder] fetchObjectConfig failed:', e.message);
    return [];
  }
}

module.exports = {
  createForwarder,
  sendEvent: (...a) => get().sendEvent(...a),
  heartbeat: (...a) => get().heartbeat(...a),
  drain: (...a) => get().drain(...a),
  flushTelemetry: (...a) => get().flushTelemetry(...a),
  putInventory: (...a) => get().putInventory(...a),
  syncInventory: (...a) => get().syncInventory(...a),
  stats: () => get().stats(),
  lastReachable: () => get().lastReachable(),
  fetchDeviceConfig,
  fetchObjectConfig,
};
