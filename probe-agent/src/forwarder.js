// forwarder.js — the Collector's outbound side: everything goes to the FMS
// (the Local Console, app01/app02 443) and nowhere else.
//
// D-13 (WO-INT-012): collectors N → FMS → Portal. The Portal sender
// (contract 00, mTLS, proxy, 7-day buffer) moved to the FMS
// (apps/console/src/portal.js); a collector has no external path at all —
// no Portal URL, no device key, no proxy. What it does here is what it did
// before, minus the Portal:
//
//   pollers' readings  → contract telemetry points (contract/adapt.js)
//   alerts, traps, comm loss → the alarm engine (alarms/engine.js, unchanged:
//                        classification stays on the collector) → events
//   both               → console/client.js: POST /collector/v1/telemetry|events,
//                        queued in buffer.db (channel 'console') while the FMS
//                        is unreachable, re-sent in order
//   heartbeat          → POST /collector/v1/heartbeat (the FMS relays it to the
//                        Portal as this collector's, collector_id = node id)
//
// The FMS merges what several collectors report by device_id; this collector
// polls only the sites it is given (CFLEX_COLLECTOR_SITES, console/client.js).
const fs = require('fs');
const os = require('os');
const adapt = require('./contract/adapt');
const { createAlarmEngine } = require('./alarms/engine');

function osName() {
  try { return fs.readFileSync('/etc/redhat-release', 'utf8').replace(/release /, '').replace(/\s*\(.*\)\s*$/, '').trim().slice(0, 64); }
  catch { return `${os.type()} ${os.release()}`.slice(0, 64); }
}

/**
 * @param {object} o
 * @param {object} o.node      { tenant, nodeId, siteId, profile, sites }
 * @param {object} [o.console] console/client.js instance — the only destination
 * @param {Function} [o.now]
 * @param {object} [o.log]
 * @param {string} [o.version]
 * @param {object} [o.alarms]  engine options (alarms/engine.js DEFAULTS) + {maintenance, persist}
 */
function createForwarder(o) {
  const node = o.node;
  const now = o.now || Date.now;
  const log = o.log || console;
  const version = o.version || '0.0.0';
  const ctx = { tenant: node.tenant, siteId: node.siteId };
  const alarms = o.alarms || {};
  const engine = createAlarmEngine({ ctx, now, opts: alarms, maintenance: alarms.maintenance, persist: alarms.persist || null, log });
  const consoleLink = o.console || null;
  const stats = { points: 0, events: 0, unmapped_alerts: 0, console_errors: 0, last_error: null };

  // The ledger, by ledger id. The pollers' payloads carry only the ledger id;
  // the contract device_id needs serial and site, and telemetry and events
  // must derive the same one the FMS has.
  const ledger = new Map();

  /** Register the ledger (the FMS's device rows). The FMS sends the inventory to the Portal. */
  async function syncInventory(list) {
    ledger.clear();
    for (const d of list) ledger.set(String(d.id), d);
    return { devices: ledger.size };
  }

  function flushTelemetry() {
    if (consoleLink) consoleLink.flushTelemetry().catch(e => log.error(`[forwarder] console telemetry: ${e.message}`));
  }

  function addPoint(p) {
    stats.points++;
    if (consoleLink) consoleLink.addPoint(p);
  }

  /** Engine items → the FMS. Unreachable, they wait in the console queue and go in order. */
  async function emit(items) {
    if (!items.length) return { sent: 0 };
    const events = items.map(it => it.event);
    stats.events += events.length;
    if (!consoleLink) return { sent: 0 };
    try {
      await consoleLink.events(events);
    } catch (e) {
      stats.console_errors++; stats.last_error = e.message;
      log.error(`[forwarder] console events: ${e.message}`);
    }
    return { sent: events.length };
  }

  const deviceFor = (p) => ledger.get(String(p.device_id)) || { id: p.device_id, site_id: p.site_id, serial: p.serial };

  /**
   * The pollers' interface, unchanged: ('telemetry'|'metrics'|'alert', payload).
   * Translated to the contract here, so no poller had to change.
   */
  async function sendEvent(kind, payload) {
    const device = deviceFor(payload);
    const ts = payload.ts ?? now();
    if (kind === 'telemetry') {
      addPoint(Array.isArray(payload.metrics)
        ? adapt.collectorPoint(device, payload, ctx)
        : adapt.upsPoint(device, payload, ctx));
      if (payload.kind === 'ups') {
        // Comm loss comes from the poll outcome, not from the poller's
        // reachability alerts: appendix B wants 30 minutes of silence.
        const items = engine.commStatus(device, payload.ok !== false, ts, payload.error);
        if (payload.ok !== false) items.push(...engine.beginCycle(device, ts));
        await emit(items);
      }
    } else if (kind === 'metrics') {
      addPoint(adapt.collectorPoint(device, payload, ctx));
    } else if (kind === 'alert' && payload.metric !== 'reachability') {
      const r = engine.fromAlert(device, payload);
      if (r.code) await emit(r.items);
      else stats.unmapped_alerts++;
    }
    return { ok: true, queued: true };
  }

  /**
   * @param {object} s  { devices_total, devices_unreachable, last_poll_ok_ratio }
   */
  async function heartbeat(s = {}) {
    if (!consoleLink) return { ok: false, error: 'no Local Console configured (CFLEX_CONSOLE_URL)' };
    const r = await consoleLink.heartbeat({
      node_id: node.nodeId, role: 'collector', version,
      uptime_s: Math.round(process.uptime()), queue_depth: consoleLink.stats().queued,
      ...(s.last_poll_ok_ratio !== undefined ? { last_poll_ok_ratio: s.last_poll_ok_ratio } : {}),
      ...(s.devices_total !== undefined ? { devices_total: s.devices_total } : {}),
      ...(s.devices_unreachable !== undefined ? { devices_unreachable: s.devices_unreachable } : {}),
      clock: adapt.iso(now()), profile: node.profile || 'bare', os: osName(),
      sites: node.sites && node.sites.length ? node.sites : null,
    });
    consoleLink.flush().catch(() => {});
    return { ok: !!r.ok, console: r };
  }

  return {
    sendEvent, emitAlarms: emit, syncInventory, addPoint, flushTelemetry, heartbeat,
    drain: async () => {
      const c = consoleLink ? await consoleLink.flush() : { sent: 0 };
      return { drained: c.sent || 0, console: c };
    },
    stats: () => ({ ...stats, ...(consoleLink ? { console: consoleLink.stats() } : {}) }),
    alarms: engine,
    console: consoleLink,
  };
}

// ── the process-wide instance, built from env on first use ─────────────────
let instance = null;
let cfg = null;
function get() {
  if (instance) return instance;
  cfg = require('./config');
  const buffer = require('./buffer');
  const version = require('../package.json').version;
  let consoleLink = null;
  if (cfg.console.url) {
    const transport = require('./net/transport');
    const { createConsoleClient } = require('./console/client');
    consoleLink = createConsoleClient({
      url: cfg.console.url, nodeId: cfg.node.nodeId, timeoutMs: cfg.console.timeoutMs, version,
      key: cfg.console.keyPath ? fs.readFileSync(cfg.console.keyPath, 'utf8').trim() : '',
      tls: transport.loadTls({ caPath: cfg.console.caPath }),
      queue: buffer.channel('console'),
      sites: cfg.node.sites,
    });
    console.log(`[forwarder] Local Console ${cfg.console.url} — telemetry, events, heartbeat; the FMS sends to the Portal (D-13)`
      + (cfg.node.sites.length ? `; sites ${cfg.node.sites.join(',')}` : '; every site'));
  } else {
    console.warn('[forwarder] CFLEX_CONSOLE_URL not set: this collector has nowhere to send (D-13: collectors send only to the FMS)');
  }
  const pending = buffer.stats().pending;
  if (pending) {
    // Rows a pre-D-13 version queued for the Portal. The FMS got the same data on its own link;
    // they are kept until BUFFER_RETENTION_DAYS and then purged, never sent from here.
    console.warn(`[forwarder] ${pending} row(s) queued for the Portal by an older version stay unsent (D-13: the FMS sends)`);
  }
  instance = createForwarder({
    console: consoleLink,
    // Maintenance windows come from the Local Console's config pull (fetchDeviceConfig).
    alarms: { ...cfg.alarms, maintenance: [], persist: buffer.state('alarm_engine') },
    node: { tenant: cfg.tenantId, nodeId: cfg.node.nodeId, siteId: cfg.node.siteId, profile: cfg.node.profile, sites: cfg.node.sites },
    version,
  });
  return instance;
}

/**
 * The UPS inventory, from the Local Console: its devices (of this collector's
 * sites) with credentials and thresholds, and its maintenance windows applied
 * to the alarm engine. Null when the console cannot be reached, so the caller
 * keeps the list it has.
 */
async function fetchDeviceConfig() {
  const f = get();
  if (!f.console) return [];
  const inv = await f.console.inventory({ snmpPort: cfg.snmp.port });
  if (!inv) return null;
  f.alarms.setMaintenance(inv.maintenance);
  return inv.devices;
}

/**
 * The non-UPS inventory (PDUs, NetBotz, CRACs, switches). The console's
 * inventory is UPSs only (its device table) and has no object feed, and the
 * old-cloud feed is gone with the collector's external path (D-13) — so none.
 * The collectors stay for when the console grows one (Q-2026-10-26-14).
 */
async function fetchObjectConfig() {
  return [];
}

module.exports = {
  createForwarder,
  sendEvent: (...a) => get().sendEvent(...a),
  heartbeat: (...a) => get().heartbeat(...a),
  drain: (...a) => get().drain(...a),
  flushTelemetry: (...a) => get().flushTelemetry(...a),
  syncInventory: (...a) => get().syncInventory(...a),
  stats: () => get().stats(),
  alarms: () => get().alarms,
  emitAlarms: (...a) => get().emitAlarms(...a),
  consoleConfigured: () => !!get().console,
  fetchDeviceConfig,
  fetchObjectConfig,
};
