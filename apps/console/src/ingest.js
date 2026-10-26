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
const { LOCK_NS, LOCKS } = require('./db');
const schema = require('../../../probe-agent/src/contract/schema');

const ms = (iso) => Date.parse(iso);

function createIngest(db, { now = Date.now } = {}) {
  const st = {
    devByContract: (t, id) => t.one('SELECT id, device_id, site_id FROM devices WHERE device_id = ?', id),
    point: (t, ...a) => t.run(`INSERT INTO telemetry (device_id, ts, battery_pct, load_pct, temp_c, runtime_min, comm_ok, m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, ...a),
    latest: (t, ...a) => t.run(`UPDATE devices SET last_ts = ?, comm_ok = ?,
        battery_pct = COALESCE(?, battery_pct), load_pct = COALESCE(?, load_pct), temp_c = COALESCE(?, temp_c),
        runtime_min = COALESCE(?, runtime_min), output_v = COALESCE(?, output_v), input_v = COALESCE(?, input_v),
        ups_status = COALESCE(?, ups_status), firmware = COALESCE(?, firmware)
      WHERE device_id = ? AND (last_ts IS NULL OR last_ts <= ?)`, ...a),
    seen: (t, id) => t.one('SELECT local_notified FROM alarm_events WHERE event_id = ? LIMIT 1', id),
    ev: (t, ...a) => t.run('INSERT INTO alarm_events (event_id, alarm_id, ts, kind, title, detail, local_notified) VALUES (?, ?, ?, ?, ?, ?, ?)', ...a),
    evNotified: (t, ...a) => t.run('UPDATE alarm_events SET local_notified = ? WHERE event_id = ?', ...a),
    alarmNotified: (t, ...a) => t.run('UPDATE alarms SET local_notified = ? WHERE alarm_id = ?', ...a),
    alarm: (t, id) => t.one('SELECT * FROM alarms WHERE alarm_id = ?', id),
    raise: (t, ...a) => t.run(`INSERT INTO alarms (alarm_id, device_id, site_id, code, severity, title, state, raised_at, updated_at, detail, local_notified, maintenance)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`, ...a),
    update: (t, ...a) => t.run(`UPDATE alarms SET severity = ?, title = ?, updated_at = ?, detail = ?, state = 'open', cleared_at = NULL,
      local_notified = COALESCE(?, local_notified), maintenance = ? WHERE alarm_id = ?`, ...a),
    clear: (t, ...a) => t.run(`UPDATE alarms SET state = 'cleared', cleared_at = ?, updated_at = ?, local_notified = COALESCE(?, local_notified) WHERE alarm_id = ?`, ...a),
    collector: (id) => db.one('SELECT * FROM collectors WHERE node_id = ?', id),
    beat: (...a) => db.run('UPDATE collectors SET last_seen = ?, heartbeat = ? WHERE node_id = ?', ...a),
  };

  /** Bearer key check for a collector node; returns the row or null. */
  async function authCollector(nodeId, key) {
    if (!nodeId || !key) return null;
    const c = await st.collector(String(nodeId));
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

  async function telemetry(body) {
    validate('telemetry', body);
    let stored = 0, unknown = 0;
    await db.tx(async (t) => {
      for (const p of body.points) {
        if (!(await st.devByContract(t, p.device_id))) { unknown++; continue; }
        const ts = ms(p.ts);
        const m = p.m || {};
        const runtime = typeof m.runtime_s === 'number' ? m.runtime_s / 60 : null;
        const comm = m.comm_ok === false ? 0 : 1;
        const r = await st.point(t, p.device_id, ts, m.bat_pct ?? null, m.load_pct ?? null, m.bat_temp_c ?? null, runtime, comm, JSON.stringify(m));
        stored += r.changes;
        const first = (a) => (Array.isArray(a) ? a[0] : null) ?? null;
        await st.latest(t, ts, comm, m.bat_pct ?? null, m.load_pct ?? null, m.bat_temp_c ?? null, runtime,
          first(m.out_v), first(m.in_v), m.status ?? null, m.fw ?? null, p.device_id, ts);
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
  async function events(body) {
    validate('events', body);
    let accepted = 0, duplicate = 0;
    const fresh = [];
    const prior = {};
    await db.tx(async (t) => {
      // Both nodes may get the same batch (a collector retrying on the other
      // node): one at a time, so the event_id check below sees the other's rows.
      await t.one('SELECT pg_advisory_xact_lock(?, ?)', LOCK_NS, LOCKS.events);
      for (const e of body.events) {
        const seen = await st.seen(t, e.event_id);
        if (seen) { duplicate++; prior[e.event_id] = json(seen.local_notified); continue; }
        const ts = ms(e.ts);
        const det = e.detail || {};
        const ln = e.local_notified ? JSON.stringify(e.local_notified) : null;
        const maint = det.maintenance ? 1 : 0;
        await st.ev(t, e.event_id, e.alarm_id, ts, e.kind, e.title, JSON.stringify(det), ln);
        fresh.push(e);
        const cur = await st.alarm(t, e.alarm_id);
        if (e.kind === 'alarm_raise' || (!cur && e.kind === 'alarm_update')) {
          // An update for an alarm we never saw raised (the console came up
          // after the raise) opens it from what the update says.
          if (!cur) await st.raise(t, e.alarm_id, e.device_id, e.site_id, e.code, e.severity, e.title, ts, ts, JSON.stringify(det), ln, maint);
          else await st.update(t, e.severity, e.title, ts, JSON.stringify(det), ln, maint, e.alarm_id);
        } else if (e.kind === 'alarm_update') {
          await st.update(t, e.severity, cur.title || e.title, ts, JSON.stringify({ ...JSON.parse(cur.detail || '{}'), ...det }), ln, maint, e.alarm_id);
        } else if (e.kind === 'alarm_clear') {
          if (cur) await st.clear(t, ts, ts, ln, e.alarm_id);
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
  async function recordNotified(ev, ln, { announces = ev.kind === 'alarm_raise' } = {}) {
    const v = JSON.stringify(ln);
    await st.evNotified(db, v, ev.event_id);
    if (announces) await st.alarmNotified(db, v, ev.alarm_id);
  }

  /** Heartbeat: the contract fields plus, on this internal path only, the forwarder's Portal link state. */
  async function heartbeat(nodeId, body) {
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
    await st.beat(now(), JSON.stringify(keep), nodeId);
    return { ack: true };
  }

  return { authCollector, telemetry, events, recordNotified, heartbeat };
}

const json = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const num =(v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, n) => (v == null ? null : String(v).slice(0, n));

module.exports = { createIngest };
