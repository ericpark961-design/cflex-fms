// views.js — database rows → the shapes apps/twin already reads.
//
// The twin UI was built against backend/routes/fms.routes.js (and its mock,
// apps/twin/mock/server.js). Its keys are kept exactly, inconsistencies
// included: assets carry the numeric row id, alerts carry `ups-<id>` as
// device_id. The console serves the existing UI; it does not reshape it.
const DEFAULT_THRESHOLDS = Object.freeze({
  battery_pct: { critical: 30, warn: 60, direction: 'below' },
  load_pct: { critical: 90, warn: 75, direction: 'above' },
  temp_c: { critical: 45, warn: 38, direction: 'above' },
  runtime_min: { critical: 5, warn: 15, direction: 'below' },
});

const STATUS_OF_SEVERITY = { P1: 'critical', P2: 'warn', P3: 'warn' };
const UPS_STATUS = { online: 'ONLINE', on_battery: 'ON BATTERY', bypass: 'BYPASS', off: 'OFF' };
const json = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function createViews(db, { staleMs = 300000, now = Date.now } = {}) {
  const q = {
    sites: () => db.all('SELECT * FROM sites ORDER BY id'),
    devices: () => db.all('SELECT d.*, s.name AS site_name, s.timezone FROM devices d JOIN sites s ON s.id = d.site_id ORDER BY d.site_id, d.label'),
    device: (id) => db.one('SELECT d.*, s.name AS site_name, s.timezone FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?', id),
    worstOpen: () => db.all(`SELECT device_id, MIN(severity) AS sev FROM alarms WHERE state = 'open' AND device_id IS NOT NULL GROUP BY device_id`),
    maint: (a, b) => db.all('SELECT * FROM maintenance WHERE ends_at > ? AND starts_at <= ?', a, b),
    setting: (k) => db.one('SELECT value FROM settings WHERE key = ?', k),
  };

  async function thresholds(dev) {
    const site = json((await q.setting('thresholds'))?.value, {});
    return { ...DEFAULT_THRESHOLDS, ...site, ...json(dev?.thresholds, {}) };
  }

  /** Active maintenance windows → device_id → ends_at (site- and node-wide windows included). */
  async function mutedMap(devs) {
    const t = now();
    const wins = await q.maint(t, t);
    const m = new Map();
    for (const d of devs) {
      const w = wins.filter(x => (x.device_id == null || x.device_id === d.device_id) && (x.site_id == null || x.site_id === d.site_id));
      if (w.length) m.set(d.device_id, Math.max(...w.map(x => x.ends_at)));
    }
    return m;
  }

  function statusOf(d, sev) {
    if (!d.last_ts || now() - d.last_ts > staleMs) return 'nodata';
    if (d.comm_ok === 0) return 'unreachable';
    return STATUS_OF_SEVERITY[sev] || 'ok';
  }

  function asset(d, sev, muted) {
    return {
      id: d.id, device_id: d.device_id, label: d.label, location: d.site_name, room: d.room || '', rack: d.rack || '',
      building: d.building || null, floor: d.floor || null,
      ip: d.nmc_ip, vendor: d.vendor, model: d.model, status: statusOf(d, sev), health_score: null,
      battery_pct: d.battery_pct, load_pct: d.load_pct, temp_c: d.temp_c, runtime_min: d.runtime_min,
      output_v: d.output_v, input_v: d.input_v, output_status: UPS_STATUS[d.ups_status] || (d.ups_status ? String(d.ups_status).toUpperCase() : null),
      battery_status: null, last_polled: d.last_ts, polling_enabled: d.polling_enabled, consecutive_fails: 0,
      poll_error: d.comm_ok === 0 ? 'no response' : null, criticality: null, muted_until: muted ?? null,
      cbu: d.site_id, serial: d.serial, serial_alt: json(d.serial_alt, []), firmware: d.firmware,
      mfg_date: d.mfg_date, battery_installed: d.battery_installed, battery_due: d.battery_due, in_sow: !!d.in_sow,
    };
  }

  async function assets(cbu) {
    const devs = (await q.devices()).filter(d => !cbu || cbu === 'all' || d.site_id === cbu);
    const worst = new Map((await q.worstOpen()).map(r => [r.device_id, r.sev]));
    const muted = await mutedMap(devs);
    return devs.map(d => asset(d, worst.get(d.device_id), muted.get(d.device_id)));
  }

  function count(list) {
    const c = (s) => list.filter(a => a.status === s).length;
    return { total: list.length, polling: list.filter(a => a.polling_enabled).length, critical: c('critical'), warn: c('warn'), ok: c('ok'), nodata: c('nodata'), unreachable: c('unreachable') };
  }

  async function summary(cbu) {
    const all = await assets();
    const list = cbu && cbu !== 'all' ? all.filter(a => a.cbu === cbu) : all;
    const n = count(list);
    const since = now() - 24 * 3600 * 1000;
    const alerts24 = (await db.one(`SELECT COUNT(*) AS c FROM alarms WHERE raised_at >= ?${cbu && cbu !== 'all' ? ' AND site_id = ?' : ''}`,
      ...(cbu && cbu !== 'all' ? [since, cbu] : [since]))).c;
    const cbu_list = (await q.sites()).map(s => {
      const c = count(all.filter(a => a.cbu === s.id));
      return { cbu: s.id, display: s.name, company: s.company, timezone: s.timezone, ...c };
    });
    return {
      ok: true,
      devices: { total: n.total, polling: n.polling, online: n.total - n.nodata - n.unreachable, unreachable: n.unreachable, nodata: n.nodata, critical: n.critical, warn: n.warn, normal: n.ok },
      alerts_24h: alerts24, sites: cbu_list.length, cbu_list,
    };
  }

  async function floor(cbu) {
    const tree = {};
    for (const a0 of await assets(cbu)) {
      const a = { ...a0, location: a0.location || 'Unknown Location', room: a0.room || 'Default Room', rack: a0.rack || 'Default Rack' };
      const blank = () => ({ count: 0, critical: 0, warn: 0, ok: 0, unreachable: 0, nodata: 0 });
      const L = tree[a.location] = tree[a.location] || { name: a.location, ...blank(), rooms: {} };
      const R = L.rooms[a.room] = L.rooms[a.room] || { name: a.room, ...blank(), racks: {} };
      const K = R.racks[a.rack] = R.racks[a.rack] || { name: a.rack, ...blank(), devices: [] };
      for (const x of [L, R, K]) { x.count++; x[a.status] = (x[a.status] || 0) + 1; }
      K.devices.push({ id: a.id, label: a.label, status: a.status, battery_pct: a.battery_pct, last_polled: a.last_polled });
    }
    return { ok: true, tree };
  }

  const RANGES = { '1h': [3600e3, 60], '24h': [86400e3, 96], '7d': [7 * 86400e3, 168], '30d': [30 * 86400e3, 180] };

  /** Device detail + trend: telemetry averaged into at most N buckets over the range. */
  async function assetDetail(id, range = '24h') {
    const d = await q.device(id);
    if (!d) return null;
    const worst = (await db.one(`SELECT MIN(severity) AS sev FROM alarms WHERE state = 'open' AND device_id = ?`, d.device_id))?.sev;
    const muted = (await mutedMap([d])).get(d.device_id);
    const [span, n] = RANGES[range] || RANGES['24h'];
    const to = now();
    const from = to - span;
    const step = Math.ceil(span / n);
    const metrics = (await db.all(`
      SELECT (ts - ?::bigint) / ?::bigint AS b, MAX(ts) AS ts, AVG(battery_pct) AS battery_pct, AVG(load_pct) AS load_pct,
             AVG(temp_c) AS temp_c, AVG(runtime_min) AS runtime_min, MIN(comm_ok) AS comm_ok
      FROM telemetry WHERE device_id = ? AND ts >= ? AND ts <= ? GROUP BY b ORDER BY b`,
      from, step, d.device_id, from, to))
      .map(r => ({ ts: r.ts, battery_pct: rnd(r.battery_pct), load_pct: rnd(r.load_pct), temp_c: rnd(r.temp_c), runtime_min: rnd(r.runtime_min), comm_ok: r.comm_ok }));
    const alerts = (await db.all(`SELECT * FROM alarms WHERE device_id = ? ORDER BY raised_at DESC LIMIT 50`, d.device_id)).map(a => alert(a, d));
    return { ok: true, asset: asset(d, worst, muted), range, metrics, thresholds: await thresholds(d), alerts };
  }

  function alert(a, d) {
    const det = json(a.detail, {});
    return {
      id: a.id, alarm_id: a.alarm_id, device_id: d ? `ups-${d.id}` : null, device_ref: a.device_id,
      site: d?.site_name || a.site_id, cbu: a.site_id, priority: a.severity, code: a.code,
      metric: det.metric || a.code, message: a.title, value: det.value ?? null, threshold: det.threshold ?? null,
      received_at: a.raised_at, updated_at: a.updated_at, cleared_at: a.cleared_at, state: a.state,
      device_label: d?.label || null, room: d?.room || null, rack: d?.rack || null,
      muted_until: null, recurring: !!det.flapping, maintenance: !!a.maintenance,
      acked_at: a.acked_at, acked_by: a.acked_by, local_notified: json(a.local_notified),
    };
  }

  /**
   * Alarm list. Default: everything open, plus whatever was raised in the last
   * `hours`. `state=open` narrows to open only; `priority=P1,P2` and `cbu` filter.
   */
  async function alerts({ hours = 24, state, priority, cbu, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (state === 'open') where.push(`a.state = 'open'`);
    else if (state === 'cleared') { where.push(`a.state = 'cleared' AND a.raised_at >= ?`); args.push(now() - hours * 3600e3); }
    else { where.push(`(a.state = 'open' OR a.raised_at >= ?)`); args.push(now() - hours * 3600e3); }
    const pr = String(priority || '').split(',').filter(p => /^P[1-4]$/.test(p));
    if (pr.length) { where.push(`a.severity IN (${pr.map(() => '?').join(',')})`); args.push(...pr); }
    if (cbu && cbu !== 'all') { where.push('a.site_id = ?'); args.push(cbu); }
    const rows = await db.all(`SELECT a.* FROM alarms a WHERE ${where.join(' AND ')} ORDER BY (a.state = 'open') DESC, a.severity, a.raised_at DESC LIMIT ?`,
      ...args, Math.min(2000, Math.max(1, limit | 0)));
    const devs = new Map((await q.devices()).map(d => [d.device_id, d]));
    const muted = await mutedMap([...devs.values()]);
    return { ok: true, alerts: rows.map(a => ({ ...alert(a, devs.get(a.device_id)), muted_until: muted.get(a.device_id) ?? null })) };
  }

  async function alertDetail(id) {
    const a = await db.one('SELECT * FROM alarms WHERE id = ?', id);
    if (!a) return null;
    const d = a.device_id ? await db.one('SELECT d.*, s.name AS site_name FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.device_id = ?', a.device_id) : null;
    const events = (await db.all('SELECT event_id, ts, kind, title, detail FROM alarm_events WHERE alarm_id = ? ORDER BY ts', a.alarm_id))
      .map(e => ({ ...e, detail: json(e.detail, {}) }));
    const comments = await db.all('SELECT id, ts, author, kind, text FROM alarm_comments WHERE alarm_id = ? ORDER BY ts, id', a.alarm_id);
    return { ok: true, alert: { ...alert(a, d), detail: json(a.detail, {}) }, events, comments };
  }

  /** Fleet averages per minute from telemetry (dashboard "Fleet Live"), capped at 180 minutes as before. */
  async function fleetLive(minutes = 60, cbu) {
    const m = Math.max(5, Math.min(180, minutes | 0 || 60));
    const to = now();
    const from = to - m * 60e3;
    const ids = (await q.devices()).filter(d => !cbu || cbu === 'all' || d.site_id === cbu).map(d => d.device_id);
    if (!ids.length) return { ok: true, minutes: m, fleet: { devices: 0 }, series: [], generated_at: to };
    const series = (await db.all(`
      SELECT (ts - ?::bigint) / 60000 AS b, MAX(ts) AS ts, AVG(battery_pct) AS battery_avg, AVG(load_pct) AS load_avg,
             MAX(temp_c) AS temp_max, COUNT(DISTINCT device_id) AS devices
      FROM telemetry WHERE ts >= ? AND device_id IN (${ids.map(() => '?').join(',')}) GROUP BY b ORDER BY b`,
      from, from, ...ids))
      .map(r => ({ ts: r.ts, battery_avg: rnd(r.battery_avg), load_avg: rnd(r.load_avg), temp_max: rnd(r.temp_max), devices: r.devices }));
    const last = series[series.length - 1] || {};
    return { ok: true, minutes: m, fleet: { battery_avg: last.battery_avg ?? null, load_avg: last.load_avg ?? null, temp_max: last.temp_max ?? null, devices: ids.length }, series, generated_at: to };
  }

  return { assets, summary, floor, assetDetail, alerts, alertDetail, fleetLive, thresholds, statusOf };
}

const rnd = (v) => (v == null ? null : Math.round(v * 10) / 10);

module.exports = { createViews, DEFAULT_THRESHOLDS };
