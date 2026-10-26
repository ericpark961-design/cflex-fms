// alarms/engine.js — first-pass alarm classification on the Probe (spec 01 §3,
// contract §3.4 + appendix B).
//
// What goes in: observations — "this condition holds on this device now" —
// from the pollers' threshold alerts and from the poll outcome itself. What
// comes out: contract events (alarm_raise / alarm_update / alarm_clear), each
// with a note of whether it was suppressed, for the local notifier.
//
// The four rules, and why each exists:
//
//   classification  Severity is the appendix-B code's (codes.js). The Portal
//                   routes on code, so a poller's own P-level must not leak.
//   de-duplication  One alarm per (device, code) while it lasts. A condition
//                   seen every 60 s produces one raise, then an update at most
//                   every `updateEveryMs` — not 1,440 events a day.
//   flapping        A condition that raises `flapRaises` times inside
//                   `flapWindowMs` is flapping. Its alarm stays open through
//                   the gaps and clears only after `flapQuietMs` of quiet, so
//                   a loose sensor cannot page someone every two minutes.
//   maintenance     Inside a maintenance window events still go to the Portal
//                   (it must see the truth) marked `detail.maintenance=true`,
//                   and are flagged suppressed so nothing is sent locally.
//
// Open alarms survive a restart when a `persist` store is given (the buffer's
// SQLite file, alarms/persist.js): a condition still there after the restart
// carries on under its old alarm_id — an update, not a second raise — and one
// that went away while the Probe was down clears after the usual quiet cycle.
// Without a store, a restart forgets them and the next poll re-raises.
// Flap history and the 30-minute comm-loss count are not kept: both restart
// from zero, which errs toward fewer pages, not more.
const crypto = require('crypto');
const adapt = require('../contract/adapt');
const { severityOf, classify, COMM_LOST_AFTER_MS, CAPACITY_HOLD_AFTER_BATTERY_MS } = require('./codes');

const MIN = 60 * 1000;
const DEFAULTS = {
  updateEveryMs: 15 * MIN,
  flapWindowMs: 15 * MIN,
  flapRaises: 3,
  flapQuietMs: 15 * MIN,
  commLostAfterMs: COMM_LOST_AFTER_MS,
  capacityHoldMs: CAPACITY_HOLD_AFTER_BATTERY_MS,
};
const STATE_VERSION = 1;

const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

/**
 * @param {object} o
 * @param {{tenant:string, siteId:string}} o.ctx
 * @param {Function} [o.now]
 * @param {object} [o.opts]          overrides for DEFAULTS
 * @param {object[]} [o.maintenance] initial windows, see setMaintenance
 * @param {{load():object|null, save(object):void}} [o.persist]  open-alarm store, alarms/persist.js
 * @param {object} [o.log]
 */
function createAlarmEngine({ ctx, now = Date.now, opts = {}, maintenance = [], persist = null, log = console } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const open = new Map();      // key → alarm
  const raises = new Map();    // key → [ts] within the flap window
  const cycle = new Map();     // device_id → cycle number
  const commDown = new Map();  // device_id → first failed poll ts (not yet an alarm)
  const batteryAt = new Map(); // device_id → last ts on battery, for the capacity hold
  let windows = [];

  const keyOf = (did, code) => `${did}|${code}`;

  function restore() {
    let s = null;
    try { s = persist.load(); } catch (e) {
      // A damaged state row costs the open alarms, not the Probe.
      log.error(`[alarms] saved state unreadable, starting empty: ${e.message}`);
      return;
    }
    if (!s || s.v !== STATE_VERSION) return;
    // Cycle numbers restart at 0, so `seen` does too — otherwise an alarm
    // from cycle 900 would look current for the next 900 cycles.
    for (const al of s.open || []) open.set(al.key, { ...al, seen: 0, quietSince: null });
    for (const [did, ts] of s.batteryAt || []) batteryAt.set(did, ts);
  }

  function save() {
    if (!persist) return;
    try {
      persist.save({ v: STATE_VERSION, open: [...open.values()], batteryAt: [...batteryAt] });
    } catch (e) {
      log.error(`[alarms] could not save state: ${e.message}`);
    }
  }

  if (persist) restore();

  /**
   * Appendix B v1.1: no capacity warning while the UPS is on battery (the P1
   * UPS_ON_BATTERY is already open) nor for `capacityHoldMs` after it came
   * back — the battery is recharging.
   */
  function capacityHeld(did, ts) {
    if (open.has(keyOf(did, 'UPS_ON_BATTERY'))) return true;
    const t = batteryAt.get(did);
    return t != null && ts - t < o.capacityHoldMs;
  }

  /**
   * Maintenance windows. `{device_id?, ledger_id?, site_id?, from?, until, reason?}`;
   * with neither device nor site it covers the whole node. Expired ones are dropped.
   */
  function setMaintenance(list) {
    windows = (list || []).map(w => ({ ...w, from: toMs(w.from) ?? 0, until: toMs(w.until) }))
      .filter(w => Number.isFinite(w.until));
  }
  setMaintenance(maintenance);

  function inMaintenance(device, did, site, ts) {
    windows = windows.filter(w => w.until > now());
    return windows.some(w => ts >= w.from && ts < w.until
      && (w.device_id == null || w.device_id === did)
      && (w.ledger_id == null || String(w.ledger_id) === String(device?.id))
      && (w.site_id == null || w.site_id === site));
  }

  function event(al, kind, ts, title, detail, source) {
    const d = { ...detail };
    if (al.flapping) d.flapping = true;
    if (al.maintenance) d.maintenance = true;
    return {
      event_id: crypto.randomUUID(), alarm_id: al.alarm_id, device_id: al.device_id, site_id: al.site_id,
      ts: adapt.iso(ts), kind, severity: al.severity, code: al.code,
      title: String(title).slice(0, 200), detail: d, source,
    };
  }

  const out = (al, ev) => ({ event: ev, suppressed: al.maintenance ? 'maintenance' : null, alarm: { ...al } });

  /**
   * The condition `code` holds on `device` at `ts`. `latched`: no poll can see
   * this condition (a trap-only one, trap/handler.js), so a poll cycle that
   * does not observe it is no evidence it is over — it waits for its clear.
   */
  function observe(device, code, { ts = now(), title, detail = {}, source = 'rule', latched = false } = {}) {
    const severity = severityOf(code);
    if (!severity) return [];
    const did = adapt.deviceIdFor(device, ctx);
    const site = adapt.siteOf(device, ctx);
    const key = keyOf(did, code);
    const al = open.get(key);
    if (code === 'UPS_ON_BATTERY') batteryAt.set(did, ts);
    if (!al && code === 'UPS_BATTERY_CAPACITY_LOW' && capacityHeld(did, ts)) return [];
    const maint = inMaintenance(device, did, site, ts);

    if (al) {
      al.seen = cycle.get(did) || 0;
      al.quietSince = null;
      if (latched) al.latched = true;
      al.last = { title, detail };
      if (al.maintenance && !maint) {
        // Raised inside a window that has now ended, and still there. Nobody
        // was told; tell them now, as if it had just been raised.
        al.maintenance = false;
        al.emittedAt = ts;
        save();
        return [{ ...out(al, event(al, 'alarm_update', ts, title || code, { ...detail, maintenance_ended: true }, source)), notifyAs: 'raise' }];
      }
      if (maint && !al.maintenance) { al.maintenance = true; save(); }
      if (ts - al.emittedAt < o.updateEveryMs) return [];
      al.emittedAt = ts;
      save();
      return [out(al, event(al, 'alarm_update', ts, title || code, detail, source))];
    }

    const recent = (raises.get(key) || []).filter(t => ts - t < o.flapWindowMs);
    recent.push(ts);
    raises.set(key, recent);
    const created = {
      alarm_id: crypto.randomUUID(), key, code, severity, device_id: did, site_id: site, ledger_id: device?.id ?? null,
      label: device?.name || null, raisedAt: ts, emittedAt: ts, seen: cycle.get(did) || 0, quietSince: null,
      flapping: recent.length >= o.flapRaises, maintenance: maint, title: title || code, last: { title, detail },
      ...(latched ? { latched: true } : {}),
    };
    open.set(key, created);
    save();
    return [out(created, event(created, 'alarm_raise', ts, created.title, detail, source))];
  }

  /** The condition is not present. Clears now, or after the quiet period if flapping. */
  function inactive(key, ts, source = 'rule') {
    const al = open.get(key);
    if (!al) return [];
    if (al.flapping) {
      if (al.quietSince == null) al.quietSince = ts;
      if (ts - al.quietSince < o.flapQuietMs) return [];
    }
    open.delete(key);
    // Back from battery: the capacity hold runs from here.
    if (al.code === 'UPS_ON_BATTERY') batteryAt.set(al.device_id, ts);
    save();
    return [out(al, event(al, 'alarm_clear', ts, `Cleared: ${al.title}`, {}, source))];
  }

  /**
   * A successful poll opens a new cycle for its device. Threshold alarms not
   * observed during the cycle before it are over. Comm loss is not a
   * threshold alarm; it clears in commStatus.
   */
  function beginCycle(device, ts = now()) {
    const did = adapt.deviceIdFor(device, ctx);
    const n = (cycle.get(did) || 0) + 1;
    cycle.set(did, n);
    const res = [];
    for (const [key, al] of [...open]) {
      if (al.device_id !== did || al.code === 'UPS_COMM_LOST' || al.latched) continue;
      if (al.seen < n - 1) res.push(...inactive(key, ts));
    }
    return res;
  }

  /** The poll outcome. UPS_COMM_LOST only after `commLostAfterMs` without an answer. */
  function commStatus(device, ok, ts = now(), why = null) {
    const did = adapt.deviceIdFor(device, ctx);
    const key = keyOf(did, 'UPS_COMM_LOST');
    if (ok) {
      commDown.delete(did);
      return inactive(key, ts, 'poll');
    }
    if (!commDown.has(did)) commDown.set(did, ts);
    const since = commDown.get(did);
    if (!open.has(key) && ts - since < o.commLostAfterMs) return [];
    const mins = Math.round((ts - since) / MIN);
    return observe(device, 'UPS_COMM_LOST', {
      ts, source: 'poll',
      title: `UPS not answering for ${mins} min${why ? `: ${String(why).slice(0, 120)}` : ''}`,
      detail: { down_min: mins },
    });
  }

  /** The condition `code` on `device` is over (a clear trap). Same rules as any clear. */
  function clear(device, code, { ts = now(), source = 'rule' } = {}) {
    return inactive(keyOf(adapt.deviceIdFor(device, ctx), code), ts, source);
  }

  /** Whether `code` is open on `device`. */
  const isOpen = (device, code) => open.has(keyOf(adapt.deviceIdFor(device, ctx), code));

  /** A poller threshold alert → observe(). Returns {items, code}; code null = unmapped. */
  function fromAlert(device, a) {
    const code = classify(a);
    if (!code) return { items: [], code: null };
    const detail = {};
    if (a.metric) detail.metric = String(a.metric);
    if (['number', 'string', 'boolean'].includes(typeof a.value)) detail.value = a.value;
    if (typeof a.threshold === 'number') detail.threshold = a.threshold;
    return { items: observe(device, code, { ts: a.ts ?? now(), title: a.message || code, detail, source: 'rule' }), code };
  }

  return {
    observe, inactive, clear, isOpen, beginCycle, commStatus, fromAlert, setMaintenance,
    inMaintenance: (device, ts = now()) => inMaintenance(device, adapt.deviceIdFor(device, ctx), adapt.siteOf(device, ctx), ts),
    openAlarms: () => [...open.values()].map(a => ({ ...a })),
    maintenanceWindows: () => windows.map(w => ({ ...w })),
    options: o,
  };
}

module.exports = { createAlarmEngine, DEFAULTS };
