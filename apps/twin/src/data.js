// Data adapters: merge real /v1 data into the screen templates' sample data.
// Rule: anything the API provides overrides the sample; AI/prediction/twin figures stay sample until Phase 2/3 APIs exist.
import { api, withCbu, cbu as getCbu } from './theme';
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
export const hhmm = (ms) => ms ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';
const pct = (n, t) => t ? `${Math.max(2, Math.round((n / t) * 100))}%` : '0%';

export const store = { me: null, summary: null, summaryAll: null, assets: [], alerts: [], floor: null, topology: null, heat: {}, loadedAt: 0 };
export async function refresh() {
  const [s, sa, a, al, f, t] = await Promise.all([
    api('/v1/fms/summary' + withCbu()), api('/v1/fms/summary'), api('/v1/fms/assets' + withCbu()),
    api('/v1/fms/alerts?hours=24'), api('/v1/fms/floor' + withCbu()), api('/v1/fms/topology' + withCbu()),
  ]);
  if (s?.ok) store.summary = s; if (sa?.ok) store.summaryAll = sa; if (a?.ok) store.assets = a.assets || []; if (al?.ok) store.alerts = al.alerts || []; if (f?.ok) store.floor = f.tree;
  // A server without the v3 ledger endpoint simply has no topology; the 3D scene
  // then falls back to v2 placement for everything, which is the v2 behaviour.
  store.topology = t?.ok ? { rooms: t.rooms || [], unplaced: t.unplaced || [] } : null;
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
export const powerChain = (deviceId) => chain(`/v1/fms/power-chain/${devId(deviceId)}`, `d:${devId(deviceId)}`);
export const powerChainObject = (objectId) => chain(`/v1/fms/power-chain/object/${objectId}`, `o:${objectId}`);
const meData = () => ({ me: { name: store.me?.displayName || store.me?.name || '', email: store.me?.email || '' }, tenant: store.me?.tenantName || store.me?.tenant?.display_name || 'HAEA' });
function kpi() {
  const d = store.summary?.devices; if (!d) return { critical: '—', warn: '—', normal: '—', nodata: '—', total: '—', pc_critical: '0%', pc_warn: '0%', pc_normal: '0%', pc_nodata: '0%' };
  const nd = (d.nodata || 0) + (d.unreachable || 0);
  return { critical: d.critical ?? 0, warn: d.warn ?? 0, normal: d.normal ?? 0, nodata: nd, total: d.total ?? 0, pc_critical: pct(d.critical || 0, d.total), pc_warn: pct(d.warn || 0, d.total), pc_normal: pct(d.normal || 0, d.total), pc_nodata: pct(nd, d.total) };
}
function cbus() {
  const cur = getCbu(); const S = store.summaryAll || store.summary; const list = [{ cbu: 'all', label: '전체', total: S?.devices?.total ?? '', critical: S?.devices?.critical }, ...(S?.cbu_list || []).map(c => ({ cbu: c.cbu, label: c.cbu, total: c.total, critical: c.critical }))];
  return list.map(c => ({ ...c, crit: c.critical ? `●${c.critical}` : '', bg: c.cbu === cur ? '#393939' : 'transparent', fg: c.cbu === cur ? '#fff' : '#f4f4f4' }));
}
function alarmRows(limit = 6) {
  return store.alerts.slice(0, limit).map(a => ({ p: a.priority, ...(PR[a.priority] || PR.P4), msg: a.message, dev: a.device_label || a.device_id, devId: devId(a.device_id), t: hhmm(a.received_at) }));
}

export function mainData() {
  const base = evalLogic(Main.source, Main.props); const k = kpi();
  const assets = store.assets;
  const groups = Object.values(assets.reduce((g, a) => { (g[a.cbu] = g[a.cbu] || { name: a.cbu, n: 0, units: [] }); g[a.cbu].n++; g[a.cbu].units.push({ id: a.label, devId: a.id, color: SC[a.status] || NA }); return g; }, {})).map(g => ({ ...g, w: `${Math.min(300, Math.ceil(Math.sqrt(g.n)) * 2 * 25 + 60)}px` }));
  const batt = [...assets].filter(a => a.battery_pct != null).sort((a, b) => (a.health_score ?? 100) - (b.health_score ?? 100)).slice(0, 5).map(a => ({ id: a.label, devId: a.id, w: `${Math.max(5, Math.min(100, a.health_score ?? 80))}%`, color: SC[a.status] || OK, eol: t((a.health_score ?? 80) < 50 ? '교체 권고' : (a.health_score ?? 80) < 70 ? '관찰' : '양호') }));
  const sites = (store.summary?.cbu_list || []).map(c => ({ name: c.cbu, addr: `${c.total} UPS · ${t('정상')} ${c.ok ?? '—'} · ${t('경고')} ${c.warn ?? 0} · ${t('위험')} ${c.critical ?? 0}`, ups: c.total, alarms: c.critical ? `${c.critical} ${t('위험')}` : c.warn ? `${c.warn} ${t('경고')}` : t('정상'), color: c.critical ? CRIT : c.warn ? WARN : OK }));
  return { ...base, ...meData(), kpi: k, cbus: cbus(), groups: groups.length ? groups : base.groups, batt: batt.length ? batt : base.batt, sites: sites.length ? sites : base.sites, alarms: store.alerts.length ? alarmRows(6) : base.alarms, sample: !assets.length };
}

// `_fellBack` stops the "no id / fetch failed -> show the worst device" path from
// recursing forever when the API is down: the retry would fail the same way and
// pick the same device again.
export async function deviceData(id, _fellBack = false) {
  const base = evalLogic(Device.source, Device.props);
  let a = null;
  // Alerts carry device_id as 'ups-41'; /v1/fms/assets/:id parseInt()s its argument,
  // so the prefix has to come off or the fetch 404s and the screen silently shows
  // whichever device the fallback picks instead.
  const wanted = devId(id);
  if (wanted) { const r = await api(`/v1/fms/assets/${wanted}?range=24h`); if (r?.ok) a = { ...r.asset, _alerts: r.alerts || [], _metrics: r.metrics || [] }; }
  // Fall back to the worst device only when no id was asked for at all — that is the
  // sidebar's bare "장치" link. An id that was supplied but did not resolve must NOT
  // silently show a different device: the sample root-cause cards link to
  // "#/device?id=" because they carry a label and no device id, and the alarm rows
  // would 404 if their 'ups-' prefix ever slipped through. Those fall through to the
  // sample screen, which the badge marks as sample.
  if (!a && id === undefined && !_fellBack) { const pick = [...store.assets].sort((x, y) => ({ critical: 0, warn: 1 }[x.status] ?? 2) - ({ critical: 0, warn: 1 }[y.status] ?? 2))[0]; if (pick) return deviceData(pick.id, true); }
  const d = a ? {
    id: a.id, label: a.label, vendor: a.vendor || '', model: a.model || '', room: a.room || '', rack: a.rack || '', location: a.location || '', cbu: a.cbu || '', ip: a.ip || '—', serial: a.serial || '—', firmware: a.firmware || '—', poll: t('30s · 서버 폴러'),
    stColor: SC[a.status] || NA, stLabel: slabel(a.status), health: a.health_score ?? '—', healthPct: `${a.health_score ?? 0}%`,
    battery_pct: a.battery_pct ?? '—', load_pct: a.load_pct ?? '—', temp_c: a.temp_c ?? '—', runtime_min: a.runtime_min ?? '—', input_v: a.input_v ?? '—', output_v: a.output_v ?? '—', output_status: a.output_status || '—', battery_status: a.battery_status || '—',
    battOff: 188.5 * (1 - Math.min(100, a.battery_pct || 0) / 100), loadOff: 188.5 * (1 - Math.min(100, a.load_pct || 0) / 100), tempOff: 188.5 * (1 - Math.min(1, Math.max(0, ((a.temp_c || 20) - 15) / 30))), lastPoll: hhmm(a.last_polled),
  } : { id: '', label: 'KUS-UPS-03', vendor: 'APC', model: 'Smart-UPS SRT 5000VA', room: 'Irvine 서버실', rack: 'Rack A-04', location: '', cbu: 'KUS', ip: '10.40.12.33', serial: 'AS2318xxxxxx', firmware: 'UPS 14.3 / NMC 3.1', poll: '30s', stColor: CRIT, stLabel: 'P1 · 배터리 전압 저하', health: 61, healthPct: '61%', battery_pct: 71, load_pct: 48, temp_c: 27.1, runtime_min: 18, input_v: 118.2, output_v: 120.1, output_status: 'ONLINE', battery_status: 'NORMAL', battOff: 55, loadOff: 98, tempOff: 86, lastPoll: '14:31' };
  const hist = a && a._alerts.length ? a._alerts.map(x => ({ p: x.priority, ...(PR[x.priority] || PR.P4), msg: x.message, metric: x.metric || '—', val: x.value != null ? `${x.value} / ${x.threshold ?? '—'}` : '—', start: hhmm(x.received_at), end: '—', who: '—' })) : base.hist;
  return { ...base, ...meData(), d, hist, sample: !a };
}

export function alarmsData() {
  const base = evalLogic(Alarms.source, Alarms.props);
  const rows = store.alerts.length ? store.alerts.slice(0, 12).map(a => ({ p: a.priority, ...(PR[a.priority] || PR.P4), st: t(a.muted_until ? '점검모드' : '미확인'), stc: a.muted_until ? '#8d8d8d' : '#ff832b', rowbg: a.priority === 'P1' ? 'rgba(250,77,86,.06)' : 'transparent', msg: a.message, sub: `${a.metric || ''}${a.recurring ? ` · ${t('반복')}` : ''}`, dev: a.device_label || a.device_id, devId: devId(a.device_id), site: a.site || a.room || '', val: a.value != null ? `${a.value} / ${a.threshold ?? '—'}` : '—', t: hhmm(a.received_at), age: a.received_at ? `${Math.max(0, Math.round((Date.now() - a.received_at) / 60000))}m` : '—', agec: a.priority === 'P1' ? '#ff8389' : '#c6c6c6', who: '—' })) : base.rows;
  return { ...base, ...meData(), rows, sample: !store.alerts.length };
}
export function powerData() { const base = evalLogic(Power.source, Power.props); return { ...base, ...meData() }; }
export function nocData() { const base = evalLogic(NOC.source, NOC.props); const k = kpi(); return { ...base, ...meData(), kpi: k, clock: new Date().toLocaleTimeString('en-GB', { hour12: false }) }; }
