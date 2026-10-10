// Mock of /v1/me and /v1/fms/* with the exact key names of backend/routes/fms.routes.js
// NOTE: ids deliberately mirror the real backend's inconsistency —
//   assets/floor  → id is the numeric ups_devices.id
//   alerts        → device_id is 'ups-' || id
// Do not "tidy" these into one shape; the mock exists to catch code that
// assumes they are interchangeable.
const express = require('express'); const app = express(); app.use(express.json());
const now = Date.now();
const sites = { HMA: { loc: 'HMA Fountain Valley', rooms: { 'Server Room 1': 17, 'Server Room 2': 14 } }, KUS: { loc: 'KUS Irvine', rooms: { 'Server Room': 7 } }, HAEA_HQ: { loc: 'HAEA HQ', rooms: { 'IT Room': 6 } } };
const models = ['SRT3000', 'SRT5000', 'SRT8000', 'Symmetra LX'];
let n = 0; const assets = [];
for (const [cbu, s] of Object.entries(sites)) for (const [room, cnt] of Object.entries(s.rooms)) for (let i = 0; i < cnt; i++) {
  n++; const id = n; const rack = String.fromCharCode(65 + Math.floor(i / 10)) + String((i % 10) + 1).padStart(2, '0');
  const bad = [3, 12, 18, 23, 30, 41]; const status = n === 3 || n === 41 ? 'critical' : bad.includes(n) ? 'warn' : n === 23 ? 'nodata' : 'ok';
  assets.push({ id, label: `${cbu}-UPS-${String(n).padStart(2, '0')}`, location: s.loc, room, rack, ip: `10.${cbu === 'HMA' ? 10 : cbu === 'KUS' ? 40 : 20}.1.${10 + n}`, vendor: 'APC', model: models[n % 4], status, health_score: status === 'ok' ? 90 + (n % 9) : status === 'warn' ? 65 : status === 'critical' ? 38 : null, battery_pct: status === 'critical' ? 71 : 96 + (n % 4), load_pct: 30 + (n * 7) % 45, temp_c: +(23 + (n % 6) * 0.7).toFixed(1), runtime_min: status === 'critical' ? 18 : 25 + (n % 20), output_v: 120.1, input_v: 118.2, output_status: 'ONLINE', battery_status: 'NORMAL', last_polled: status === 'nodata' ? now - 20 * 60000 : now - (n % 25) * 1000, polling_enabled: 1, consecutive_fails: 0, poll_error: null, criticality: 'A', muted_until: null, cbu, serial: `AS23${1000 + n}`, firmware: 'UPS 14.3' });
}
const eff = a => (now - a.last_polled > 5 * 60000 ? 'nodata' : a.status);
const filt = q => q.cbu && q.cbu !== 'all' ? assets.filter(a => a.cbu === q.cbu) : assets;
app.get('/v1/me', (q, r) => r.json({ userId: 1, email: 'ericpark@ringonservice.com', displayName: 'Eric Park', role: 'fms_admin', persona: 'fms_admin', tenantId: 1, tenantName: 'HAEA', tenant: { id: 1, name: 'HAEA', display_name: 'HAEA', status: 'active', mode: 'prod', skus: ['fms'] }, sku: ['fms'], teamIds: [], landingRoute: '/fms' }));
app.get('/v1/fms/summary', (q, r) => { const list = filt(q.query); const c = s => list.filter(a => eff(a) === s).length; const cbu_list = Object.keys(sites).map(cb => { const l = assets.filter(a => a.cbu === cb); const cc = s => l.filter(a => eff(a) === s).length; return { cbu: cb, total: l.length, polling: l.length, critical: cc('critical'), warn: cc('warn'), unreachable: 0, ok: cc('ok'), nodata: cc('nodata') }; });
  r.json({ ok: true, devices: { total: list.length, polling: list.length, online: list.length, unreachable: 0, nodata: c('nodata'), critical: c('critical'), warn: c('warn'), normal: c('ok') }, alerts_24h: 7, tickets: { open: 2, p1: 1 }, sites: 3, cbu_list, _sum_check: list.length }); });
app.get('/v1/fms/floor', (q, r) => { const tree = {}; for (const a of filt(q.query)) { const L = tree[a.location] = tree[a.location] || { name: a.location, count: 0, critical: 0, warn: 0, ok: 0, unreachable: 0, nodata: 0, rooms: {} }; const R = L.rooms[a.room] = L.rooms[a.room] || { name: a.room, count: 0, critical: 0, warn: 0, ok: 0, unreachable: 0, nodata: 0, racks: {} }; const K = R.racks[a.rack] = R.racks[a.rack] || { name: a.rack, count: 0, critical: 0, warn: 0, ok: 0, unreachable: 0, nodata: 0, devices: [] }; const s = eff(a); for (const x of [L, R, K]) { x.count++; x[s] = (x[s] || 0) + 1; } K.devices.push({ id: a.id, label: a.label, status: s, battery_pct: a.battery_pct, last_polled: a.last_polled }); } r.json({ ok: true, tree }); });
app.get('/v1/fms/assets', (q, r) => { const list = filt(q.query).map(a => ({ ...a, status: eff(a) })); r.json({ ok: true, count: list.length, assets: list }); });
app.get('/v1/fms/assets/:id', (q, r) => { const a = assets.find(x => x.id === parseInt(q.params.id, 10)); if (!a) return r.status(404).json({ ok: false }); const metrics = Array.from({ length: 48 }, (_, i) => ({ ts: now - (47 - i) * 1800000, battery_pct: a.battery_pct, load_pct: a.load_pct + ((i * 7) % 5), temp_c: a.temp_c })); r.json({ ok: true, asset: { ...a, status: eff(a) }, metrics, thresholds: { battery_pct: { critical: 30, warn: 60, direction: 'below' }, load_pct: { critical: 90, warn: 75, direction: 'above' }, temp_c: { critical: 45, warn: 38, direction: 'above' } }, alerts: [] }); });
app.get('/v1/fms/alerts', (q, r) => { const mk = (i, a, p, metric, message, value, threshold, rec) => ({ id: i, device_id: 'ups-' + a.id, site: a.location, priority: p, metric, message, value, threshold, received_at: now - i * 11 * 60000, device_label: a.label, room: a.room, rack: a.rack, muted_until: null, recurring: !!rec });
  r.json({ ok: true, alerts: [mk(1, assets[2], 'P1', 'battery_pct', '배터리 전압 저하 · 25.1 V (임계 26.0)', 25.1, 26, false), mk(2, assets[40], 'P1', 'output_status', '입력 전원 상실 · 배터리 운전', 'ON BATTERY', 'ONLINE', false), mk(3, assets[11], 'P2', 'temp_c', '온도 상승 · 38.4°C (임계 38.0)', 38.4, 38, true), mk(4, assets[17], 'P2', 'load_pct', '부하 76% · 경고 임계 초과', 76, 75, false), mk(5, assets[29], 'P3', 'load_pct', '부하 55% · 경고 임계 근접', 55, 75, false), mk(6, assets[22], 'P4', 'heartbeat', 'probe 하트비트 지연 90s', 90, 60, true), mk(7, assets[5], 'P3', 'battery_pct', '런타임 감소 추세 −18% / 90d', 21, 25, false)] }); });
// ── v3 ledger endpoints ─────────────────────────────────────────────
// These run the REAL backend service against an in-memory SQLite seeded with the
// KMX ledger, so the frontend is developed against the production response shape
// rather than a hand-written fake that can drift from it.
const { DatabaseSync } = require('node:sqlite');
const T = require('../../../backend/services/fms-topology');
const TENANT = 10;
const ledgerDb = (() => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE ups_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, label TEXT, cbu TEXT,
    location TEXT, room TEXT, rack TEXT, status TEXT, last_polled INTEGER,
    health_score INTEGER, battery_pct INTEGER, load_pct INTEGER, temp_c REAL,
    decommissioned_at INTEGER, rack_id INTEGER, u_pos INTEGER, u_height INTEGER)`);
  const sql = require('fs').readFileSync(require('path').join(__dirname, '../../../backend/migrations/004_fms_topology.sql'), 'utf8');
  for (const st of sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').split(';').map(x => x.trim()).filter(Boolean)) {
    try { raw.exec(st); } catch (e) { if (!/duplicate column name/.test(e.message)) throw e; }
  }
  const db = {
    prepare: (q) => { const st = raw.prepare(q); return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) }; },
    exec: (q) => raw.exec(q),
  };
  // The 44 mock devices, so HMA/KUS/HAEA_HQ come back as `unplaced` and the
  // frontend has to fall back to v2 estimated placement for them.
  const ins = db.prepare('INSERT INTO ups_devices (tenant_id,label,cbu,location,room,rack,status,last_polled,health_score,battery_pct,load_pct,temp_c) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const a of assets) ins.run(TENANT, a.label, a.cbu, a.location, a.room, a.rack, eff(a), a.last_polled, a.health_score, a.battery_pct, a.load_pct, a.temp_c);
  T.importTopology(db, TENANT, require('../../../backend/seed/kmx_ccr_topology.json'), { mode: 'merge' });
  return db;
})();

// MOCK_NO_TOPOLOGY=1 simulates a server that has not had the v3 backend deployed
// yet — the frontend must fall back to v2 placement rather than showing an empty scene.
app.get('/v1/fms/topology', (q, r) => {
  if (process.env.MOCK_NO_TOPOLOGY) return r.status(404).json({ error: 'not found' });
  const { rooms, unplaced } = T.getTopology(ledgerDb, TENANT, (q.query.cbu || '').trim() || null);
  r.json({ ok: true, rooms, unplaced });
});
app.get('/v1/fms/topology/export', (q, r) => r.json({ ok: true, ...T.exportTopology(ledgerDb, TENANT, (q.query.cbu || '').trim() || null) }));
app.get('/v1/fms/topology/heat', (q, r) => {
  const metric = q.query.metric === 'temp' ? 'temp' : 'load';
  const rooms = T.getHeat(ledgerDb, TENANT, (q.query.cbu || '').trim() || null, metric);
  // KMX has no polled devices, so fall back to the ledger's design figures —
  // otherwise there is nothing to draw offline.
  const key = metric === 'temp' ? 'design_temp_c' : 'design_kw';
  for (const room of rooms) {
    if (room.cells.length) continue;
    const objs = T.getTopology(ledgerDb, TENANT, null).rooms.find(x => x.id === room.id)?.objects || [];
    room.cells = objs.filter(o => o.kind === 'rack' && o.attrs && o.attrs[key] != null && !o.attrs.empty)
      .map(o => ({ col: o.col, row: o.row, v: metric === 'temp' ? o.attrs[key] : Math.round((o.attrs[key] / 7) * 100) }));
    room.source = 'design';
  }
  r.json({ ok: true, metric, rooms });
});
app.get('/v1/fms/power-chain/object/:id', (q, r) => r.json({ ok: true, ...T.powerChainForObject(ledgerDb, TENANT, q.params.id) }));
app.get('/v1/fms/power-chain/:deviceId', (q, r) => r.json({ ok: true, ...T.powerChainForDevice(ledgerDb, TENANT, q.params.deviceId) }));

// Stub of POST /v1/fms/copilot. Shape only — no Claude call, no key needed.
// Set MOCK_COPILOT=503|404|429 to exercise the panel's failure states.
app.post('/v1/fms/copilot', (q, r) => {
  const forced = parseInt(process.env.MOCK_COPILOT || '0', 10);
  if (forced === 503) return r.status(503).json({ error: 'ai_disabled' });
  if (forced === 404) return r.status(404).json({ error: 'not found' });
  if (forced === 429) return r.status(429).json({ error: 'rate_limited', retry_after_s: 300 });
  const question = String(q.body?.question || '');
  const crit = assets.filter(a => eff(a) === 'critical');
  r.json({ ok: true,
    answer: `[mock] "${question}" \u2014 \uc704\ud5d8 ${crit.length}\ub300: ${crit.map(a => a.label).join(', ') || '\uc5c6\uc74c'}. ` +
      `\uc774 \uc751\ub2f5\uc740 \ubaa9 \uc11c\ubc84\uac00 \ub9cc\ub4e0 \uac83\uc774\uace0 Claude \ud638\ucd9c\uc740 \uc5c6\uc5c8\ub2e4.`,
    model: 'claude-opus-5', truncated: false,
    usage: { input_tokens: 1840, output_tokens: 210 }, cost_usd: 0.0144, latency_ms: 2300,
    grounded_on: { devices: assets.length, alerts: 7, focus: null } });
});
app.listen(3001, () => console.log('mock on 3001'));
