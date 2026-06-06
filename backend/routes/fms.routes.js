// /v1/fms/* — FMS API (EcoStruxure IT Expert-inspired structure)
const express = require('express');
const router = express.Router();
const db = require('../config/database');

router.use(express.json({ limit: '2mb' }));

function tenantOf(req) {
  if (!req.user) return null;
  if (req.user.role === 'super_admin' || req.user.role === 'admin') {
    return req.query.tenant_id ? parseInt(req.query.tenant_id, 10) : (req.user.tenantId || null);
  }
  return req.user.tenantId || null;
}

// CBU filter helper. Returns { clause, params } pair to splice into SQL.
function cbuFilter(req) {
  const cbu = (req.query.cbu || '').trim();
  if (!cbu || cbu === 'all') return { clause: '', params: [] };
  return { clause: ' AND cbu=?', params: [cbu] };
}

// ─── GET /v1/fms/summary ───────────────────────────────────────────
router.get('/summary', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const now = Date.now();
  const cf = cbuFilter(req);
  const cnt = (sql, ...extra) => db.prepare(sql + cf.clause).get(tid, ...extra, ...cf.params).c;

  const total = cnt('SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND decommissioned_at IS NULL');
  const polling = cnt('SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND polling_enabled=1');
  const online = cnt('SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND polling_enabled=1 AND last_polled > ?', now - 5*60*1000);
  const unreachable = cnt("SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND status='unreachable'");
  const critical = cnt("SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND status='critical'");
  const warn = cnt("SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND status='warn'");
  const ok = cnt("SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND status='ok'");
  const alerts24h = db.prepare('SELECT COUNT(*) c FROM alerts WHERE tenant_id=? AND received_at > ?').get(tid, now - 24*3600*1000).c;
  const openTickets = db.prepare("SELECT COUNT(*) c FROM tickets WHERE tenant_id=? AND status NOT IN ('closed','resolved')").get(tid).c;
  const p1 = db.prepare("SELECT COUNT(*) c FROM tickets WHERE tenant_id=? AND priority='P1' AND status NOT IN ('closed','resolved')").get(tid).c;
  const sites = cnt("SELECT COUNT(DISTINCT location) c FROM ups_devices WHERE tenant_id=? AND location != ''");

  // CBU breakdown — always returns full list regardless of filter
  const cbuList = db.prepare(`SELECT COALESCE(cbu,'unknown') AS cbu, COUNT(*) AS total,
                                    SUM(CASE WHEN polling_enabled=1 THEN 1 ELSE 0 END) AS polling,
                                    SUM(CASE WHEN status='critical' OR status='unreachable' THEN 1 ELSE 0 END) AS critical,
                                    SUM(CASE WHEN status='warn' THEN 1 ELSE 0 END) AS warn
                             FROM ups_devices WHERE tenant_id=? AND decommissioned_at IS NULL
                             GROUP BY cbu ORDER BY cbu`).all(tid);

  res.json({
    ok: true,
    devices: { total, polling, online, unreachable, critical, warn, normal: ok },
    alerts_24h: alerts24h,
    tickets: { open: openTickets, p1 },
    sites,
    cbu_list: cbuList,
  });
});

// ─── GET /v1/fms/fleet-live ── 1-min buckets, fleet-wide avg/max ───
router.get('/fleet-live', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const minutes = Math.max(5, Math.min(180, parseInt(req.query.minutes || '30', 10)));
  const cutoff = Date.now() - minutes * 60 * 1000;
  const cf = cbuFilter(req);

  const fleet = db.prepare(`SELECT COUNT(*) total,
                                   SUM(CASE WHEN polling_enabled=1 THEN 1 ELSE 0 END) polling,
                                   SUM(CASE WHEN status='critical' OR status='unreachable' THEN 1 ELSE 0 END) critical,
                                   SUM(CASE WHEN status='warn' THEN 1 ELSE 0 END) warn,
                                   AVG(CASE WHEN polling_enabled=1 THEN battery_pct END) avg_battery,
                                   AVG(CASE WHEN polling_enabled=1 THEN load_pct END) avg_load,
                                   MAX(CASE WHEN polling_enabled=1 THEN temp_c END) max_temp,
                                   MAX(last_polled) last_polled
                            FROM ups_devices WHERE tenant_id=? AND decommissioned_at IS NULL` + cf.clause).get(tid, ...cf.params);

  const rows = db.prepare(`SELECT (m.ts / 60000) * 60000 AS bucket,
                                  AVG(m.battery_pct) AS avg_battery,
                                  AVG(m.load_pct)    AS avg_load,
                                  MAX(m.temp_c)      AS max_temp,
                                  COUNT(DISTINCT m.device_id) AS devices
                           FROM ups_metrics m
                           JOIN ups_devices d ON d.id = m.device_id
                           WHERE d.tenant_id = ? AND m.ts > ?` + cf.clause.replace('cbu', 'd.cbu') + `
                           GROUP BY bucket ORDER BY bucket ASC`).all(tid, cutoff, ...cf.params);

  res.json({ ok: true, minutes, fleet, series: rows, generated_at: Date.now() });
});

// ─── GET /v1/fms/floor ── hierarchical tree: Location → Room → Rack → Device ──
router.get('/floor', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const cf = cbuFilter(req);
  const rows = db.prepare(`SELECT id, label, location, room, rack, status, health_score, battery_pct, load_pct, temp_c, last_polled
                           FROM ups_devices WHERE tenant_id=? AND decommissioned_at IS NULL` + cf.clause).all(tid, ...cf.params);
  // Build tree
  const tree = {};
  for (const r of rows) {
    const loc = r.location || 'Unknown Location';
    const room = r.room || 'Default Room';
    const rack = r.rack || 'Default Rack';
    if (!tree[loc]) tree[loc] = { name: loc, rooms: {}, count: 0, critical: 0, warn: 0, ok: 0, lat: r.lat, lng: r.lng };
    if (!tree[loc].rooms[room]) tree[loc].rooms[room] = { name: room, racks: {}, count: 0, critical: 0, warn: 0, ok: 0 };
    if (!tree[loc].rooms[room].racks[rack]) tree[loc].rooms[room].racks[rack] = { name: rack, devices: [], count: 0, critical: 0, warn: 0, ok: 0 };
    tree[loc].rooms[room].racks[rack].devices.push(r);
    tree[loc].rooms[room].racks[rack].count++;
    tree[loc].rooms[room].count++;
    tree[loc].count++;
    if (r.status === 'critical' || r.status === 'unreachable') {
      tree[loc].critical++; tree[loc].rooms[room].critical++; tree[loc].rooms[room].racks[rack].critical++;
    } else if (r.status === 'warn') {
      tree[loc].warn++; tree[loc].rooms[room].warn++; tree[loc].rooms[room].racks[rack].warn++;
    } else if (r.status === 'ok') {
      tree[loc].ok++; tree[loc].rooms[room].ok++; tree[loc].rooms[room].racks[rack].ok++;
    }
  }
  res.json({ ok: true, tree });
});

// ─── GET /v1/fms/sites-map ── sites grouped by CBU for the Alarm Map view ──
// Each CBU = one campus pin. Sub-locations are listed in `buildings`.
const CBU_ADDRESS = {
  HMA:     { full: '10550 Talbert Ave, Fountain Valley, CA 92708', display: 'Fountain Valley, CA', company: 'Hyundai Motor America' },
  KUS:     { full: '111 Peters Canyon Rd, Irvine, CA 92606',       display: 'Irvine, CA',          company: 'Kia America' },
  HAEA_HQ: { full: '2300 Main St, Irvine, CA 92614',                display: 'Irvine, CA',          company: 'HAEA HQ' },
};
router.get('/sites-map', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const rows = db.prepare(`SELECT cbu, AVG(lat) AS lat, AVG(lng) AS lng,
                                  COUNT(*) AS total,
                                  SUM(CASE WHEN status='critical' OR status='unreachable' THEN 1 ELSE 0 END) AS critical,
                                  SUM(CASE WHEN status='warn' THEN 1 ELSE 0 END) AS warn,
                                  SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok
                           FROM ups_devices
                           WHERE tenant_id=? AND cbu IS NOT NULL AND lat IS NOT NULL
                           GROUP BY cbu`).all(tid);
  const buildingsByCbu = db.prepare(`SELECT cbu, location, COUNT(*) AS total
                                     FROM ups_devices
                                     WHERE tenant_id=? AND cbu IS NOT NULL AND location != ''
                                     GROUP BY cbu, location`).all(tid);
  const sites = rows.map(r => {
    const addr = CBU_ADDRESS[r.cbu] || { full: '—', display: '—', company: r.cbu };
    const buildings = buildingsByCbu.filter(b => b.cbu === r.cbu).map(b => ({ name: b.location, total: b.total }));
    return {
      name: r.cbu.replace('_', ' '),
      cbu: r.cbu,
      company: addr.company,
      address: addr.full,
      city: addr.display,
      lat: r.lat, lng: r.lng,
      total: r.total, critical: r.critical, warn: r.warn, ok: r.ok,
      buildings,
    };
  });
  res.json({ ok: true, sites });
});

// ─── GET /v1/fms/assets ─────────────────────────────────────────
router.get('/assets', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const cf = cbuFilter(req);
  const rows = db.prepare(`SELECT id, label, location, room, rack, ip, vendor, model, status, health_score,
                                  battery_pct, load_pct, temp_c, runtime_min, output_v, input_v, output_status, battery_status,
                                  last_polled, polling_enabled, consecutive_fails, poll_error, criticality, muted_until, cbu
                           FROM ups_devices WHERE tenant_id=? AND decommissioned_at IS NULL` + cf.clause + `
                           ORDER BY label`).all(tid, ...cf.params);
  res.json({ ok: true, count: rows.length, assets: rows });
});

// ─── GET /v1/fms/assets/:id ─────────────────────────────────────
router.get('/assets/:id', (req, res) => {
  const tid = tenantOf(req); const id = parseInt(req.params.id, 10);
  const asset = db.prepare('SELECT * FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tid);
  if (!asset) return res.status(404).json({ error: 'not found' });
  const range = (req.query.range || '24h').toLowerCase();
  const rangeMs = range === '30d' ? 30*24*3600*1000 : range === '7d' ? 7*24*3600*1000 : 24*3600*1000;
  const metrics = db.prepare(`SELECT ts, battery_pct, load_pct, temp_c, runtime_min, input_v, output_v, health_score
                              FROM ups_metrics WHERE device_id=? AND ts > ? ORDER BY ts ASC`).all(id, Date.now() - rangeMs);
  const alerts = db.prepare(`SELECT id, priority, metric, message, value, threshold, received_at
                             FROM alerts WHERE tenant_id=? AND device_id=? ORDER BY received_at DESC LIMIT 30`).all(tid, 'ups-' + id);
  const override = db.prepare("SELECT * FROM ups_thresholds WHERE device_id=?").get(id);
  const T = override || { battery_warn: 60, battery_critical: 30, load_warn: 75, load_critical: 90, temp_warn: 38, temp_critical: 45, runtime_warn: 15, runtime_critical: 5 };
  const thresholds = {
    battery_pct: { critical: T.battery_critical, warn: T.battery_warn, direction: "below" },
    load_pct:    { critical: T.load_critical,    warn: T.load_warn,    direction: "above" },
    temp_c:      { critical: T.temp_critical,    warn: T.temp_warn,    direction: "above" },
    runtime_min: { critical: T.runtime_critical, warn: T.runtime_warn, direction: "below" },
  };
  res.json({ ok: true, asset, metrics, alerts, range, thresholds });
});

// ─── GET /v1/fms/alerts ─────────────────────────────────────────
router.get('/alerts', (req, res) => {
  const tid = tenantOf(req);
  const hours = parseInt(req.query.hours || '24', 10);
  const rows = db.prepare(`SELECT a.id, a.device_id, a.site, a.priority, a.metric, a.message, a.value, a.threshold, a.received_at,
                                  d.label AS device_label, d.room, d.rack, d.muted_until
                           FROM alerts a
                           LEFT JOIN ups_devices d ON ('ups-' || d.id) = a.device_id
                           WHERE a.tenant_id=? AND a.received_at > ?
                           ORDER BY a.received_at DESC LIMIT 300`).all(tid, Date.now() - hours*3600*1000);
  // Recurring detection: same device + metric ≥ 3 occurrences
  const counts = {};
  rows.forEach(r => { const k = r.device_id + ':' + r.metric; counts[k] = (counts[k] || 0) + 1; });
  rows.forEach(r => { r.recurring = counts[r.device_id + ':' + r.metric] >= 3; });
  res.json({ ok: true, count: rows.length, alerts: rows });
});

// ─── POST /v1/fms/devices/:id/mute ── mute device alerts ───────────
router.post('/devices/:id/mute', (req, res) => {
  const tid = tenantOf(req); const id = parseInt(req.params.id, 10);
  const hours = parseInt(req.body?.hours || '1', 10);
  const reason = (req.body?.reason || 'manual mute').slice(0, 200);
  if (hours < 1 || hours > 168) return res.status(400).json({ error: 'hours 1–168' });
  const until = Date.now() + hours * 3600 * 1000;
  const r = db.prepare('UPDATE ups_devices SET muted_until=?, muted_reason=? WHERE id=? AND tenant_id=?').run(until, reason, id, tid);
  if (r.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, muted_until: until, hours });
});

// ─── POST /v1/fms/devices/:id/unmute ─────────────────────────────
router.post('/devices/:id/unmute', (req, res) => {
  const tid = tenantOf(req); const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE ups_devices SET muted_until=NULL, muted_reason=NULL WHERE id=? AND tenant_id=?').run(id, tid);
  res.json({ ok: true });
});

// ─── GET /v1/fms/tickets ────────────────────────────────────────
router.get('/tickets', (req, res) => {
  const tid = tenantOf(req); const status = req.query.status;
  let q = `SELECT id, ticket_no, site, device_id, device_label, priority, title, status, assignee, created_at, updated_at, resolved_at
           FROM tickets WHERE tenant_id=?`;
  const params = [tid];
  if (status === 'open') q += " AND status NOT IN ('closed','resolved')";
  else if (status) { q += ' AND status=?'; params.push(status); }
  q += ' ORDER BY created_at DESC LIMIT 200';
  res.json({ ok: true, tickets: db.prepare(q).all(...params) });
});

// ─── GET /v1/fms/reports/monthly ────────────────────────────────
router.get('/reports/monthly', (req, res) => {
  const tid = tenantOf(req);
  const year = parseInt(req.query.year || new Date().getFullYear(), 10);
  const month = parseInt(req.query.month || (new Date().getMonth() + 1), 10);
  const start = new Date(year, month - 1, 1).getTime();
  const end = new Date(year, month, 1).getTime();
  const tickets = db.prepare(`SELECT priority, mttr_seconds, created_at, resolved_at FROM tickets
                              WHERE tenant_id=? AND created_at >= ? AND created_at < ?`).all(tid, start, end);
  const resolved = tickets.filter(t => t.resolved_at);
  const avgMttrSec = resolved.length ? Math.round(resolved.reduce((s,t)=>s+(t.mttr_seconds||0),0)/resolved.length) : null;
  const alertsCount = db.prepare(`SELECT COUNT(*) c FROM alerts WHERE tenant_id=? AND received_at >= ? AND received_at < ?`).get(tid, start, end).c;
  const totalDevices = db.prepare(`SELECT COUNT(*) c FROM ups_devices WHERE tenant_id=? AND polling_enabled=1`).get(tid).c;
  res.json({
    ok: true, year, month,
    devices_polled: totalDevices,
    tickets_total: tickets.length,
    tickets_p1: tickets.filter(t => t.priority === 'P1').length,
    tickets_resolved: resolved.length,
    avg_mttr_seconds: avgMttrSec,
    alerts_count: alertsCount,
  });
});


// ─── PUT /v1/fms/assets/:id ── update device fields ──────────────
router.put('/assets/:id', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const id = parseInt(req.params.id, 10);
  const cur = db.prepare('SELECT id, tenant_id FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tid);
  if (!cur) return res.status(404).json({ error: 'not found' });

  const ALLOWED = [
    'label', 'ip', 'snmp_community', 'snmp_port', 'snmp_version',
    'snmp_v3_user', 'snmp_v3_auth_protocol', 'snmp_v3_auth_password',
    'snmp_v3_priv_protocol', 'snmp_v3_priv_password',
    'location', 'room', 'rack', 'lat', 'lng',
    'criticality', 'polling_enabled', 'polling_interval_sec', 'oid_profile',
    'vendor', 'model', 'serial',
  ];
  const sets = [], vals = [];
  for (const k of ALLOWED) {
    if (req.body[k] === undefined) continue;
    sets.push(`${k}=?`);
    let v = req.body[k];
    if (k === 'polling_enabled') v = v ? 1 : 0;
    if (k === 'snmp_port' || k === 'polling_interval_sec') v = parseInt(v, 10) || null;
    if (k === 'lat' || k === 'lng') v = v === '' || v == null ? null : parseFloat(v);
    vals.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  sets.push('updated_at=?'); vals.push(Date.now());
  vals.push(id, tid);
  db.prepare(`UPDATE ups_devices SET ${sets.join(', ')} WHERE id=? AND tenant_id=?`).run(...vals);
  const updated = db.prepare(`SELECT id, label, ip, snmp_community, snmp_port, snmp_version, location, room, rack, lat, lng,
                                     criticality, polling_enabled, polling_interval_sec, vendor, model, serial, oid_profile
                              FROM ups_devices WHERE id=?`).get(id);
  res.json({ ok: true, asset: updated });
});

// ─── POST /v1/fms/assets/bulk-import ── upsert by label ──────────
router.post('/assets/bulk-import', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'rows array required' });

  const now = Date.now();
  const findByLabel = db.prepare('SELECT id FROM ups_devices WHERE tenant_id=? AND label=?');
  const insert = db.prepare(`INSERT INTO ups_devices
    (tenant_id, label, ip, snmp_community, snmp_port, snmp_version, location, room, rack, criticality, polling_enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE ups_devices SET ip=?, snmp_community=?, snmp_port=?, snmp_version=?,
                             location=?, room=?, rack=?, criticality=COALESCE(?,criticality), polling_enabled=?, updated_at=?
                             WHERE id=?`);
  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.label || !r.ip) { skipped++; errors.push({ row: i, reason: 'label and ip required' }); continue; }
      const label = String(r.label).trim();
      const ip = String(r.ip).trim();
      const community = String(r.snmp_community || 'public').trim();
      const port = parseInt(r.snmp_port || 161, 10);
      const version = String(r.snmp_version || 'v2c').trim();
      const location = String(r.location || '').trim();
      const room = String(r.room || '').trim();
      const rack = String(r.rack || '').trim();
      const criticality = r.criticality ? String(r.criticality).trim() : null;
      const enabled = r.polling_enabled === undefined || r.polling_enabled === '' || r.polling_enabled
        ? (r.polling_enabled === 0 || r.polling_enabled === '0' || r.polling_enabled === false ? 0 : 1) : 1;

      const existing = findByLabel.get(tid, label);
      if (existing) {
        update.run(ip, community, port, version, location, room, rack, criticality, enabled, now, existing.id);
        updated++;
      } else {
        insert.run(tid, label, ip, community, port, version, location, room, rack, criticality || 'routine', enabled, now, now);
        created++;
      }
    }
  });
  try { tx(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, created, updated, skipped, errors: errors.slice(0, 20), total: rows.length });
});

// ─── GET /v1/fms/assets/:id/thresholds ─── per-device override ───
router.get('/assets/:id/thresholds', (req, res) => {
  const tid = tenantOf(req); const id = parseInt(req.params.id, 10);
  const owner = db.prepare('SELECT id FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tid);
  if (!owner) return res.status(404).json({ error: 'not found' });
  const row = db.prepare('SELECT * FROM ups_thresholds WHERE device_id=?').get(id);
  const defaults = {
    battery_warn: 60, battery_critical: 30,
    load_warn: 75, load_critical: 90,
    temp_warn: 38, temp_critical: 45,
    runtime_warn: 15, runtime_critical: 5,
  };
  res.json({ ok: true, thresholds: row || { device_id: id, ...defaults }, defaults, custom: !!row });
});

// ─── PUT /v1/fms/assets/:id/thresholds ── upsert override ────────
router.put('/assets/:id/thresholds', (req, res) => {
  const tid = tenantOf(req); const id = parseInt(req.params.id, 10);
  const owner = db.prepare('SELECT id FROM ups_devices WHERE id=? AND tenant_id=?').get(id, tid);
  if (!owner) return res.status(404).json({ error: 'not found' });

  const f = (k) => req.body[k] === '' || req.body[k] == null ? null : parseFloat(req.body[k]);
  const battery_warn = f('battery_warn'), battery_critical = f('battery_critical');
  const load_warn = f('load_warn'), load_critical = f('load_critical');
  const temp_warn = f('temp_warn'), temp_critical = f('temp_critical');
  const runtime_warn = f('runtime_warn'), runtime_critical = f('runtime_critical');

  // If all null → delete override (revert to defaults)
  const allNull = [battery_warn, battery_critical, load_warn, load_critical, temp_warn, temp_critical, runtime_warn, runtime_critical].every(v => v == null);
  if (allNull) {
    db.prepare('DELETE FROM ups_thresholds WHERE device_id=?').run(id);
    return res.json({ ok: true, custom: false });
  }

  db.prepare(`INSERT INTO ups_thresholds (device_id, battery_warn, battery_critical, load_warn, load_critical, temp_warn, temp_critical, runtime_warn, runtime_critical, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(device_id) DO UPDATE SET
                battery_warn=excluded.battery_warn, battery_critical=excluded.battery_critical,
                load_warn=excluded.load_warn, load_critical=excluded.load_critical,
                temp_warn=excluded.temp_warn, temp_critical=excluded.temp_critical,
                runtime_warn=excluded.runtime_warn, runtime_critical=excluded.runtime_critical,
                updated_at=excluded.updated_at`)
    .run(id, battery_warn, battery_critical, load_warn, load_critical, temp_warn, temp_critical, runtime_warn, runtime_critical, Date.now());
  res.json({ ok: true, custom: true });
});



// ─── POST /v1/fms/tickets/from-alert ── create ticket from alert ──
router.post('/tickets/from-alert', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const alertId = parseInt(req.body?.alert_id, 10);
  if (!alertId) return res.status(400).json({ error: 'alert_id required' });
  const alert = db.prepare('SELECT * FROM alerts WHERE id=? AND tenant_id=?').get(alertId, tid);
  if (!alert) return res.status(404).json({ error: 'alert not found' });

  const TicketModel = require('../models/ticket.model');
  const numericId = parseInt(String(alert.device_id || '').replace(/^ups-/, ''), 10);
  const device = numericId ? db.prepare('SELECT label, location, room, rack FROM ups_devices WHERE id=?').get(numericId) : null;

  const titleOverride = (req.body?.title || '').trim();
  const noteOverride = (req.body?.note || '').trim();
  const row = TicketModel.create(tid, {
    site: alert.site || device?.location || '',
    deviceId: alert.device_id,
    deviceLabel: device?.label || alert.device_id,
    priority: alert.priority || 'P3',
    domain: 'UPS',
    title: titleOverride || `[${alert.priority}] ${device?.label || alert.device_id} · ${alert.message || alert.metric || 'alert'}`,
    description: [
      `Alert ID: ${alert.id}`,
      device ? `Device: ${device.label} · ${device.room || ''} · ${device.rack || ''}` : '',
      alert.metric ? `Metric: ${alert.metric}` : '',
      alert.value != null ? `Value: ${alert.value}` : '',
      alert.threshold != null ? `Threshold: ${alert.threshold}` : '',
      noteOverride ? '\n' + noteOverride : '',
    ].filter(Boolean).join('\n'),
    metric: alert.metric,
    value: alert.value,
    threshold: alert.threshold,
    healthScore: null,
    assignee: req.body?.assignee || null,
  });

  // Link alert → ticket so future opens find it. alerts table may not have
  // a ticket_id col; if not, ignore silently.
  try {
    db.prepare('UPDATE alerts SET ticket_id=? WHERE id=?').run(row.id, alertId);
  } catch (_) { /* column may not exist */ }

  // Fire-and-forget AI RCA for P1
  if (row.priority === 'P1') {
    setImmediate(() => {
      try {
        require('../services/fms-rca').generateRcaForTicket(row.id)
          .then(r => console.log('[fms-rca]', row.id, r.ok ? 'OK' : ('SKIP/ERR ' + r.error)))
          .catch(e => console.error('[fms-rca]', e.message));
      } catch (e) { console.error('[fms-rca] hook:', e.message); }
    });
  }

  res.status(201).json({ ok: true, ticket: row });
});

// ─── GET /v1/fms/tickets/:id ── ticket + RCA (FMS scope) ──────────
router.get('/tickets/:id', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT * FROM tickets WHERE id=? AND tenant_id=?').get(id, tid);
  if (!t) return res.status(404).json({ error: 'not found' });
  let actions = [];
  try { if (t.rca_actions) actions = JSON.parse(t.rca_actions); } catch (_) {}
  const aiEnabled = (() => {
    try { return require('/opt/cflex-shared/ai-toggle').isEnabled(); } catch { return false; }
  })();
  res.json({
    ok: true, ticket: t,
    rca: t.rca_summary ? {
      summary: t.rca_summary, actions, confidence: t.rca_confidence,
      model: t.rca_model, cost_usd: t.rca_cost_usd, generated_at: t.rca_generated_at,
      error: t.rca_error,
    } : (t.rca_error ? { error: t.rca_error, generated_at: t.rca_generated_at } : null),
    ai_enabled: aiEnabled,
  });
});

// ─── POST /v1/fms/tickets/:id/rca ── (re)generate RCA on demand ──
router.post('/tickets/:id/rca', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const id = parseInt(req.params.id, 10);
  const t = db.prepare('SELECT id FROM tickets WHERE id=? AND tenant_id=?').get(id, tid);
  if (!t) return res.status(404).json({ error: 'not found' });
  try {
    const r = await require('../services/fms-rca').generateRcaForTicket(id);
    if (!r.ok) return res.status(r.skipped ? 409 : 500).json({ error: r.error, skipped: r.skipped });
    res.json({ ok: true, rca: r.rca });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /v1/fms/alerts/:id/ticket ── find ticket linked to alert ──
router.get('/alerts/:id/ticket', (req, res) => {
  const tid = tenantOf(req); const aid = parseInt(req.params.id, 10);
  const alert = db.prepare('SELECT * FROM alerts WHERE id=? AND tenant_id=?').get(aid, tid);
  if (!alert) return res.status(404).json({ error: 'alert not found' });
  let ticket = null;
  // Try ticket_id column first
  try {
    if (alert.ticket_id) {
      ticket = db.prepare('SELECT id, ticket_no, priority, status, title, created_at FROM tickets WHERE id=?').get(alert.ticket_id);
    }
  } catch (_) {}
  // Fallback: match by device + recency (same metric within 6h)
  if (!ticket && alert.device_id) {
    ticket = db.prepare(`SELECT id, ticket_no, priority, status, title, created_at FROM tickets
                         WHERE tenant_id=? AND device_id=? AND alert_metric=?
                           AND created_at BETWEEN ? AND ?
                         ORDER BY created_at DESC LIMIT 1`).get(
      tid, alert.device_id, alert.metric,
      alert.received_at - 6*3600*1000, alert.received_at + 6*3600*1000
    );
  }
  res.json({ ok: true, ticket });
});



// ─── GET /v1/fms/reports/monthly/pdf?year=&month= ── download PDF ──
router.get('/reports/monthly/pdf', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const year = parseInt(req.query.year || new Date().getFullYear(), 10);
  const month = parseInt(req.query.month || (new Date().getMonth() + 1), 10);

  const tenant = db.prepare('SELECT display_name AS name FROM tenants WHERE id=?').get(tid) || { name: `tenant ${tid}` };
  const { renderFmsMonthlyPdf } = require('../services/fms-pdf-gen');
  const { filepath, filename } = await renderFmsMonthlyPdf({
    tenantId: tid, tenantName: tenant.name, year, month,
  });
  res.download(filepath, filename);
});

// ─── POST /v1/fms/reports/monthly/send ── email PDF (manual trigger) ─
router.post('/reports/monthly/send', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const year = parseInt(req.body?.year || new Date().getFullYear(), 10);
  const month = parseInt(req.body?.month || (new Date().getMonth() + 1), 10);
  const recipients = Array.isArray(req.body?.to) && req.body.to.length
    ? req.body.to
    : [req.user?.email].filter(Boolean);
  if (!recipients.length) return res.status(400).json({ error: 'no recipients' });

  const { sendFmsMonthlyReport } = require('../services/fms-report-mailer');
  try {
    const r = await sendFmsMonthlyReport({ tenantId: tid, year, month, recipients });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /v1/fms/reports/monthly/history ── recent sends ──────────
router.get('/reports/monthly/history', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const rows = db.prepare(`SELECT id, year, month, recipients, ok, error, sent_at
                           FROM fms_report_log WHERE tenant_id=? ORDER BY sent_at DESC LIMIT 24`).all(tid);
  res.json({ ok: true, history: rows });
});



// ─── GET /v1/fms/control/actions ── catalogue of available actions ──
router.get('/control/actions', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const { listActions } = require('../services/fms-device-control');
  const cfg = db.prepare('SELECT * FROM fms_control_config WHERE tenant_id=?').get(tid) || {};
  let allow = [];
  try { allow = JSON.parse(cfg.allowed_actions || '[]'); } catch (_) {}
  const actions = listActions().map(a => ({ ...a, allowed: allow.includes(a.key) }));
  res.json({
    ok: true,
    actions,
    config: {
      control_enabled: !!cfg.control_enabled,
      snmp_enabled: !!cfg.snmp_enabled,
      nmc_http_enabled: !!cfg.nmc_http_enabled,
      ecostruxure_enabled: !!cfg.ecostruxure_enabled,
    },
  });
});

// ─── POST /v1/fms/devices/:id/action ── perform a control action ────
router.post('/devices/:id/action', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const deviceId = parseInt(req.params.id, 10);
  const { action, params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required' });
  try {
    const { performAction } = require('../services/fms-device-control');
    const r = await performAction({ tenantId: tid, deviceId, actionKey: action, params: params || {}, user: req.user });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /v1/fms/control/log ── audit log ───────────────────────────
router.get('/control/log', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
  const rows = db.prepare(`SELECT id, device_id, device_label, action, channel, params, ok, error,
                                  user_email, dry_run, executed_at
                           FROM fms_control_log WHERE tenant_id=?
                           ORDER BY executed_at DESC LIMIT ?`).all(tid, limit);
  res.json({ ok: true, log: rows });
});

// ─── GET / PUT /v1/fms/control/config ─ feature flag + allow-list ──
router.get('/control/config', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const cfg = db.prepare('SELECT * FROM fms_control_config WHERE tenant_id=?').get(tid);
  if (!cfg) return res.json({ ok: true, config: { control_enabled: false, allowed_actions: [] } });
  let actions = [];
  try { actions = JSON.parse(cfg.allowed_actions || '[]'); } catch (_) {}
  res.json({
    ok: true,
    config: {
      control_enabled: !!cfg.control_enabled,
      snmp_enabled: !!cfg.snmp_enabled,
      nmc_http_enabled: !!cfg.nmc_http_enabled,
      ecostruxure_enabled: !!cfg.ecostruxure_enabled,
      require_2fa: !!cfg.require_2fa,
      allowed_actions: actions,
      // Never expose the client_secret over the API
      ecostruxure_client_id: cfg.ecostruxure_client_id || null,
      ecostruxure_org_id: cfg.ecostruxure_org_id || null,
      has_ecostruxure_secret: !!cfg.ecostruxure_client_secret,
      updated_at: cfg.updated_at, updated_by: cfg.updated_by,
    },
  });
});

router.put('/control/config', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  if (req.user && !['super_admin', 'admin', 'fms_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'admin role required' });
  }
  const b = req.body || {};
  const allowedActionsJson = Array.isArray(b.allowed_actions) ? JSON.stringify(b.allowed_actions) : null;
  const existing = db.prepare('SELECT tenant_id FROM fms_control_config WHERE tenant_id=?').get(tid);
  if (existing) {
    db.prepare(`UPDATE fms_control_config SET
        control_enabled=COALESCE(?, control_enabled),
        snmp_enabled=COALESCE(?, snmp_enabled),
        nmc_http_enabled=COALESCE(?, nmc_http_enabled),
        ecostruxure_enabled=COALESCE(?, ecostruxure_enabled),
        require_2fa=COALESCE(?, require_2fa),
        allowed_actions=COALESCE(?, allowed_actions),
        ecostruxure_client_id=COALESCE(?, ecostruxure_client_id),
        ecostruxure_client_secret=COALESCE(?, ecostruxure_client_secret),
        ecostruxure_org_id=COALESCE(?, ecostruxure_org_id),
        updated_at=?, updated_by=?
        WHERE tenant_id=?`)
      .run(
        b.control_enabled != null ? (b.control_enabled ? 1 : 0) : null,
        b.snmp_enabled != null ? (b.snmp_enabled ? 1 : 0) : null,
        b.nmc_http_enabled != null ? (b.nmc_http_enabled ? 1 : 0) : null,
        b.ecostruxure_enabled != null ? (b.ecostruxure_enabled ? 1 : 0) : null,
        b.require_2fa != null ? (b.require_2fa ? 1 : 0) : null,
        allowedActionsJson,
        b.ecostruxure_client_id || null,
        b.ecostruxure_client_secret || null,
        b.ecostruxure_org_id || null,
        Date.now(), req.user?.email || null,
        tid,
      );
  } else {
    db.prepare(`INSERT INTO fms_control_config
      (tenant_id, control_enabled, snmp_enabled, nmc_http_enabled, ecostruxure_enabled,
       require_2fa, allowed_actions, ecostruxure_client_id, ecostruxure_client_secret, ecostruxure_org_id,
       updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        tid,
        b.control_enabled ? 1 : 0,
        b.snmp_enabled ? 1 : 0,
        b.nmc_http_enabled ? 1 : 0,
        b.ecostruxure_enabled ? 1 : 0,
        b.require_2fa !== false ? 1 : 0,
        allowedActionsJson || '[]',
        b.ecostruxure_client_id || null, b.ecostruxure_client_secret || null, b.ecostruxure_org_id || null,
        Date.now(), req.user?.email || null,
      );
  }
  res.json({ ok: true });
});


module.exports = router;
