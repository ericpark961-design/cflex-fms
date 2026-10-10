// One alarm = one incident — v5 §2, built on the SQLite store the FMS API serves.
//
// Before this, a P1 alarm inserted a fresh ticket every time it fired and P2
// produced nothing at all. The dedup that existed was on the alarm (same
// device+metric+priority inside 10 minutes), so a flapping device still opened
// a ticket per burst and the workbench would have had several incidents for one
// fault.
//
// Incidents are deduplicated by the deterministic key in incident/state_machine.js
// and enforced by the partial unique index from migration 005: at most one
// active incident per (tenant, dedup_key). A repeat alarm attaches to the open
// incident and appends a timeline row instead.
const sm = require('../incident/state_machine');

const TIMELINE_KINDS = new Set([
  'state_change', 'channel_send', 'channel_inbound', 'snow_sync', 'comment',
  'assign', 'rca', 'alarm_attach', 'triage', 'action', 'dispatch', 'verify',
]);

/** Append one typed timeline event. `body_json` carries the structured payload. */
function addTimeline(db, incidentId, { kind = 'comment', author = 'system', note = '', body = null } = {}) {
  const k = TIMELINE_KINDS.has(kind) ? kind : 'comment';
  const r = db.prepare(`INSERT INTO ticket_notes (ticket_id, author, note, kind, body_json, created_at)
                        VALUES (?,?,?,?,?,?)`)
    .run(incidentId, String(author).slice(0, 128), String(note).slice(0, 4000), k,
      body == null ? null : JSON.stringify(body), Date.now());
  return r.lastInsertRowid;
}

/**
 * Symptom for the dedup key. Must be a short stable identifier, never the free
 * text of the alarm — "Battery critically low (24%)" and "(23%)" are the same
 * fault and have to collapse to one incident.
 */
function symptomOf(alert) {
  return String(alert.metric || alert.message || 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
}

function dedupKeyFor(alert) {
  return sm.makeDedupKey({
    tenantId: alert.tenant_id,
    asset: { type: 'ups', id: String(alert.device_id || '') },
    severity: sm.priorityToSeverity(alert.priority),
    symptom: symptomOf(alert),
  });
}

/**
 * Find or create the incident this alarm belongs to.
 * @returns {{incidentId:number, created:boolean, deduped:boolean, dedupKey:string}}
 */
function ensureIncidentForAlert(db, alert, opts = {}) {
  const device = opts.device || null;
  const severity = sm.priorityToSeverity(alert.priority);
  const dedupKey = dedupKeyFor(alert);
  const now = Date.now();

  const active = db.prepare(`SELECT id FROM tickets
                             WHERE tenant_id=? AND dedup_key=? AND status IN ('open','ack','in_progress')
                             ORDER BY id DESC LIMIT 1`).get(alert.tenant_id, dedupKey);

  if (active) {
    link(db, active.id, alert);
    addTimeline(db, active.id, {
      kind: 'alarm_attach', author: 'system',
      note: `동일 원인 알람 재발 — ${alert.metric || ''} ${alert.value ?? ''}`.trim(),
      body: { alarm_id: alert.id, metric: alert.metric, value: alert.value, threshold: alert.threshold, received_at: alert.received_at },
    });
    if (alert.id) { try { db.prepare('UPDATE alerts SET ticket_id=? WHERE id=? AND ticket_id IS NULL').run(active.id, alert.id); } catch { /* column optional */ } }
    return { incidentId: active.id, created: false, deduped: true, dedupKey };
  }

  const ticketNo = 'INC' + String(now).slice(-9);
  const title = `${device?.label || alert.device_label || alert.device_id || 'UPS'} — ${alert.message || alert.metric || 'alarm'}`;
  const r = db.prepare(`INSERT INTO tickets
      (tenant_id, ticket_no, site, device_id, device_label, priority, domain, title, description,
       status, alert_metric, alert_value, alert_threshold, severity, cbu, source, dedup_key, channels,
       created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?, 'alarm', ?, '[]', ?,?)`)
    .run(alert.tenant_id, ticketNo, device?.site || alert.site || null,
      alert.device_id || null, device?.label || alert.device_label || null,
      alert.priority || 'P3', 'UPS', title.slice(0, 500), (alert.message || '').slice(0, 2000),
      alert.metric || null,
      alert.value != null ? Number(alert.value) : null,
      alert.threshold != null ? Number(alert.threshold) : null,
      severity, device?.cbu || null, dedupKey, now, now);

  const incidentId = r.lastInsertRowid;
  link(db, incidentId, alert);
  addTimeline(db, incidentId, {
    kind: 'state_change', author: 'system', note: 'Detect — 알람 수신으로 인시던트 생성',
    body: { from: null, to: 'open', alarm_id: alert.id, metric: alert.metric, value: alert.value, threshold: alert.threshold },
  });
  if (alert.id) { try { db.prepare('UPDATE alerts SET ticket_id=? WHERE id=?').run(incidentId, alert.id); } catch { /* column optional */ } }
  return { incidentId, created: true, deduped: false, dedupKey };
}

function link(db, incidentId, alert) {
  if (!alert.id) return;
  try {
    db.prepare(`INSERT OR IGNORE INTO incident_alarm_links (incident_id, alarm_id, alarm_source, attached_at)
                VALUES (?,?,'fms',?)`).run(incidentId, alert.id, Date.now());
  } catch (e) { console.warn('[fms-incident] link:', e.message); }
}

/**
 * Guarded state transition. Returns { ok:false, error } rather than throwing, so
 * a route can report "이 상태에서는 불가" on the button that was pressed.
 */
function transition(db, incidentId, to, opts = {}) {
  const { by = 'system', note = '' } = opts;
  const inc = db.prepare('SELECT id, status FROM tickets WHERE id=?').get(incidentId);
  if (!inc) return { ok: false, error: 'incident not found' };
  const from = inc.status || 'open';
  if (from === to) return { ok: true, from, to, unchanged: true };
  if (!sm.canTransition(from, to)) return { ok: false, error: `전이 불가: ${from} → ${to}`, from, to };

  const now = Date.now();
  const sets = ['status=?', 'updated_at=?'];
  const vals = [to, now];
  const stamps = sm.timestampsFor(to);
  if (stamps.ack_at) { sets.push('ack_at=?', 'ack_by=?'); vals.push(now, String(by).slice(0, 128)); }
  if (stamps.resolved_at) { sets.push('resolved_at=?'); vals.push(now); }
  if (stamps.closed_at) { sets.push('closed_at=?'); vals.push(now); }
  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id=?`).run(...vals, incidentId);

  addTimeline(db, incidentId, {
    kind: 'state_change', author: by,
    note: note || `${from} → ${to}`,
    body: { from, to },
  });

  // v5 §1.5 / §3.3: the RCA draft is written when the incident is resolved —
  // that is the point at which there is an outcome to explain. It used to run
  // at detection, before anyone had looked at the fault.
  if (to === 'resolved' && !opts.skipHooks) {
    setImmediate(() => {
      try {
        require('./fms-rca').generateRcaForTicket(incidentId)
          .then(r => {
            if (r?.ok) addTimeline(db, incidentId, { kind: 'rca', author: 'ai', note: r.rca.summary, body: r.rca });
          })
          .catch(e => console.error('[fms-rca]', e.message));
      } catch (e) { console.error('[fms-rca] hook:', e.message); }
    });
  }

  return { ok: true, from, to };
}

module.exports = { ensureIncidentForAlert, addTimeline, transition, dedupKeyFor, symptomOf, TIMELINE_KINDS };
