// KMX workbench demo scenario — 부록 K2.
//
// A site with no collector has no alarms and no metrics, so there is nothing to
// open a workbench on. Rather than seeding plausible-looking rows that then rot
// into "real" data, every row this writes carries simulated=1: excluded from
// KPIs, SLA, fleet-live and the monthly report, chipped in the UI, and removable
// with one DELETE.
//
// Alarm text and numbers come from kmx_ccr_topology.json's `alarms` — the same
// file the offline demo HTML reads — so the two cannot drift (부록 K3).
//
// What it does NOT do: hard-code the triage answer. The alarms are written, the
// normal insert hook runs, and the model is expected to reach "CRAC-2 팬 감속으로
// 인한 국부 핫스팟" from the evidence (a P2 on CRAC-2 fourteen minutes earlier,
// same room, a rising temperature curve). If it does not, the prompt or the
// context collection is what needs fixing.
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, 'kmx_ccr_topology.json');
const MIN = 60 * 1000;

const ledger = () => JSON.parse(fs.readFileSync(LEDGER, 'utf8'));

/** "11:02" → minutes before the latest alarm in the ledger, so times stay relative. */
function offsetsFrom(alarms) {
  const mins = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const vals = alarms.map(a => mins(a.received_at)).filter(v => v != null);
  const latest = vals.length ? Math.max(...vals) : 0;
  return (hhmm) => {
    const v = mins(hhmm);
    return v == null ? 0 : (latest - v);          // minutes before "now"
  };
}

const CURVES = {
  // B07-UPS climbing into the hotspot, then recovering after the fix so Verify
  // has something to confirm (부록 K2: "+30분 복귀 구간도 생성").
  'B07-UPS': {
    from: -120, to: 30, step: 5,
    at: (t) => {
      // t in minutes relative to the alarm (0 = alarm time)
      if (t <= 0) {
        const k = (t + 120) / 120;                            // 0 → 1 over the 2h ramp
        return { temp_c: 24 + 5.4 * k, load_pct: 60 + 28 * k, battery_pct: 100 - 29 * k, runtime_min: 31 - 22 * k };
      }
      const k = Math.min(1, t / 30);                          // recovery over 30 min
      return { temp_c: 29.4 - 5.4 * k, load_pct: 88 - 26 * k, battery_pct: 71 + 27 * k, runtime_min: 9 + 20 * k };
    },
  },
  // The control: a healthy unit in the same room, so "the whole room is hot" is
  // a hypothesis the evidence can actually rule out.
  'KMX-UPS-01': {
    from: -120, to: 30, step: 5,
    at: (t) => ({ temp_c: 24.1 + Math.sin(t / 25) * 0.3, load_pct: 48 + Math.sin(t / 17) * 1.5, battery_pct: 100, runtime_min: 31 }),
  },
};

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Create the scenario. Returns a report rather than printing, so the route can
 * hand it back to the caller.
 */
function start(db, { tenantId = 10, cbu = 'KMX', now = Date.now() } = {}) {
  const doc = ledger();
  const alarms = doc.alarms || [];
  if (!alarms.length) throw new Error('kmx_ccr_topology.json carries no alarms');
  const before = offsetsFrom(alarms);

  const out = { metrics: 0, alerts: 0, incidents: [], skipped: [], at: now };

  // ── metrics ───────────────────────────────────────────────────────
  for (const [label, curve] of Object.entries(CURVES)) {
    const dev = db.prepare('SELECT id FROM ups_devices WHERE tenant_id=? AND label=? AND cbu=?').get(tenantId, label, cbu);
    if (!dev) { out.skipped.push(`metrics ${label}: not registered (run the ledger import first)`); continue; }
    for (let t = curve.from; t <= curve.to; t += curve.step) {
      const v = curve.at(t);
      db.prepare(`INSERT INTO ups_metrics (device_id, ts, battery_pct, load_pct, temp_c, runtime_min, input_v, output_v, status, simulated)
                  VALUES (?,?,?,?,?,?,?,?,?,1)`)
        .run(dev.id, now + t * MIN, r1(v.battery_pct), r1(v.load_pct), r1(v.temp_c), r1(v.runtime_min), 230, 230,
          v.temp_c >= 29 ? 'critical' : v.temp_c >= 27 ? 'warn' : 'ok');
      out.metrics++;
    }
    // Leave the device row reading its last simulated sample, so the 3D scene
    // and the device list show the scenario instead of a blank panel. These are
    // the only writes to a real row; reset() puts them back to nodata.
    const last = curve.at(0);
    db.prepare(`UPDATE ups_devices SET battery_pct=?, load_pct=?, temp_c=?, runtime_min=?, status=?, last_polled=?, updated_at=? WHERE id=?`)
      .run(r1(last.battery_pct), r1(last.load_pct), r1(last.temp_c), r1(last.runtime_min),
        last.temp_c >= 29 ? 'critical' : 'ok', now, now, dev.id);
  }

  // ── alarms ────────────────────────────────────────────────────────
  for (const a of alarms) {
    const minsBefore = before(a.received_at);
    const ts = now - minsBefore * MIN;

    // A ledger alarm names either a device (ups_devices or fms_devices) or an
    // object (a CRAC, a leak zone). Object alarms go in with object_id set.
    let deviceId = null, objectId = null, site = null;
    if (a.device) {
      const up = db.prepare('SELECT id, site FROM ups_devices WHERE tenant_id=? AND label=?').get(tenantId, a.device);
      if (up) { deviceId = `ups-${up.id}`; site = up.site; }
      else {
        const fd = db.prepare('SELECT id FROM fms_devices WHERE tenant_id=? AND label=?').get(tenantId, a.device);
        if (fd) deviceId = `dev-${fd.id}`;
      }
    }
    if (a.object) {
      const obj = db.prepare(`SELECT r.id FROM fms_racks r JOIN fms_rooms ro ON ro.id=r.room_id
                              WHERE r.tenant_id=? AND r.name=? AND ro.cbu=?`).get(tenantId, a.object, cbu);
      if (obj) objectId = obj.id;
    }
    if (!deviceId && !objectId) { out.skipped.push(`alarm ${a.id}: neither device "${a.device || '—'}" nor object "${a.object || '—'}" exists`); continue; }
    // alerts.device_id is NOT NULL, so an alarm raised on a ledger object gets a
    // synthetic 'obj-<id>' there while object_id carries the real reference. The
    // ups_devices join simply does not match it, and the object join supplies
    // the name — which is what the alarm list and workbench read.
    if (!deviceId) deviceId = `obj-${objectId}`;

    const ins = db.prepare(`INSERT INTO alerts (tenant_id, device_id, site, priority, metric, message, value, threshold, received_at, object_id, simulated)
                            VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
      .run(tenantId, deviceId, site, a.priority, a.metric || null, a.message || '',
        a.value != null ? Number(a.value) : null, a.threshold != null ? Number(a.threshold) : null,
        ts, objectId);
    const alertId = ins.lastInsertRowid;
    out.alerts++;

    // P1/P2 take the normal path: dedup, incident, timeline, then triage off
    // the request. Nothing here is special-cased for the demo.
    if (a.priority === 'P1' || a.priority === 'P2') {
      const incident = require('../services/fms-incident');
      const row = {
        id: alertId, tenant_id: tenantId, device_id: deviceId,
        device_label: a.device || a.object, site,
        priority: a.priority, metric: a.metric || null, message: a.message || '',
        value: a.value ?? null, threshold: a.threshold ?? null, received_at: ts,
      };
      const res = incident.ensureIncidentForAlert(db, row, { device: { cbu, site } });
      db.prepare('UPDATE tickets SET simulated=1, cbu=? WHERE id=?').run(cbu, res.incidentId);
      out.incidents.push({ alarm: a.id, incident_id: res.incidentId, created: res.created, deduped: res.deduped });
    }
  }
  return out;
}

/** Remove everything the scenario created, and put the two devices back to nodata. */
function reset(db, { tenantId = 10, cbu = 'KMX' } = {}) {
  const out = {};
  const ids = db.prepare('SELECT id FROM tickets WHERE tenant_id=? AND COALESCE(simulated,0)=1').all(tenantId).map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM ticket_notes WHERE ticket_id=?').run(id);
    db.prepare('DELETE FROM incident_alarm_links WHERE incident_id=?').run(id);
    try { db.prepare('DELETE FROM fms_dispatch WHERE incident_id=?').run(id); } catch { /* pre-005 */ }
    try { db.prepare('DELETE FROM fms_triage_feedback WHERE incident_id=?').run(id); } catch { /* pre-005 */ }
    try { db.prepare('DELETE FROM fms_ai_log WHERE incident_id=?').run(id); } catch { /* pre-005 */ }
  }
  out.incidents = db.prepare('DELETE FROM tickets WHERE tenant_id=? AND COALESCE(simulated,0)=1').run(tenantId).changes;
  out.alerts = db.prepare('DELETE FROM alerts WHERE tenant_id=? AND COALESCE(simulated,0)=1').run(tenantId).changes;
  out.metrics = db.prepare(`DELETE FROM ups_metrics WHERE COALESCE(simulated,0)=1
                            AND device_id IN (SELECT id FROM ups_devices WHERE tenant_id=? AND cbu=?)`).run(tenantId, cbu).changes;
  // The live rows the scenario wrote go back to "no collector has reported".
  out.devices = db.prepare(`UPDATE ups_devices SET status='nodata', last_polled=NULL,
                              battery_pct=NULL, load_pct=NULL, temp_c=NULL, runtime_min=NULL
                            WHERE tenant_id=? AND cbu=? AND polling_enabled=0`).run(tenantId, cbu).changes;
  return out;
}

module.exports = { start, reset, CURVES, offsetsFrom };

// CLI: node backend/seed/kmx_demo_scenario.js [--db path] [--reset] [--tenant 10]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const file = arg('--db', process.env.FMS_DB || '/opt/cflex-v2/cflex-api/data/cflex.db');
  let raw;
  try { raw = new (require('better-sqlite3'))(file); }
  catch { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(file); raw = { prepare: (q) => d.prepare(q), exec: (q) => d.exec(q) }; }
  const db = { prepare: (q) => { const st = raw.prepare(q); return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) }; }, exec: (q) => raw.exec(q) };
  const tenantId = parseInt(arg('--tenant', '10'), 10);
  const r = argv.includes('--reset') ? reset(db, { tenantId }) : start(db, { tenantId });
  console.log(JSON.stringify(r, null, 2));
}
