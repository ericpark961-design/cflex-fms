// ingest.js — what the Collector sends the Local Console, and what it pulls.
//
// Spec 01 §2.1: the Collector pulls its inventory from the Local Console and
// keeps sending to it when the Portal is unreachable. The payloads are the
// contract's own (00 §3.3 telemetry, §3.4 events), validated against the same
// schema files the Portal uses — one shape for both destinations, so the
// forwarder needs no second translation.
//
// Replays are harmless: an event_id already stored is skipped, a telemetry
// point already stored (device_id, ts) is ignored.
const crypto = require('crypto');
const { tx } = require('./db');
const schema = require('../../../probe-agent/src/contract/schema');

const ms = (iso) => Date.parse(iso);

function createIngest(db, { now = Date.now } = {}) {
  const st = {
    devByContract: db.prepare('SELECT id, device_id, site_id FROM devices WHERE device_id = ?'),
    point: db.prepare(`INSERT OR IGNORE INTO telemetry (device_id, ts, battery_pct, load_pct, temp_c, runtime_min, comm_ok, m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    latest: db.prepare(`UPDATE devices SET last_ts = ?, comm_ok = ?,
        battery_pct = COALESCE(?, battery_pct), load_pct = COALESCE(?, load_pct), temp_c = COALESCE(?, temp_c),
        runtime_min = COALESCE(?, runtime_min), output_v = COALESCE(?, output_v), input_v = COALESCE(?, input_v),
        ups_status = COALESCE(?, ups_status), firmware = COALESCE(?, firmware)
      WHERE device_id = ? AND (last_ts IS NULL OR last_ts <= ?)`),
    seen: db.prepare('SELECT local_notified FROM alarm_events WHERE event_id = ?'),
    ev: db.prepare('INSERT INTO alarm_events (event_id, alarm_id, ts, kind, title, detail, local_notified) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    evNotified: db.prepare('UPDATE alarm_events SET local_notified = ? WHERE event_id = ?'),
    alarmNotified: db.prepare('UPDATE alarms SET local_notified = ? WHERE alarm_id = ?'),
    alarm: db.prepare('SELECT * FROM alarms WHERE alarm_id = ?'),
    raise: db.prepare(`INSERT INTO alarms (alarm_id, device_id, site_id, code, severity, title, state, raised_at, updated_at, detail, local_notified, maintenance)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE alarms SET severity = ?, title = ?, updated_at = ?, detail = ?, state = 'open', cleared_at = NULL,
      local_notified = COALESCE(?, local_notified), maintenance = ? WHERE alarm_id = ?`),
    clear: db.prepare(`UPDATE alarms SET state = 'cleared', cleared_at = ?, updated_at = ?, local_notified = COALESCE(?, local_notified) WHERE alarm_id = ?`),
    collector: db.prepare('SELECT * FROM collectors WHERE node_id = ?'),
    beat: db.prepare('UPDATE collectors SET last_seen = ?, heartbeat = ? WHERE node_id = ?'),
  };

  /** Bearer key check for a collector node; returns the row or null. */
  function authCollector(nodeId, key) {
    if (!nodeId || !key) return null;
    const c = st.collector.get(String(nodeId));
    if (!c) return null;
    const want = Buffer.from(c.key_hash, 'hex');
    const got = crypto.createHash('sha256').update(String(key)).digest();
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? c : null;
  }

  function validate(name, body) {
    const v = schema.validate(name, body);
    if (!v.ok) {
      const e = new Error(`payload fails contract schema: ${v.errors.slice(0, 5).join('; ')}`);
      e.status = 400; e.code = 'invalid_payload';
      throw e;
    }
  }

  function telemetry(body) {
    validate('telemetry', body);
    let stored = 0, unknown = 0;
    tx(db, () => {
      for (const p of body.points) {
        if (!st.devByContract.get(p.device_id)) { unknown++; continue; }
        const t = ms(p.ts);
        const m = p.m || {};
        const runtime = typeof m.runtime_s === 'number' ? m.runtime_s / 60 : null;
        const comm = m.comm_ok === false ? 0 : 1;
        const r = st.point.run(p.device_id, t, m.bat_pct ?? null, m.load_pct ?? null, m.bat_temp_c ?? null, runtime, comm, JSON.stringify(m));
        stored += r.changes;
        const first = (a) => (Array.isArray(a) ? a[0] : null) ?? null;
        st.latest.run(t, comm, m.bat_pct ?? null, m.load_pct ?? null, m.bat_temp_c ?? null, runtime,
          first(m.out_v), first(m.in_v), m.status ?? null, m.fw ?? null, p.device_id, t);
      }
    });
    return { accepted: stored, unknown_devices: unknown };
  }

  /**
   * Store the events. Returns the counts, the events stored just now (`fresh`,
   * in order — the caller notifies for these), and for each replayed event
   * what was delivered for it the first time (`prior`), so a retried POST is
   * answered the same way without anyone being told twice.
   */
  function events(body) {
    validate('events', body);
    let accepted = 0, duplicate = 0;
    const fresh = [];
    const prior = {};
    tx(db, () => {
      for (const e of body.events) {
        const seen = st.seen.get(e.event_id);
        if (seen) { duplicate++; prior[e.event_id] = json(seen.local_notified); continue; }
        const t = ms(e.ts);
        const det = e.detail || {};
        const ln = e.local_notified ? JSON.stringify(e.local_notified) : null;
        const maint = det.maintenance ? 1 : 0;
        st.ev.run(e.event_id, e.alarm_id, t, e.kind, e.title, JSON.stringify(det), ln);
        fresh.push(e);
        const cur = st.alarm.get(e.alarm_id);
        if (e.kind === 'alarm_raise' || (!cur && e.kind === 'alarm_update')) {
          // An update for an alarm we never saw raised (the console came up
          // after the raise) opens it from what the update says.
          if (!cur) st.raise.run(e.alarm_id, e.device_id, e.site_id, e.code, e.severity, e.title, t, t, JSON.stringify(det), ln, maint);
          else st.update.run(e.severity, e.title, t, JSON.stringify(det), ln, maint, e.alarm_id);
        } else if (e.kind === 'alarm_update') {
          st.update.run(e.severity, cur.title || e.title, t, JSON.stringify({ ...JSON.parse(cur.detail || '{}'), ...det }), ln, maint, e.alarm_id);
        } else if (e.kind === 'alarm_clear') {
          if (cur) st.clear.run(t, t, ln, e.alarm_id);
        }
        // kind 'info' is history only.
        accepted++;
      }
    });
    return { accepted, duplicate, fresh, prior };
  }

  /**
   * What the console delivered for one event. The alarm row keeps how the
   * alarm was announced — its raise (or the late raise when a maintenance
   * window ended) — not the later update or clear.
   */
  function recordNotified(ev, ln, { announces = ev.kind === 'alarm_raise' } = {}) {
    const v = JSON.stringify(ln);
    st.evNotified.run(v, ev.event_id);
    if (announces) st.alarmNotified.run(v, ev.alarm_id);
  }

  /** Heartbeat: the contract fields plus, on this internal path only, the forwarder's Portal link state. */
  function heartbeat(nodeId, body) {
    const b = body && typeof body === 'object' ? body : {};
    const keep = {
      version: str(b.version, 32), uptime_s: num(b.uptime_s), queue_depth: num(b.queue_depth),
      last_poll_ok_ratio: num(b.last_poll_ok_ratio), devices_total: num(b.devices_total),
      devices_unreachable: num(b.devices_unreachable), clock: str(b.clock, 32), profile: str(b.profile, 16), os: str(b.os, 64),
      portal: b.portal && typeof b.portal === 'object' ? {
        enabled: !!b.portal.enabled, last_reachable: num(b.portal.last_reachable), last_error: str(b.portal.last_error, 200),
        sent: num(b.portal.sent), rejected: num(b.portal.rejected), queued: num(b.portal.queued),
      } : null,
    };
    st.beat.run(now(), JSON.stringify(keep), nodeId);
    return { ack: true };
  }

  return { authCollector, telemetry, events, recordNotified, heartbeat };
}

const json = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const num =(v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, n) => (v == null ? null : String(v).slice(0, n));

module.exports = { createIngest };
