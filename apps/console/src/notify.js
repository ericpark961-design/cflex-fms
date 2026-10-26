// notify.js — HAEA-internal notification, sent by the Local Console
// (DECISIONS Q-2026-10-25-10 (A); spec 01 §2.2; firewall request v3 FW-8:
// app → SMTP relay 25/587, app → proxy → Teams/ServiceNow 443).
//
// The Collector has no notification channels. It posts each alarm event to
// /collector/v1/events; the console stores it, notifies here, and answers
// with what was delivered per event. The Collector puts that answer in the
// event's `local_notified` before the event goes to the Portal (contract 00
// v1.1 §3.4), so the Portal still learns what HAEA was already told.
//
// Policy and delivery are probe-agent's local-notify.js — one code path for
// the alarm notifications and the test-ticket button. What lives here is
// where its inputs come from on the console:
//   channels    the settings table (secrets sealed; opened only here)
//   alarm_id→INC the itsm_map table, so a clear on app02 resolves the ticket
//               a raise on app01 opened
//   suppression the event's own `detail.maintenance` (the Collector's engine)
//               or a window set on the console since the Collector last
//               pulled its config
const { createLocalNotifier } = require('../../../probe-agent/src/alarms/local-notify');
const transport = require('../../../probe-agent/src/portal/transport');

const NO_DELIVERY = Object.freeze({ email: false, teams: false, itsm: null });

/** The local-notify store interface (get/set/patch) over itsm_map. */
function itsmStore(db, now = Date.now) {
  const get = db.prepare('SELECT value FROM itsm_map WHERE alarm_id = ?');
  const put = db.prepare(`INSERT INTO itsm_map (alarm_id, value, updated) VALUES (?, ?, ?)
    ON CONFLICT(alarm_id) DO UPDATE SET value = excluded.value, updated = excluded.updated`);
  const read = (k) => { const r = get.get(String(k)); return r ? JSON.parse(r.value) : undefined; };
  return {
    get: read,
    set(k, v) { put.run(String(k), JSON.stringify(v), now()); return v; },
    patch(k, v) { const next = { ...(read(k) || {}), ...v }; put.run(String(k), JSON.stringify(next), now()); return next; },
  };
}

/**
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.settings     settings.js (getNotify({open:true}))
 * @param {object} [o.deps]       {http, smtpSend} for tests
 * @param {object} [o.net]        {proxy, noProxy, ca} — HAEA's proxy for Teams/ServiceNow
 * @param {number} [o.replayMaxAgeMs]  a replayed event older than this is recorded, not announced
 * @param {Function} [o.now]
 * @param {object} [o.log]
 */
function createConsoleNotify({ db, settings, deps = {}, net = {}, replayMaxAgeMs = 15 * 60e3, now = Date.now, log = console }) {
  const store = itsmStore(db, now);
  const deviceLabel = db.prepare('SELECT label FROM devices WHERE device_id = ?');
  const alarmRow = db.prepare('SELECT title FROM alarms WHERE alarm_id = ?');
  const muted = db.prepare(`SELECT 1 FROM maintenance WHERE starts_at <= ? AND ends_at > ?
    AND (device_id IS NULL OR device_id = ?) AND (site_id IS NULL OR site_id = ?) LIMIT 1`);

  // Built per use: a channel changed in Settings applies to the next alarm,
  // on both nodes, with nothing to restart.
  const notifier = () => createLocalNotifier({
    config: settings.getNotify({ open: true }), store, deps, request: transport.request,
    proxy: net.proxy || null, noProxy: net.noProxy || null, ca: net.ca, log,
  });

  /**
   * Notify for events the console has just stored, in order. Returns
   * event_id → local_notified (null for an event that was not handled).
   *
   * @param {object[]} events   contract events
   * @param {{replay?: boolean}} [o]  the Collector is re-sending these after the console was unreachable
   */
  async function forEvents(events, { replay = false } = {}) {
    const out = {};
    if (!events.length) return out;
    const n = notifier();
    if (!n.enabled()) return out;
    const t = now();
    for (const ev of events) {
      // A Collector that still notifies by itself has already said what it delivered.
      if (ev.local_notified) continue;
      if (!['alarm_raise', 'alarm_update', 'alarm_clear'].includes(ev.kind)) continue;
      const det = ev.detail || {};
      // An alarm raised inside a maintenance window that outlived it is
      // announced as a raise when the window ends (alarms/engine.js).
      const notifyAs = ev.kind === 'alarm_update' && det.maintenance_ended ? 'raise' : undefined;
      // Late news is not news: a replay older than replayMaxAgeMs is stored and
      // shown, and its ticket still resolves on clear, but no one is paged —
      // the Portal received it without local_notified and routes it itself.
      const stale = replay && t - Date.parse(ev.ts) > replayMaxAgeMs;
      const inWindow = !!muted.get(t, t, ev.device_id || null, ev.site_id || null);
      const suppressed = det.maintenance || inWindow ? 'maintenance' : stale ? 'stale_replay' : null;
      const alarm = {
        title: alarmRow.get(ev.alarm_id)?.title || ev.title,
        label: (ev.device_id && deviceLabel.get(ev.device_id)?.label) || undefined,
      };
      try {
        out[ev.event_id] = (await n.handle({ event: ev, suppressed, alarm, notifyAs })) || { ...NO_DELIVERY };
      } catch (e) {
        // A channel bug must not cost the Collector its answer for the rest.
        log.error(`[notify] ${ev.code} ${ev.event_id}: ${e.message}`);
        out[ev.event_id] = null;
      }
    }
    return out;
  }

  /** SOW acceptance: the test-ticket button. */
  const testTicket = (o) => notifier().testTicket(o);

  return { forEvents, testTicket, store };
}

/** Does this event announce its alarm (a raise, or the late raise after a maintenance window)? */
const announces = (ev) => ev.kind === 'alarm_raise' || (ev.kind === 'alarm_update' && !!ev.detail?.maintenance_ended);

module.exports = { createConsoleNotify, itsmStore, announces };
