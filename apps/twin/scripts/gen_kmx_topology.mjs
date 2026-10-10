// Generates src/demo/kmx_ccr_topology.json — the KMX CCR design sample as a ledger (v3 brief §8 + addendum A2).
// Coordinates: tiles of 0.6 m, origin at the room's north-west corner (col → east, row → south). Fractions allowed.
import { writeFileSync, mkdirSync } from 'node:fs';
const T = 0.6, W = 14.4, D = 13.2; // 24 × 22 tiles (DemoScene room 14 × 12.7 m, padded)
const cx = (x) => +((x + W / 2) / T).toFixed(2), rz = (z) => +((z + D / 2) / T).toFixed(2);
let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

const objects = [], devices = [], links = [], alarms = [];
// ── racks: 6 rows (A–F), 62 racks, alternating hot/cold aisle ──
const rowSpec = [11, 11, 10, 10, 10, 10]; const rows = 'ABCDEF';
const special = { B07: { kw: 6.4, temp: 27.9, status: 'critical' }, B02: { kw: 4.3, temp: 25.1, status: 'hot' }, A04: { kw: 4.8, temp: 25.4, status: 'hot' }, C01: { kw: 3.9, temp: 26.3, status: 'warn' }, C03: { kw: 3.6, temp: 26.1, status: 'warn' }, D05: { kw: 4.6, temp: 24.9, status: 'hot' }, D06: { kw: 4.1, temp: 24.7, status: 'hot' }, F03: { kw: 4.2, temp: 24.4, status: 'hot' } };
const empties = new Set(['A09', 'A10', 'C10', 'E09', 'E10', 'F07', 'F08', 'F09', 'F10']);
let z = -D / 2 + 2.3;
rowSpec.forEach((n, ri) => {
  const rowLen = n * 0.62; let x = -rowLen / 2 + 0.3 + (ri % 2 ? 0.3 : 0);
  for (let i = 0; i < n; i++) {
    const name = rows[ri] + String(i + 1).padStart(2, '0'); const sp = special[name]; const empty = empties.has(name);
    const kw = empty ? 0 : sp ? sp.kw : +(0.6 + rnd() * 2.4).toFixed(1); const temp = empty ? 23 : sp ? sp.temp : +(22.8 + rnd() * 1.8).toFixed(1);
    objects.push({ name, kind: 'rack', col: cx(x), row: rz(z), w: 1, d: 2, face: ri % 2 === 0 ? 'S' : 'N', u_height: 42, attrs: { kw, temp_c: temp, status: empty ? 'empty' : sp ? sp.status : 'ok', pdu: ri < 3 ? 'PDU-A' : 'PDU-B', cb: `CB-${(i % 12) + 1}` } });
    x += 0.62;
  }
  z += 1.2 + (ri % 2 === 0 ? 1.2 : 1.0);
});
// ── infrastructure ──
const infra = [
  { name: 'CRAC-1', kind: 'crac', x: -4.6, z: -D / 2 + 0.6, w: 2.4, d: 1.5, attrs: { rt: 30, fan_pct: 72, status: 'ok', supply_c: 18.3 } },
  { name: 'CRAC-2', kind: 'crac', x: 0, z: -D / 2 + 0.6, w: 2.4, d: 1.5, attrs: { rt: 30, fan_pct: 68, status: 'warn', supply_c: 20.5, note: '팬 감속 · 필터 경보' } },
  { name: 'CRAC-3', kind: 'crac', x: 4.6, z: -D / 2 + 0.6, w: 2.4, d: 1.5, attrs: { rt: 20, fan_pct: 70, status: 'ok', supply_c: 18.3 } },
  { name: 'UPS-1', kind: 'ups_cabinet', x: W / 2 - 0.7, z: -3.0, w: 1.5, d: 1.5, attrs: { capacity_kw: 40, load_pct: 48, status: 'ok' } },
  { name: 'UPS-2', kind: 'ups_cabinet', x: W / 2 - 0.7, z: -1.4, w: 1.5, d: 1.5, attrs: { capacity_kw: 40, load_pct: 44, status: 'ok' } },
  { name: 'PDU-A', kind: 'pdu_cabinet', x: -W / 2 + 0.6, z: -3.4, w: 1, d: 1.5, attrs: { rated_a: 125, load_a: 61, status: 'ok' } },
  { name: 'PDU-B', kind: 'pdu_cabinet', x: -W / 2 + 0.6, z: 2.6, w: 1, d: 1.5, attrs: { rated_a: 125, load_a: 54, status: 'ok' } },
  { name: 'PANEL-1', kind: 'panel', x: W / 2 - 0.3, z: -5.2, w: 1, d: 0.4, attrs: { rated_a: 200, label: 'LP-1' } },
  { name: 'PANEL-2', kind: 'panel', x: W / 2 - 0.3, z: 0.2, w: 1, d: 0.4, attrs: { rated_a: 200, label: 'LP-2' } },
  { name: 'UTILITY', kind: 'panel', x: W / 2 - 0.3, z: 5.6, w: 1.5, d: 0.4, attrs: { rated_a: 400, utility: true, label: 'CFE 인입 / 발전기 ATS' } },
  { name: 'FM-200', kind: 'fm200', x: W / 2 - 0.6, z: 2.9, w: 1, d: 2.5, attrs: { status: 'ok', cylinders: 3 } },
  { name: 'DOOR', kind: 'door', x: -W / 2 + 2.0, z: D / 2 - 0.1, w: 2, d: 0.3, attrs: {} },
];
infra.forEach(o => objects.push({ name: o.name, kind: o.kind, col: cx(o.x - o.w * T / 2), row: rz(o.z - o.d * T / 2), w: o.w, d: o.d, attrs: o.attrs }));
[[-5, -3.2], [0, -3.2], [5, -3.2], [-5, 3.2], [0, 3.2], [5, 3.2]].forEach((p, i) => objects.push({ name: `TH-${i + 1}`, kind: 'sensor', col: cx(p[0]), row: rz(p[1]), attrs: { temp_c: +(23.2 + rnd() * 1.4).toFixed(1), humidity: Math.round(42 + rnd() * 5) } }));
[[-4, 0], [0.5, 0.5], [4.5, -1]].forEach((p, i) => objects.push({ name: `SMK-${i + 1}`, kind: 'smoke', col: cx(p[0]), row: rz(p[1]), attrs: { status: 'ok' } }));
const zones = [{ name: 'ZONE-1', x: -4.6, z: -D / 2 + 1.3, w: 2.4, d: 1.4, st: 'ok' }, { name: 'ZONE-2', x: 0, z: -D / 2 + 1.3, w: 2.4, d: 1.4, st: 'ok' }, { name: 'ZONE-3', x: 4.6, z: -D / 2 + 1.3, w: 2.4, d: 1.4, st: 'leak' }, { name: 'ZONE-4', x: W / 2 - 1.3, z: -2.3, w: 1.6, d: 3.0, st: 'ok' }];
zones.forEach(zn => objects.push({ name: zn.name, kind: 'leak_zone', attrs: { status: zn.st, zone_poly: [[cx(zn.x - zn.w / 2), rz(zn.z - zn.d / 2)], [cx(zn.x + zn.w / 2), rz(zn.z - zn.d / 2)], [cx(zn.x + zn.w / 2), rz(zn.z + zn.d / 2)], [cx(zn.x - zn.w / 2), rz(zn.z + zn.d / 2)]] } }));

// ── devices (UPS + network/UC/servers) ──
const dev = (label, kind, model, rack, u_pos, extra = {}) => devices.push({ label, kind, model, rack, u_pos, status: 'ok', ...extra });
dev('KMX-UPS-01', 'ups', 'Symmetra PX 40kW', 'UPS-1', 1, { vendor: 'APC', u_height: 10, battery_pct: 100, load_pct: 48, temp_c: 24.1, runtime_min: 31, ip: '10.60.1.11' });
dev('KMX-UPS-02', 'ups', 'Symmetra PX 40kW', 'UPS-2', 1, { vendor: 'APC', u_height: 10, battery_pct: 100, load_pct: 44, temp_c: 23.8, runtime_min: 34, ip: '10.60.1.12' });
dev('A01-UPS', 'ups', 'Smart-UPS SRT 3000VA RM', 'A01', 2, { vendor: 'APC', battery_pct: 98, load_pct: 41, temp_c: 24.6, runtime_min: 22, ip: '10.60.1.13' });
dev('B07-UPS', 'ups', 'Smart-UPS SRT 5000VA RM', 'B07', 2, { vendor: 'APC', status: 'critical', battery_pct: 71, load_pct: 88, temp_c: 29.4, runtime_min: 9, ip: '10.60.1.14' });
dev('D01-UPS', 'ups', 'Smart-UPS SRT 3000VA RM', 'D01', 2, { vendor: 'APC', battery_pct: 99, load_pct: 35, temp_c: 24.0, runtime_min: 26, ip: '10.60.1.15' });
dev('CCR-CORE-1', 'switch', 'Catalyst 9500-48Y4C', 'A01', 40, { vendor: 'Cisco', ports_total: 48, ports_up: 31, ip: '10.60.1.21' });
dev('CCR-CORE-2', 'switch', 'Catalyst 9500-48Y4C', 'A01', 38, { vendor: 'Cisco', ports_total: 48, ports_up: 29, ip: '10.60.1.22' });
dev('CUCM-PUB', 'server', 'UCS C220 M6', 'A02', 20, { vendor: 'Cisco', ip: '10.60.1.31', note: 'UC 콜 매니저' });
dev('CUCM-SUB1', 'server', 'UCS C220 M6', 'A02', 22, { vendor: 'Cisco', ip: '10.60.1.32', status: 'warn', note: 'DB 복제 지연' });
dev('CUBE-SBC-1', 'sbc', 'ISR 4451 CUBE', 'A02', 36, { vendor: 'Cisco', ports_total: 8, ports_up: 6, ip: '10.60.1.41', note: 'SIP 트렁크 Telmex' });
dev('GENESYS-APP1', 'server', 'PowerEdge R650', 'B01', 20, { vendor: 'Dell', ip: '10.60.1.51' });
dev('GENESYS-APP2', 'server', 'PowerEdge R650', 'B01', 22, { vendor: 'Dell', ip: '10.60.1.52' });
dev('GENESYS-DB', 'server', 'PowerEdge R750', 'B02', 24, { vendor: 'Dell', ip: '10.60.1.53', u_height: 2 });
dev('PP-A02', 'patch', 'Patch Panel 24', 'A02', 42, {});
'ABCDEF'.split('').forEach((r, i) => dev(`ACC-${r}`, 'switch', 'Catalyst 9300-48P', `${r}01`, 41, { vendor: 'Cisco', ports_total: 48, ports_up: 30 + i, ip: `10.60.2.${10 + i}` }));

// ── power links: rack → PDU (CB) → UPS → PANEL → UTILITY ──
objects.filter(o => o.kind === 'rack' && o.attrs.status !== 'empty').forEach(o => links.push({ src: o.name, src_type: 'object', dst: o.attrs.pdu, dst_type: 'object', dst_port: o.attrs.cb, rated_a: 16, phase: 'L' + ((o.col | 0) % 3 + 1) }));
links.push({ src: 'PDU-A', src_type: 'object', dst: 'KMX-UPS-01', dst_type: 'ups_device', dst_port: 'OUT-1', rated_a: 125, phase: '3P' });
links.push({ src: 'PDU-B', src_type: 'object', dst: 'KMX-UPS-02', dst_type: 'ups_device', dst_port: 'OUT-1', rated_a: 125, phase: '3P' });
links.push({ src: 'KMX-UPS-01', src_type: 'ups_device', dst: 'PANEL-1', dst_type: 'object', dst_port: 'LP1-1', circuit: 'LP1-1', rated_a: 160, phase: '3P' });
links.push({ src: 'KMX-UPS-02', src_type: 'ups_device', dst: 'PANEL-2', dst_type: 'object', dst_port: 'LP2-1', circuit: 'LP2-1', rated_a: 160, phase: '3P' });
links.push({ src: 'PANEL-1', src_type: 'object', dst: 'UTILITY', dst_type: 'object', circuit: 'MAIN-1', rated_a: 200, phase: '3P' });
links.push({ src: 'PANEL-2', src_type: 'object', dst: 'UTILITY', dst_type: 'object', circuit: 'MAIN-2', rated_a: 200, phase: '3P' });
links.push({ src: 'CRAC-1', src_type: 'object', dst: 'PANEL-1', dst_type: 'object', circuit: 'LP1-9', rated_a: 63, phase: '3P', note: '비 UPS 계통' });
links.push({ src: 'CRAC-2', src_type: 'object', dst: 'PANEL-2', dst_type: 'object', circuit: 'LP2-9', rated_a: 63, phase: '3P' });
links.push({ src: 'CRAC-3', src_type: 'object', dst: 'PANEL-2', dst_type: 'object', circuit: 'LP2-10', rated_a: 40, phase: '3P' });
devices.filter(d => d.kind !== 'ups').forEach(d => links.push({ src: d.label, src_type: 'device', src_port: 'PSU1', dst: d.rack, dst_type: 'object', dst_port: 'PDU-L', rated_a: 10 }));
devices.filter(d => d.kind === 'ups' && d.rack !== 'UPS-1' && d.rack !== 'UPS-2').forEach(d => links.push({ src: d.label, src_type: 'ups_device', dst: d.rack, dst_type: 'object', dst_port: 'PDU-R', rated_a: 20 }));

// ── alarms (sample, mirrors the demo story) ──
alarms.push({ id: 'A-1151', priority: 'P1', object: 'B07', device: 'B07-UPS', metric: 'temp_c', message: '랙 B07 핫스팟 · 상단 27.9 °C · UPS 부하 88 %', value: 27.9, threshold: 26, received_at: '11:02', ai: 'CRAC-2 팬 감속과 상관 91 % · 권고: CRAC-2 필터 교체, B07 부하 2 kW를 B09로 이전' });
alarms.push({ id: 'A-1152', priority: 'P2', object: 'CRAC-2', metric: 'fan_pct', message: 'CRAC-2 팬 감속 68 % · 필터 차압 경보', value: 68, threshold: 70, received_at: '10:48' });
alarms.push({ id: 'A-1153', priority: 'P1', object: 'ZONE-3', metric: 'leak', message: '누수 감지 ZONE-3 · CRAC-3 하부 (LP6000)', value: 1, threshold: 0, received_at: '11:02', ai: 'HAEM 시설팀 확인 중 · 티켓 T-1151 · CRAC-3 응축수 배관 점검' });
alarms.push({ id: 'A-1154', priority: 'P3', object: 'A02', device: 'CUCM-SUB1', metric: 'uc_replication', message: 'CUCM-SUB1 DB 복제 지연 42 s', value: 42, threshold: 30, received_at: '09:15' });

const out = { cbu: 'KMX', rooms: [{ location: 'KMX Pesquería', name: 'CCR', cols: 24, rows: 22, tile_mm: 600, height_mm: 3000, objects, devices, power_links: links }], alarms };
mkdirSync('src/demo', { recursive: true });
writeFileSync('src/demo/kmx_ccr_topology.json', JSON.stringify(out, null, 1));
console.log('objects', objects.length, 'devices', devices.length, 'links', links.length);
