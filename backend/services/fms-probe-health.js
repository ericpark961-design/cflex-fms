// Probe health — making a dead collector an alarmable fact.
//
// This is the failure that has actually hurt this system. On 2026-08-24 04:58
// the cflex-healthcheck recovery action began restarting production every five
// minutes; it did so 40,103 times before it was stopped on 10/09. For six weeks
// the poller never finished a cycle, so every device went stale, the freshness
// gate turned every card to `nodata`, and nothing anywhere raised its hand. A
// site where the collector is dead looks exactly like a site where nothing is
// wrong.
//
// So: every collector reports in, and silence is an alarm.
//
// `probes` holds enrolment — uuid, key hash, capabilities. `probe_status` holds
// health: the last heartbeat, what the last cycle managed, and how long it took.
// The in-process poller registers here too under 'inproc', because it is the
// collector most of the fleet currently depends on and it was the one that died.
const incident = require('./fms-incident');

const DOWN_AFTER_MS = 10 * 60 * 1000;   // the roadmap's line: 10 minutes of silence
const SWEEP_MS = 60 * 1000;

const now = () => Date.now();

/**
 * Record a heartbeat. Called from POST /v1/probe/heartbeat and by the
 * in-process poller at the end of each cycle.
 *
 * @param db
 * @param hb {probe_id, tenant_id, cbu, label, version, host, poll_ok,
 *            poll_fail, devices, cycle_ms, last_error}
 */
function heartbeat(db, hb = {}) {
  const id = String(hb.probe_id || '').trim();
  if (!id) throw new Error('probe_id required');
  const t = now();
  const existing = db.prepare('SELECT probe_id, down_alerted_at FROM probe_status WHERE probe_id=?').get(id);

  if (existing) {
    db.prepare(`UPDATE probe_status SET
        tenant_id=COALESCE(?,tenant_id), cbu=COALESCE(?,cbu), label=COALESCE(?,label),
        last_seen=?, version=COALESCE(?,version), host=COALESCE(?,host),
        poll_ok=COALESCE(?,poll_ok), poll_fail=COALESCE(?,poll_fail),
        devices=COALESCE(?,devices), cycle_ms=COALESCE(?,cycle_ms),
        last_error=?, updated_at=?
      WHERE probe_id=?`)
      .run(hb.tenant_id ?? null, hb.cbu ?? null, hb.label ?? null,
        t, hb.version ?? null, hb.host ?? null,
        hb.poll_ok ?? null, hb.poll_fail ?? null,
        hb.devices ?? null, hb.cycle_ms ?? null,
        hb.last_error ?? null, t, id);
  } else {
    db.prepare(`INSERT INTO probe_status
        (probe_id, tenant_id, cbu, label, last_seen, version, host,
         poll_ok, poll_fail, devices, cycle_ms, last_error, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, hb.tenant_id ?? null, hb.cbu ?? null, hb.label ?? null,
        t, hb.version ?? null, hb.host ?? null,
        hb.poll_ok ?? 0, hb.poll_fail ?? 0, hb.devices ?? 0,
        hb.cycle_ms ?? null, hb.last_error ?? null, t);
  }

  // Coming back is as much an event as going away: the incident is resolved and
  // the flag cleared, so the next outage alarms again instead of being
  // swallowed as a duplicate.
  if (existing?.down_alerted_at) {
    recovered(db, id);
  }
  return { ok: true, probe_id: id, at: t };
}

/** Clear the down flag and close the open probe-down incident. */
function recovered(db, probeId) {
  const row = db.prepare('SELECT * FROM probe_status WHERE probe_id=?').get(probeId);
  db.prepare('UPDATE probe_status SET down_alerted_at=NULL WHERE probe_id=?').run(probeId);
  const open = db.prepare(`SELECT id FROM tickets
                           WHERE tenant_id=? AND device_id=? AND status IN ('open','ack','in_progress')
                           ORDER BY id DESC LIMIT 1`).get(row?.tenant_id ?? null, `probe-${probeId}`);
  if (!open) return null;
  let r;
  try {
    incident.addTimeline(db, open.id, {
      kind: 'comment', author: 'system',
      note: `프로브 복구 — 하트비트 재수신 (${probeId})`,
    });
    // `by`, not `author` — and skipHooks, because an AI root-cause draft for
    // "the collector came back" is noise, and generating one would put a model
    // call inside a once-a-minute sweep.
    r = incident.transition(db, open.id, 'resolved', { by: 'system', note: '프로브 하트비트 재수신', skipHooks: true });
  } catch (e) {
    // A transition that throws must not take the heartbeat with it: the probe
    // IS back, and that fact has to be recorded either way.
    return { incidentId: open.id, error: e.message };
  }
  // transition() REPORTS refusal rather than throwing it. Ignoring the result
  // left the incident open with a "recovered" note under it — the worst of
  // both, since the screen said down and the timeline said up.
  if (!r?.ok) return { incidentId: open.id, error: r?.error || 'transition refused' };
  return { incidentId: open.id };
}

/**
 * The dead-collector check. Any probe silent for longer than DOWN_AFTER_MS gets
 * one P2 incident — once, not every sweep.
 *
 * @returns {{checked:number, down:string[], raised:object[]}}
 */
function sweep(db, { downAfterMs = DOWN_AFTER_MS, at = now() } = {}) {
  const rows = db.prepare('SELECT * FROM probe_status').all();
  const down = [];
  const raised = [];
  for (const p of rows) {
    const silentFor = at - (p.last_seen || 0);
    if (silentFor < downAfterMs) continue;
    down.push(p.probe_id);
    if (p.down_alerted_at) continue;             // already told someone

    const mins = Math.floor(silentFor / 60000);
    const alert = {
      tenant_id: p.tenant_id,
      // A synthetic id, because the subject is the collector, not a UPS. The
      // asset type below keeps it out of the UPS dedup space.
      device_id: `probe-${p.probe_id}`,
      device_label: p.label || p.probe_id,
      site: p.cbu || null,
      priority: 'P2',
      metric: 'probe_heartbeat',
      message: `프로브 무신호 ${mins}분 — ${p.cbu || '사이트 미지정'} 수집 중단 (${p.label || p.probe_id})`,
      value: mins,
      threshold: Math.floor(downAfterMs / 60000),
      received_at: at,
    };
    const ins = db.prepare(`INSERT INTO alerts
        (tenant_id, device_id, site, priority, metric, message, value, threshold, received_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(alert.tenant_id, alert.device_id, alert.site, alert.priority,
        alert.metric, alert.message, alert.value, alert.threshold, alert.received_at);
    alert.id = ins.lastInsertRowid;

    let inc = null;
    try {
      inc = incident.ensureIncidentForAlert(db, alert, {
        assetType: 'probe',
        domain: 'PROBE',
        device: { label: alert.device_label, cbu: p.cbu, site: p.cbu },
      });
    } catch (e) {
      inc = { error: e.message };
    }
    db.prepare('UPDATE probe_status SET down_alerted_at=? WHERE probe_id=?').run(at, p.probe_id);
    raised.push({ probe_id: p.probe_id, alert_id: alert.id, minutes: mins, ...inc });
  }
  return { checked: rows.length, down, raised };
}

/**
 * What an operator sees. `state` is the answer to "is this site being
 * collected", which is not the same question as "are the devices healthy".
 */
function list(db, tenantId = null, { at = now(), downAfterMs = DOWN_AFTER_MS } = {}) {
  const rows = tenantId == null
    ? db.prepare('SELECT * FROM probe_status ORDER BY cbu, probe_id').all()
    : db.prepare('SELECT * FROM probe_status WHERE tenant_id=? OR tenant_id IS NULL ORDER BY cbu, probe_id').all(tenantId);
  return rows.map(p => {
    const silentFor = at - (p.last_seen || 0);
    const total = (p.poll_ok || 0) + (p.poll_fail || 0);
    return {
      probe_id: p.probe_id, cbu: p.cbu, label: p.label, version: p.version, host: p.host,
      last_seen: p.last_seen, silent_s: Math.floor(silentFor / 1000),
      state: silentFor >= downAfterMs ? 'down' : (p.poll_fail > 0 && p.poll_ok === 0 ? 'blind' : 'online'),
      poll_ok: p.poll_ok || 0, poll_fail: p.poll_fail || 0, devices: p.devices || 0,
      // A probe that is up, reporting, and failing every single device is the
      // state this fleet is actually in, and it is not 'online'. Naming it
      // 'blind' stops a green dot from standing in for data nobody has.
      success_pct: total ? Math.round(((p.poll_ok || 0) / total) * 100) : null,
      cycle_ms: p.cycle_ms, last_error: p.last_error,
      down_alerted_at: p.down_alerted_at,
    };
  });
}

module.exports = { heartbeat, sweep, list, recovered, DOWN_AFTER_MS, SWEEP_MS };
