// Data adapters: merge real /v1 data into the screen templates' sample data.
// Rule: anything the API provides overrides the sample; AI/prediction/twin figures stay sample until Phase 2/3 APIs exist.
import { api, withCbu, cbu as getCbu, lang } from './theme';
import { devId } from './ids';
import { t } from './i18n';
import * as Main from './screens/Main.logic.js';
import * as Device from './screens/Device.logic.js';
import * as Alarms from './screens/Alarms.logic.js';
import * as Power from './screens/PowerChain.logic.js';
import * as NOC from './screens/NOC.logic.js';
import { evalLogic } from './tpl';

const OK = '#42be65', WARN = '#f1c21b', CRIT = '#fa4d56', NA = '#6f6f6f';
const SC = { ok: OK, warn: WARN, critical: CRIT, nodata: NA, unreachable: NA, unknown: NA };
const SL = { ok: () => t('정상'), warn: () => t('경고'), critical: () => t('위험'), nodata: () => t('데이터없음'), unreachable: () => t('데이터없음'), unknown: () => t('데이터없음') };
const slabel = (s) => (SL[s] || SL.unknown)();
const PR = { P1: { bg: '#fa4d56', fg: '#fff' }, P2: { bg: '#f1c21b', fg: '#161616' }, P3: { bg: '#393939', fg: '#f4f4f4' }, P4: { bg: '#393939', fg: '#c6c6c6' } };
// Times are shown in the SITE's timezone, not the viewer's (부록 K1). A KMX
// alarm at 11:02 Monterrey read as 09:02 in Irvine, which is a real way to
// mis-sequence an incident. `cbu` is optional: without it this is the viewer's
// zone exactly as before.
export const SIM_NOTE = () => t('시뮬레이션 데이터 — 집계·SLA·리포트에서 제외됨');
export const cbuTz = (cbu) => (cbu && store.cbuMeta?.[cbu]?.timezone) || undefined;
export const hhmm = (ms, cbu) => ms
  ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: cbuTz(cbu) })
  : '—';

/**
 * Short zone marker, shown only when the site's zone differs from the viewer's
 * — a label on every timestamp would be noise, and no label at all is the bug.
 */
export function tzMark(cbu) {
  const tz = cbuTz(cbu);
  if (!tz) return '';
  try {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (here === tz) return '';
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || tz.split('/').pop();
  } catch { return ''; }
}
const pct = (n, t) => t ? `${Math.max(2, Math.round((n / t) * 100))}%` : '0%';

export const store = { me: null, cbuMeta: {}, summary: null, summaryAll: null, assets: [], alerts: [], floor: null, topology: null, heat: {}, fleet: null, loadedAt: 0 };
export async function refresh() {
  const [s, sa, a, al, f, t] = await Promise.all([
    api('/v1/fms/summary' + withCbu()), api('/v1/fms/summary'), api('/v1/fms/assets' + withCbu()),
    api('/v1/fms/alerts' + withCbu('?hours=24')), api('/v1/fms/floor' + withCbu()), api('/v1/fms/topology' + withCbu()),
  ]);
  if (s?.ok) store.summary = s; if (sa?.ok) store.summaryAll = sa;
  // cbu -> { company, display, timezone }, used by hhmm()/tzMark().
  for (const c of (sa?.cbu_list || s?.cbu_list || [])) store.cbuMeta[c.cbu] = { company: c.company, display: c.display, timezone: c.timezone };
  if (a?.ok) store.assets = a.assets || [];
  if (al?.ok) store.alerts = al.alerts || [];
  if (f?.ok) store.floor = f.tree;
  // A server without the v3 ledger endpoint simply has no topology; the 3D scene
  // then falls back to v2 placement for everything, which is the v2 behaviour.
  store.topology = t?.ok ? { rooms: t.rooms || [], unplaced: t.unplaced || [] } : null;
  await Promise.all([fleetLive(store.fleet?.minutes || 60), loadAlarmAux()].map(p => p.catch(() => {})));
  store.loadedAt = Date.now(); return store;
}

// ── v3: heat layer and power chain ──────────────────────────────────
const CACHE_MS = 30000;
const chainCache = new Map();

export async function heatFor(metric) {
  const key = `${metric}|${getCbu()}`;
  const hit = store.heat[key];
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rooms;
  const r = await api(`/v1/fms/topology/heat${withCbu(`?metric=${metric}`)}`);
  const rooms = r?.ok ? (r.rooms || []) : [];
  store.heat[key] = { at: Date.now(), rooms };
  return rooms;
}

async function chain(path, key) {
  const hit = chainCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const r = await api(path);
  // No links is a legitimate answer, not a failure — the panel says so.
  const value = r?.ok ? { chain: r.chain || [], load_pct: r.load_pct ?? null, upstream_capacity_a: r.upstream_capacity_a ?? null } : null;
  chainCache.set(key, { at: Date.now(), value });
  return value;
}
// ── S1: screens connected to endpoints that already exist ───────────
// The real backend caps fleet-live at 180 minutes, so 24h is not offered until
// that cap is raised (v4 §1.1, S2). Showing a 24h button that silently returns
// 3h would be worse than not showing it.
export const FLEET_RANGES = [15, 30, 60, 180];
export async function fleetLive(minutes = 60) {
  const r = await api(`/v1/fms/fleet-live?minutes=${Math.min(180, minutes)}`);
  if (!r?.ok) return null;
  store.fleet = { at: Date.now(), minutes: r.minutes, series: r.series || [], fleet: r.fleet || {} };
  return store.fleet;
}

/** series → SVG polyline points in an 800x200 viewBox, scaled to [lo,hi]. */
export function seriesPoints(series, key, lo, hi, { w = 800, h = 200 } = {}) {
  const pts = (series || []).map((p, i) => [p[key], i]).filter(([v]) => v != null);
  if (pts.length < 2) return '';
  const n = series.length - 1 || 1;
  return pts.map(([v, i]) => {
    const x = (i / n) * w;
    const y = h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
const areaFrom = (points, h = 200, w = 800) => (points ? `0,${h} ${points} ${w},${h}` : '');

export async function sitesMap() {
  const r = await api('/v1/fms/sites-map');
  return r?.ok ? (r.sites || []) : [];
}
export async function channelsHealth() {
  const r = await api('/v1/fms/channels/health');
  return r?.ok ? (r.channels || []) : [];
}
export async function alarmRoutes() {
  const r = await api('/v1/fms/routes');
  return r?.ok ? { routes: r.routes || [], stats: r.stats || {} } : { routes: [], stats: {} };
}
export async function controlActions() {
  const r = await api('/v1/fms/control/actions');
  return r?.ok ? (r.actions || []) : [];
}
export async function thresholdsFor(deviceId) {
  const r = await api(`/v1/fms/assets/${devId(deviceId)}/thresholds`);
  return r?.ok ? (r.thresholds || r) : null;
}
export const ackAlert = (id, on = true) =>
  api(`/v1/fms/alerts/${id}/${on ? 'ack' : 'unack'}`, { method: 'POST', body: '{}' });
export const muteDevice = (id, minutes, reason) =>
  api(`/v1/fms/devices/${devId(id)}/${minutes ? 'mute' : 'unmute'}`, { method: 'POST', body: JSON.stringify({ minutes, reason }) });

// ── alarm → resolution → ticket ─────────────────────────────────────
export async function ticketForAlert(alertId) {
  const r = await api(`/v1/fms/alerts/${alertId}/ticket`);
  return r?.ok ? (r.ticket || null) : null;
}
export async function createTicketFromAlert(alertId, extra = {}) {
  return api('/v1/fms/tickets/from-alert', { method: 'POST', body: JSON.stringify({ alert_id: alertId, ...extra }) });
}
/** Copilot answer plus the HTTP status, so the caller can tell AI-off from broken. */
export async function askCopilot(question, deviceId) {
  try {
    const r = await fetch('/v1/fms/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('cflex_token') || localStorage.getItem('token') || ''}` },
      body: JSON.stringify({ question, device_id: deviceId || undefined, lang: lang() }),
    });
    const d = await r.json().catch(() => null);
    return { ...(d || {}), status: r.status };
  } catch { return { ok: false, status: 0 }; }
}

export async function runControlAction(deviceId, action) {
  try {
    const r = await fetch(`/v1/fms/devices/${devId(deviceId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('cflex_token') || localStorage.getItem('token') || ''}` },
      body: JSON.stringify({ action }),
    });
    const d = await r.json().catch(() => null);
    return { ...(d || {}), status: r.status };
  } catch { return { ok: false, status: 0 }; }
}

export const powerChain = (deviceId) => chain(`/v1/fms/power-chain/${devId(deviceId)}`, `d:${devId(deviceId)}`);
export const powerChainObject = (objectId) => chain(`/v1/fms/power-chain/object/${objectId}`, `o:${objectId}`);
const meData = () => ({ me: { name: store.me?.displayName || store.me?.name || '', email: store.me?.email || '' }, tenant: store.me?.tenantName || store.me?.tenant?.display_name || 'HAEA' });
function kpi() {
  const d = store.summary?.devices; if (!d) return { critical: '—', warn: '—', normal: '—', nodata: '—', total: '—', pc_critical: '0%', pc_warn: '0%', pc_normal: '0%', pc_nodata: '0%' };
  const nd = (d.nodata || 0) + (d.unreachable || 0);
  return { critical: d.critical ?? 0, warn: d.warn ?? 0, normal: d.normal ?? 0, nodata: nd, total: d.total ?? 0, pc_critical: pct(d.critical || 0, d.total), pc_warn: pct(d.warn || 0, d.total), pc_normal: pct(d.normal || 0, d.total), pc_nodata: pct(nd, d.total) };
}
export function cbus() {
  const cur = getCbu(); const S = store.summaryAll || store.summary; const list = [{ cbu: 'all', label: '전체', total: S?.devices?.total ?? '', critical: S?.devices?.critical }, ...(S?.cbu_list || []).map(c => ({ cbu: c.cbu, label: c.cbu, total: c.total, critical: c.critical }))];
  return list.map(c => ({ ...c, crit: c.critical ? `●${c.critical}` : '', bg: c.cbu === cur ? '#393939' : 'transparent', fg: c.cbu === cur ? '#fff' : '#f4f4f4' }));
}
function alarmRows(limit = 6) {
  return store.alerts.slice(0, limit).map(a => ({
    p: a.priority, ...(PR[a.priority] || PR.P4), msg: a.message,
    dev: a.device_label || a.object_name || a.device_id, devId: devId(a.device_id),
    alertId: a.id, metric: a.metric || '', rawValue: a.value ?? '', rawThreshold: a.threshold ?? '',
    at: a.received_at, cbu: a.cbu || '',
    t: hhmm(a.received_at, a.cbu), tz: tzMark(a.cbu),
    sim: a.simulated ? 'SIM' : '',
  }));
}

export function mainData() {
  const base = evalLogic(Main.source, Main.props); const k = kpi();
  const assets = store.assets;
  const groups = Object.values(assets.reduce((g, a) => { (g[a.cbu] = g[a.cbu] || { name: a.cbu, n: 0, units: [] }); g[a.cbu].n++; g[a.cbu].units.push({ id: a.label, devId: a.id, color: SC[a.status] || NA }); return g; }, {})).map(g => ({ ...g, w: `${Math.min(300, Math.ceil(Math.sqrt(g.n)) * 2 * 25 + 60)}px` }));
  const batt = [...assets].filter(a => a.battery_pct != null).sort((a, b) => (a.health_score ?? 100) - (b.health_score ?? 100)).slice(0, 5).map(a => ({ id: a.label, devId: a.id, w: `${Math.max(5, Math.min(100, a.health_score ?? 80))}%`, color: SC[a.status] || OK, eol: t((a.health_score ?? 80) < 50 ? '교체 권고' : (a.health_score ?? 80) < 70 ? '관찰' : '양호') }));
  const sites = (store.summary?.cbu_list || []).map(c => ({ name: c.cbu, addr: `${c.total} UPS · ${t('정상')} ${c.ok ?? '—'} · ${t('경고')} ${c.warn ?? 0} · ${t('위험')} ${c.critical ?? 0}`, ups: c.total, alarms: c.critical ? `${c.critical} ${t('위험')}` : c.warn ? `${c.warn} ${t('경고')}` : t('정상'), color: c.critical ? CRIT : c.warn ? WARN : OK }));
  // Fleet Live: real polylines, or empty strings so the chart renders its grid
  // with no curve rather than a fabricated one.
  const fs = store.fleet?.series || [];
  const fleet = store.fleet?.fleet || {};
  const battPts = seriesPoints(fs, 'battery_avg', 90, 100);
  const loadPts = seriesPoints(fs, 'load_pct' in (fs[0] || {}) ? 'load_pct' : 'load_avg', 0, 100);
  const tempPts = seriesPoints(fs, 'temp_max', 15, 45);
  const chart = {
    batt: battPts, load: loadPts, temp: tempPts, loadArea: areaFrom(loadPts),
    battAvg: fleet.battery_avg != null ? `${fleet.battery_avg}%` : '—',
    loadAvg: fleet.load_avg != null ? `${fleet.load_avg}%` : '—',
    tempMax: fleet.temp_max != null ? `${fleet.temp_max}°C` : '—',
    minutes: store.fleet?.minutes ?? 60,
    points: fs.length,
    empty: !fs.length,
  };

  const curMin = store.fleet?.minutes ?? 60;
  const ranges = FLEET_RANGES.map(m => ({ minutes: m, label: m >= 60 ? `${m / 60}h` : `${m}m`, bg: m === curMin ? '#393939' : 'transparent' }));

  return { ...base, ...meData(), kpi: k, cbus: cbus(), chart, ranges, groups: groups.length ? groups : base.groups, batt: batt.length ? batt : base.batt, sites: sites.length ? sites : base.sites, alarms: store.alerts.length ? alarmRows(6) : base.alarms, sample: !assets.length };
}

// `_fellBack` stops the "no id / fetch failed -> show the worst device" path from
// recursing forever when the API is down: the retry would fail the same way and
// pick the same device again.
export const DEVICE_RANGES = [
  { key: '1h', label: '1h' }, { key: '24h', label: '24h' },
  { key: '7d', label: '7d' }, { key: '30d', label: '30d' },
];

/**
 * Network / UC gear lands on the same detail screen. It is not a UPS — there is
 * no battery, no load curve and no self-test — so the panels that would need
 * those read 미수집 instead of borrowing the sample values, and what the device
 * does have (ports, power chain, placement) is shown. Without this, a switch in
 * the inventory tree was the one row you could not open.
 */
/**
 * A power chain arrives in two shapes: a bare array, or traceChain()'s envelope
 * { chain, upstream_capacity_a }. Taking either is cheaper than remembering
 * which endpoint returns which.
 */
export const chainOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.chain) ? v.chain : []);

export async function netDeviceData(rawId, range = '24h') {
  const base = evalLogic(Device.source, Device.props);
  const r = await api(`/v1/fms/devices/${encodeURIComponent(rawId)}`);
  const d = r?.ok ? r.device : null;
  if (!d) return { ...base, ...meData(), cbus: cbus(), notFound: true, kind: 'net' };

  const fresh = d.last_polled && Date.now() - d.last_polled < 5 * 60 * 1000;
  const st = fresh ? (d.status || 'nodata') : 'nodata';
  const dash = '—';
  return {
    ...base, ...meData(), cbus: cbus(), kind: 'net', isNet: true,
    // The faceplate draws from these, so it matches the unit rather than a
    // generic picture: 24 ports draw 24, and the ones reported up are lit.
    portsTotal: d.ports_total ?? 0, portsUp: d.ports_up ?? 0,
    d: {
      ...base.d,
      label: d.label, stColor: SC[st] || NA, stLabel: slabel(st),
      vendor: d.vendor || dash, model: d.model || dash, serial: d.serial || dash,
      ip: d.ip || dash, location: d.location || dash, room: d.room || dash, rack: d.rack || dash,
      u: d.u_pos != null ? `U${d.u_pos}${d.u_height ? `–${d.u_pos + d.u_height - 1}` : ''}` : dash,
      kindLabel: d.kind || 'other',
      ports: d.ports_total ? `${d.ports_up ?? dash} / ${d.ports_total}` : dash,
      // Everything a UPS has and a switch does not.
      battery: dash, load: dash, temp: dash, runtime: dash, health: dash,
      pollNote: t('이 장비 종류는 아직 수집기가 없습니다'),
    },
    hist: [],
    histEmpty: true,
    trend: { batt: '', load: '', temp: '', loadArea: '', empty: true },
    ranges: DEVICE_RANGES.map(x => ({ ...x, on: x.key === range })),
    actions: [],
    // getDevice() returns traceChain()'s envelope — { chain, upstream_capacity_a }
    // — not a bare array, which is what `(d.chain || []).map` tripped over.
    // /v1/fms/power-chain/* puts the array at the top level instead, so both
    // shapes are accepted rather than depending on which endpoint answered.
    chain: chainOf(d.chain).map(c => ({ name: c.name, kind: c.kind })),
    upstreamCapacityA: d.chain && !Array.isArray(d.chain) ? (d.chain.upstream_capacity_a ?? null) : null,
    rca: null,
    sample: false,
  };
}

export async function deviceData(id, _fellBack = false, range = '24h') {
  // An 'fd-<n>' id is an fms_devices row, not a UPS.
  if (/^fd-/i.test(String(id ?? ''))) return netDeviceData(id, range);
  const base = evalLogic(Device.source, Device.props);
  let a = null;
  // Alerts carry device_id as 'ups-41'; /v1/fms/assets/:id parseInt()s its argument,
  // so the prefix has to come off or the fetch 404s and the screen silently shows
  // whichever device the fallback picks instead.
  const wanted = devId(id);
  if (wanted) { const r = await api(`/v1/fms/assets/${wanted}?range=${range}`); if (r?.ok) a = { ...r.asset, _alerts: r.alerts || [], _metrics: r.metrics || [], _thresholds: r.thresholds || null }; }
  // Fall back to the worst device only when no id was asked for at all — that is the
  // sidebar's bare "장치" link. An id that was supplied but did not resolve must NOT
  // silently show a different device: the sample root-cause cards link to
  // "#/device?id=" because they carry a label and no device id, and the alarm rows
  // would 404 if their 'ups-' prefix ever slipped through. Those fall through to the
  // sample screen, which the badge marks as sample.
  if (!a && id === undefined && !_fellBack) { const pick = [...store.assets].sort((x, y) => ({ critical: 0, warn: 1 }[x.status] ?? 2) - ({ critical: 0, warn: 1 }[y.status] ?? 2))[0]; if (pick) return deviceData(pick.id, true, range); }
  const d = a ? {
    id: a.id, label: a.label, vendor: a.vendor || '', model: a.model || '', room: a.room || '', rack: a.rack || '', location: a.location || '', cbu: a.cbu || '', ip: a.ip || '—', serial: a.serial || '—', firmware: a.firmware || '—', poll: t('30s · 서버 폴러'),
    stColor: SC[a.status] || NA, stLabel: slabel(a.status), health: a.health_score ?? '—', healthPct: `${a.health_score ?? 0}%`,
    battery_pct: a.battery_pct ?? '—', load_pct: a.load_pct ?? '—', temp_c: a.temp_c ?? '—', runtime_min: a.runtime_min ?? '—', input_v: a.input_v ?? '—', output_v: a.output_v ?? '—', output_status: a.output_status || '—', battery_status: a.battery_status || '—',
    battOff: 188.5 * (1 - Math.min(100, a.battery_pct || 0) / 100), loadOff: 188.5 * (1 - Math.min(100, a.load_pct || 0) / 100), tempOff: 188.5 * (1 - Math.min(1, Math.max(0, ((a.temp_c || 20) - 15) / 30))), lastPoll: hhmm(a.last_polled),
  } : { id: '', label: 'KUS-UPS-03', vendor: 'APC', model: 'Smart-UPS SRT 5000VA', room: 'Irvine 서버실', rack: 'Rack A-04', location: '', cbu: 'KUS', ip: '10.40.12.33', serial: 'AS2318xxxxxx', firmware: 'UPS 14.3 / NMC 3.1', poll: '30s', stColor: CRIT, stLabel: 'P1 · 배터리 전압 저하', health: 61, healthPct: '61%', battery_pct: 71, load_pct: 48, temp_c: 27.1, runtime_min: 18, input_v: 118.2, output_v: 120.1, output_status: 'ONLINE', battery_status: 'NORMAL', battOff: 55, loadOff: 98, tempOff: 86, lastPoll: '14:31' };
  // Real trend curves from the metrics the endpoint already returns, with the
  // device's own threshold line. No metrics means an empty chart and a reason —
  // never an invented curve.
  const m = a?._metrics || [];
  const th = a?._thresholds || {};
  const span = (key, pad = 0.08) => {
    const v = m.map(p => p[key]).filter(x => x != null);
    if (!v.length) return null;
    let lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const p = (hi - lo) * pad;
    return [lo - p, hi + p];
  };
  const battSpan = span('battery_pct') || [0, 100];
  const rtSpan = span('runtime_min') || [0, 60];
  const thrLine = (() => {
    const crit = th.battery_pct?.critical;
    if (crit == null || !m.length) return null;
    const [lo, hi] = battSpan;
    if (crit < lo || crit > hi) return null;                 // off-scale: drawing it would mislead
    return (200 - ((crit - lo) / (hi - lo)) * 200).toFixed(1);
  })();
  const trend = {
    batt: seriesPoints(m, 'battery_pct', battSpan[0], battSpan[1]),
    runtime: seriesPoints(m, 'runtime_min', rtSpan[0], rtSpan[1]),
    thresholdY: thrLine,
    thresholdLabel: th.battery_pct?.critical != null ? `P1 임계 ${th.battery_pct.critical}` : '',
    points: m.length,
    empty: !m.length,
    emptyWhy: '데이터 축적 중 · 수집 대기',
    range,
    from: m.length ? hhmm(m[0].ts) : '—',
    to: m.length ? hhmm(m[m.length - 1].ts) : '—',
  };
  const ranges = DEVICE_RANGES.map(r => ({ ...r, bg: r.key === range ? '#393939' : 'transparent' }));

  // The alarm-history rows carry the same identifiers the dashboard and alarm
  // centre rows do, so a click here opens the one workbench (v5 §4).
  const hist = a && a._alerts.length ? a._alerts.map(x => ({
    p: x.priority, ...(PR[x.priority] || PR.P4), msg: x.message,
    metric: x.metric || '—', val: x.value != null ? `${x.value} / ${x.threshold ?? '—'}` : '—',
    start: hhmm(x.received_at, x.cbu || a.cbu), tz: tzMark(x.cbu || a.cbu), end: '—', who: '—',
    sim: x.simulated ? 'SIM' : '',
    alertId: x.id, dev: a.label || devId(a.id), devId: devId(a.id),
    rawMetric: x.metric || '', rawValue: x.value ?? '', rawThreshold: x.threshold ?? '', at: x.received_at,
  })) : base.hist;
  // Control buttons only for actions this user is actually allowed to run —
  // a button that always answers "권한 없음" is worse than no button.
  const actions = (aux.actions || []).filter(x => x.allowed && !x.destructive)
    .map(x => ({ key: x.key, label: x.label }));

  // RCA comes from the device's open ticket. No ticket is not an error state.
  const ticket = a ? (store.ticketsByDevice?.[devId(a.id)] || null) : null;
  const rca = ticket?.rca_summary
    ? { text: ticket.rca_summary, actions: ticket.rca_actions || '', model: ticket.rca_model || '', ticket: ticket.ticket_no }
    : null;

  return {
    // The faceplate tints its LCD from this, so the picture agrees with the badge.
    statusKey: a ? (a.status || 'nodata') : 'nodata',
    ...base, ...meData(), cbus: cbus(), d, hist, trend, ranges, actions,
    hasActions: !!actions.length,
    rca, rcaEmpty: !rca,
    rcaNote: ticket ? 'RCA 생성 전 — 티켓 ' + ticket.ticket_no : 'P1 알람 발생 시 자동 생성',
    ticketNo: ticket?.ticket_no || '',
    deviceId: a?.id ?? '', muted: !!a?.muted_until, sample: !a,
  };
}

// Cached so the alarm screen can stay synchronous; refreshed by refresh().
export const aux = { rules: null, channels: null, actions: null, sites: null };
export async function loadAlarmAux() {
  const [r, c, a, si] = await Promise.all([alarmRoutes(), channelsHealth(), controlActions(), sitesMap()]);
  aux.rules = r.routes; aux.channels = c; aux.actions = a; aux.sites = si;
  return aux;
}

const CH_NAME = { teams: 'Teams', sms: 'SMS', email: 'Email', line: 'LINE', phone: '전화' };

export function alarmsData(cbuFilter = null) {
  const base = evalLogic(Alarms.source, Alarms.props);
  // Alerts carry no cbu, so resolve it through the device they belong to.
  const cbuOf = new Map(store.assets.map(a => [devId(a.id), a.cbu]));
  const inScope = (a) => !cbuFilter || cbuOf.get(devId(a.device_id)) === cbuFilter;
  const scoped = store.alerts.filter(inScope);
  const rows = scoped.length ? scoped.slice(0, 12).map(a => ({ p: a.priority, ...(PR[a.priority] || PR.P4), st: t(a.muted_until ? '점검모드' : '미확인'), stc: a.muted_until ? '#8d8d8d' : '#ff832b', rowbg: a.priority === 'P1' ? 'rgba(250,77,86,.06)' : 'transparent', msg: a.message, sub: `${a.metric || ''}${a.recurring ? ` · ${t('반복')}` : ''}`, dev: a.device_label || a.device_id, devId: devId(a.device_id), alertId: a.id, metric: a.metric || '', rawValue: a.value ?? '', rawThreshold: a.threshold ?? '', at: a.received_at, site: a.site || a.room_name || a.room || '', val: a.value != null ? `${a.value} / ${a.threshold ?? '—'}` : '—',
    cbu: a.cbu || '', t: hhmm(a.received_at, a.cbu), tz: tzMark(a.cbu), sim: a.simulated ? 'SIM' : '', age: a.received_at ? `${Math.max(0, Math.round((Date.now() - a.received_at) / 60000))}m` : '—', agec: a.priority === 'P1' ? '#ff8389' : '#c6c6c6', who: '—' })) : base.rows;
  const rules = (aux.rules || []).map(r => ({
    metric: r.metric, priority: r.priority,
    threshold: r.threshold != null ? String(r.threshold) : '—',
    duration: r.duration_s != null ? `${r.duration_s} s` : '—',
    dedup: r.dedup_min != null ? `${r.dedup_min} min` : '—',
    channels: r.channels || '—',
    state: r.enabled ? '사용' : '중지',
    color: r.priority === 'P1' ? '#ff8389' : r.priority === 'P2' ? '#f1c21b' : '#c6c6c6',
  }));
  // A channel that is configured but failing must look different from one that
  // was never set up — an operator reading "Email ●" has to know which.
  const channels = (aux.channels || []).map(c => ({
    name: CH_NAME[c.channel] || c.channel,
    color: !c.configured ? '#525252' : c.ok ? '#42be65' : '#fa4d56',
    note: !c.configured ? '미설정' : c.ok ? '정상' : (c.last_error ? '오류' : '응답 없음'),
  }));

  return {
    ...base, ...meData(), cbus: cbus(), rows, rules, rulesEmpty: !rules.length, channels,
    cbuFilter: cbuFilter || '',
    filterLabel: cbuFilter ? `${cbuFilter} · ${scoped.length}건` : '',
    sample: !scoped.length,
  };
}
// Power chain, built from the ledger's power_links for the selected CBU.
// Tiers are derived by walking links upstream: anything nothing feeds is a load,
// anything that feeds nothing is the utility end.
const TIER_LABEL = { utility: '수전 · 상위', panel: '분전반', ups: 'UPS', pdu: 'PDU', load: '부하 (랙)' };
const KIND_TIER = { panel: 'panel', ups_cabinet: 'ups', ups: 'ups', pdu_cabinet: 'pdu', pdu: 'pdu', rack: 'load' };

export function powerData() {
  const base = evalLogic(Power.source, Power.props);
  const cur = getCbu();
  const rooms = store.topology?.rooms || [];
  const nodes = new Map();      // name -> node
  const feeds = new Set();      // names that supply someone (i.e. upstream of something)

  for (const room of rooms) {
    for (const o of room.objects || []) {
      const tier = KIND_TIER[o.kind];
      if (!tier) continue;
      const devs = o.devices || [];
      const load = devs.map(d => d.load_pct).filter(v => v != null);
      nodes.set(o.name, {
        name: o.name, kind: o.kind, tier: o.attrs?.utility ? 'utility' : tier,
        objectId: o.id,
        sub: devs.length ? devs.map(d => d.label).join(', ') : (o.attrs?.rated_a ? `${o.attrs.rated_a} A` : o.kind),
        value: load.length ? `부하 ${Math.max(...load)}%`
          : (o.attrs?.capacity_kw ? `${o.attrs.capacity_kw} kW` : (o.attrs?.design_kw != null ? `${o.attrs.design_kw} kW` : '—')),
        color: devs.some(d => d.status === 'critical') ? '#fa4d56'
          : devs.some(d => d.status === 'warn') ? '#f1c21b'
            : devs.length ? '#42be65' : '#525252',
      });
    }
    for (const l of room.power_links || []) if (l.dst) feeds.add(l.dst);
  }
  // A node that supplies others but is fed by nothing is the utility end.
  for (const [name, n] of nodes) if (feeds.has(name) && n.kind === 'panel' && !rooms.some(r => (r.power_links || []).some(l => l.src === name))) n.tier = 'utility';

  const order = ['utility', 'panel', 'ups', 'pdu', 'load'];
  const tiers = order.map(k => ({
    label: TIER_LABEL[k],
    nodes: [...nodes.values()].filter(n => n.tier === k).slice(0, 24).map(n => ({
      name: n.name, sub: n.sub, value: n.value, color: n.color,
      href: n.objectId != null ? `#/twin?scene=kmx&focus=${encodeURIComponent(n.name)}` : '#/twin',
    })),
  })).filter(t => t.nodes.length);

  const why = rooms.length
    ? `선택한 CBU(${cur === 'all' ? '전체' : cur})의 원장에 전원 링크가 없다.`
    : '이 테넌트에는 배치 원장이 없다. 서베이 시트를 import하면 여기에 실제 체인이 그려진다.';

  return {
    ...base, ...meData(), cbus: cbus(),
    chainTitle: `${cur === 'all' ? (store.me?.tenantName || 'HAEA') : cur} 전력체인`,
    chain: { tiers, empty: !tiers.length, emptyWhy: why },
  };
}
export function nocData() {
  const base = evalLogic(NOC.source, NOC.props);
  const k = kpi();
  const C = { crit: '#fa4d56', warn: '#f1c21b', ok: '#42be65', nodata: '#6f6f6f' };
  const sites = (aux.sites || []).map(s => {
    const key = s.critical > 0 ? 'crit' : s.warn > 0 ? 'warn' : (s.ok > 0 ? 'ok' : 'nodata');
    return {
      name: s.company || s.cbu,
      sub: `${s.display || ''}${s.buildings?.length ? ` · ${t0(s.buildings.length)}` : ''}`.trim(),
      ups: s.total,
      state: s.critical ? `${s.critical} 위험` : s.warn ? `${s.warn} 경고` : (s.ok ? '정상' : '데이터없음'),
      color: C[key], glow: `${C[key]}33`,
    };
  });
  // The wall's ticker was hard-coded sample alarms. It now runs on the real
  // alert feed and each entry opens the workbench, which is what §4 asks of
  // every alarm surface. An empty feed shows one quiet row, not invented ones.
  const ticker = store.alerts.slice(0, 12).map(x => ({
    p: x.priority, ...(PR[x.priority] || PR.P4),
    t: hhmm(x.received_at, x.cbu), msg: x.message,
    dev: x.device_label || x.object_name || x.device_id, devId: devId(x.device_id),
    sim: x.simulated ? '· SIM' : '',
    alertId: x.id, metric: x.metric || '', rawValue: x.value ?? '', rawThreshold: x.threshold ?? '',
    at: x.received_at,
  }));
  return {
    ...base, ...meData(), cbus: cbus(), kpi: k,
    sites: sites.length ? sites : base.sites,
    ticker,
    tickerEmpty: !ticker.length,
    tickerSummary: ticker.length
      ? `${t('활성 알람')} ${ticker.length}${store.alerts.length > ticker.length ? ` / ${store.alerts.length}` : ''}`
      : t('24시간 내 알람 없음'),
    siteSummary: sites.length ? `사이트 ${sites.length} · UPS ${sites.reduce((n, x) => n + (x.ups || 0), 0)}` : '',
    clock: new Date().toLocaleTimeString('en-GB', { hour12: false }),
  };
}
const t0 = (n) => `건물 ${n}`;
