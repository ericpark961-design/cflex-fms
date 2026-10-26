// console/client.js — the Collector's link to the Local Console (spec 01
// §2.1; firewall request v3 FW-7: cap01 → app 443, through nginx).
//
//   GET  /collector/v1/devices    the inventory to poll, credentials opened
//   GET  /collector/v1/config     thresholds and maintenance windows
//   POST /collector/v1/telemetry  batched with the Portal's (contract §3.3 shape)
//   POST /collector/v1/events     alarm events; the console notifies HAEA and
//                                 answers event_id → local_notified
//                                 (DECISIONS Q-2026-10-25-10 (A))
//   POST /collector/v1/heartbeat  this node, and the state of its Portal link
//
// Auth is the collector key (Bearer) issued on the console. The console is
// inside HAEA: no proxy, and the trust anchor is the CA of its nginx
// certificate (CFLEX_CONSOLE_CA), not the Portal's.
//
// Events go straight to the console while it answers, because the answer is
// part of the event the Portal receives. When it does not, they wait in a
// queue of their own (buffer channel 'console') and are re-sent marked as a
// replay; the Portal is not held up — it gets the event without
// `local_notified`, which tells it no one here was told.
const transport = require('../portal/transport');
const { fromConsole } = require('../pollers/thresholds');

const PATHS = {
  devices: '/collector/v1/devices',
  config: '/collector/v1/config',
  telemetry: '/collector/v1/telemetry',
  events: '/collector/v1/events',
  heartbeat: '/collector/v1/heartbeat',
};
const MAX_POINTS = 500;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

const SNMP_VERSION = { 1: 'v1', '2c': 'v2c', 3: 'v3' };

/**
 * A console device row → what the pollers read (services/snmp-helpers.js).
 * `snmpPort` is for a simulator on a test host; NMCs answer on 161.
 */
function pollerDevice(d, { thresholds = null, snmpPort = null } = {}) {
  const v3 = d.snmp_v3 || null;
  return {
    id: d.id, device_id: d.device_id, name: d.name, kind: d.kind || 'ups', site_id: d.site_id,
    ip: d.ip, vendor: d.vendor, model: d.model, serial: d.serial,
    thresholds: fromConsole(thresholds, d.thresholds),
    snmp_version: SNMP_VERSION[d.snmp_version] || 'v2c',
    snmp_community: d.snmp_community || undefined,
    ...(v3 ? {
      snmp_v3_user: v3.user, snmp_v3_auth_protocol: v3.auth_proto, snmp_v3_auth_password: v3.auth_key || '',
      snmp_v3_priv_protocol: v3.priv_proto, snmp_v3_priv_password: v3.priv_key || '',
    } : {}),
    ...(snmpPort && snmpPort !== 161 ? { snmp_port: snmpPort } : {}),
  };
}

/**
 * @param {object} o
 * @param {string|string[]} o.url  https://<console> (nginx 443); several, comma-separated = app01, app02
 * @param {string} o.nodeId     this collector's node id (cap01)
 * @param {string} o.key        collector key
 * @param {object} [o.tls]      transport.loadTls({caPath}) — the console's CA
 * @param {object} o.queue      buffer channel: enqueue/dequeue/ack/fail/stats
 * @param {Function} [o.request]
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.now]
 * @param {Function} [o.random]
 * @param {object} [o.log]
 * @param {string} [o.version]
 */
function createConsoleClient(o) {
  // Both app nodes, active first (CFLEX_CONSOLE_URL=https://app01,https://app02). Each serves
  // the same console (stateless, spec 01 §2.2); with no VIP yet (spec §6-2) the collector
  // moves to the next when one cannot be reached at all — SAT 6, app01's VM stopped.
  const bases = [].concat(o.url).flatMap(u => String(u).split(',')).map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
  let cur = 0;
  const request = o.request || transport.request;
  const queue = o.queue;
  const now = o.now || Date.now;
  const random = o.random || Math.random;
  const log = o.log || console;
  const timeoutMs = o.timeoutMs || 20000;
  const stats = { sent: 0, rejected: 0, retried: 0, notified: 0, failovers: 0, last_error: null, last_ok: null };
  let points = [];
  let attempts = 0;
  let nextAt = 0;
  let flushing = null;

  async function call(method, path, body, extra = {}) {
    const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const once = (base) => request({
      method, url: base + path, body: buf, timeoutMs,
      headers: {
        'X-CFlex-Node': o.nodeId,
        Authorization: `Bearer ${o.key}`,
        'User-Agent': `cflex-probe/${o.version || '0.0.0'}`,
        ...(buf ? { 'Content-Type': 'application/json', 'Content-Length': String(buf.length) } : {}),
        ...extra,
      },
      // The console is on HAEA's own network: never through the proxy, and
      // never with the Portal's client certificate.
      tls: { ca: o.tls?.ca }, proxy: null,
    });
    let r;
    for (let tried = 0; ; tried++) {
      try {
        r = await once(bases[cur]);
        break;
      } catch (e) {
        // Unreachable (not an HTTP answer): the other node, once per call.
        if (tried + 1 >= bases.length) throw e;
        const was = bases[cur];
        cur = (cur + 1) % bases.length;
        stats.failovers++;
        log.warn(`[console] ${was} unreachable (${e.code || e.message}); trying ${bases[cur]}`);
      }
    }
    if (r.status >= 200 && r.status < 300) { stats.last_ok = now(); return r; }
    const e = new Error(`${method} ${path} → HTTP ${r.status}${r.json?.error ? ` ${r.json.error}` : ''}`);
    e.status = r.status;
    throw e;
  }

  // 5xx, 429, 409 and the network are worth another try; another 4xx is not.
  const retryable = (e) => !e.status || e.status >= 500 || e.status === 429 || e.status === 409;

  function backoff() {
    attempts++;
    const b = Math.min(BACKOFF_MIN_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    nextAt = now() + Math.round(b * (0.8 + 0.4 * random()));
  }

  async function flushOnce() {
    if (now() < nextAt) return { sent: 0, waiting_ms: nextAt - now() };
    let sent = 0;
    for (;;) {
      const rows = queue.dequeue(50);
      if (!rows.length) break;
      for (const row of rows) {
        const item = JSON.parse(row.payload);
        try {
          // A queued event is late by definition; the console decides whether it is still news.
          await call('POST', item.path, item.body, item.path === PATHS.events ? { 'X-CFlex-Replay': '1' } : {});
        } catch (e) {
          stats.last_error = e.message;
          if (retryable(e)) {
            stats.retried++;
            queue.fail(row.id, e.message);
            backoff();
            return { sent, error: e.message };
          }
          stats.rejected++;
          log.error(`[console] ${item.path}: ${e.message}; dropped (4xx is not retried)`);
          queue.ack([row.id]);
          continue;
        }
        queue.ack([row.id]); sent++; stats.sent++;
        attempts = 0; nextAt = 0;
      }
    }
    return { sent };
  }

  /** Drain the queue in order. Concurrent callers share one pass. */
  function flush() {
    if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
    return flushing;
  }

  /**
   * Alarm events to the console. Resolves to event_id → local_notified when
   * the console answered, or null when it could not be reached now (the
   * events are then queued and re-sent).
   */
  async function events(list) {
    if (!list.length) return {};
    const body = { events: list };
    // Anything already waiting goes first, so the console sees an alarm's
    // raise before its clear.
    if (queue.stats().pending) await flush();
    if (queue.stats().pending) {
      queue.enqueue('events', { path: PATHS.events, body });
      return null;
    }
    try {
      const r = await call('POST', PATHS.events, body);
      stats.sent++;
      const ln = r.json?.local_notified || {};
      stats.notified += Object.keys(ln).length;
      return ln;
    } catch (e) {
      stats.last_error = e.message;
      if (!retryable(e)) {
        stats.rejected++;
        log.error(`[console] events: ${e.message}; dropped (4xx is not retried)`);
        return null;
      }
      log.warn(`[console] events not delivered (${e.message}); queued — the Portal gets them without local_notified`);
      queue.enqueue('events', { path: PATHS.events, body });
      backoff();
      return null;
    }
  }

  function flushTelemetry() {
    while (points.length) {
      queue.enqueue('telemetry', { path: PATHS.telemetry, body: { node_id: o.nodeId, points: points.splice(0, MAX_POINTS) } });
    }
    return flush();
  }

  function addPoint(p) {
    points.push(p);
    if (points.length >= MAX_POINTS) flushTelemetry();
  }

  /** The inventory and its config. Null when the console cannot be reached (keep what you have). */
  async function inventory({ snmpPort = null } = {}) {
    try {
      const [c, d] = [await call('GET', PATHS.config), await call('GET', PATHS.devices)];
      const thresholds = c.json?.thresholds || null;
      return {
        devices: (d.json?.devices || []).map(x => pollerDevice(x, { thresholds, snmpPort })),
        maintenance: c.json?.maintenance || [],
        thresholds,
      };
    } catch (e) {
      stats.last_error = e.message;
      log.warn(`[console] inventory pull failed: ${e.message}`);
      return null;
    }
  }

  async function heartbeat(body) {
    try {
      await call('POST', PATHS.heartbeat, body);
      return { ok: true };
    } catch (e) {
      stats.last_error = e.message;
      return { ok: false, error: e.message };
    }
  }

  return {
    events, addPoint, flushTelemetry, flush, inventory, heartbeat,
    stats: () => ({ ...stats, url: bases[cur], queued: queue.stats().pending, queued_points: points.length, next_attempt_at: nextAt || null }),
  };
}

module.exports = { createConsoleClient, pollerDevice, PATHS };
