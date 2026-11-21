// HAEA mirror lab only (WO-INT-015) — one process answering SNMP for all 41 Exhibit 1 NMC IPs.
// Each IP gets its own agent bound to that address (udp/161), with the same PowerNet-MIB scalars
// as probe-agent/sim/sim-ups.js and per-device state, so the collector sees 41 distinct UPS.
//
//   node ups-fleet.js fleet.csv            (root — port 161; IPs must be on a local interface)
//   curl -X POST 'http://127.0.0.1:9161/battery?label=HMA-UPS-PG-A'   → On Battery (P1 demo)
//   curl -X POST 'http://127.0.0.1:9161/online?label=HMA-UPS-PG-A'    → back on line
//   curl http://127.0.0.1:9161/state
const fs = require('fs');
const http = require('http');
const path = require('path');
const { agent, scalar, sysGroup, T } = require(process.env.SIM_LIB || path.join(__dirname, 'lib.js'));

const csv = fs.readFileSync(process.argv[2] || path.join(__dirname, 'fleet.csv'), 'utf8').trim().split('\n');
const head = csv.shift().split(',');
const devs = csv.map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));

const apc = (sub) => `1.3.6.1.4.1.318.1.1.1.${sub}`;
const state = {};
devs.forEach((d, i) => {
  // A believable fleet: mostly normal, a few warn/critical so the dashboard is not all green.
  const s = state[d.label] = { onBattery: false, charge: 100, load: 25 + (i * 7) % 40, temp: 23 + (i % 5), replace: 1 };
  if (i % 13 === 5) s.load = 92;                 // warn: load ≥ 90
  if (i % 17 === 9) { s.charge = 45; }           // warn: capacity < 50
  if (i === 20) s.replace = 2;                   // battery needs replacing
  const { mib } = agent({ port: 161, community: d.snmp_community || 'public', address: d.nmc_ip });
  sysGroup(mib, { descr: `APC Web/SNMP Management Card (MB:v4.2.6 PF:v2.2.0.1) - Lab Simulator ${d.label}`, name: d.label, location: d.site });
  const scalars = [
    ['1.3.6.1.2.1.33.1.1.1', 'upsIdentManufacturer', T.OctetString, () => 'APC'],
    [apc('1.1.1'), 'upsBasicIdentModel', T.OctetString, () => d.model],
    [apc('1.2.1'), 'upsAdvIdentFirmwareRevision', T.OctetString, () => 'UPS 16.9 (ID1031)'],
    [apc('1.2.3'), 'upsAdvIdentSerialNumber', T.OctetString, () => d.serial],
    [apc('2.1.1'), 'upsBasicBatteryStatus', T.Integer, () => (s.charge < 30 ? 3 : 2)],
    [apc('2.1.2'), 'upsBasicBatteryTimeOnBattery', T.TimeTicks, () => (s.onBattery ? 6000 : 0)],
    [apc('2.2.1'), 'upsAdvBatteryCapacity', T.Gauge, () => Math.round(s.charge)],
    [apc('2.2.2'), 'upsAdvBatteryTemperature', T.Gauge, () => s.temp],
    [apc('2.2.3'), 'upsAdvBatteryRunTimeRemaining', T.TimeTicks, () => Math.round(s.charge * 0.45) * 6000],
    [apc('2.2.4'), 'upsAdvBatteryReplaceIndicator', T.Integer, () => s.replace],
    [apc('3.2.1'), 'upsAdvInputLineVoltage', T.Gauge, () => (s.onBattery ? 0 : 120)],
    [apc('4.1.1'), 'upsBasicOutputStatus', T.Integer, () => (s.onBattery ? 3 : 2)],
    [apc('4.2.1'), 'upsAdvOutputVoltage', T.Gauge, () => 120],
    [apc('4.2.3'), 'upsAdvOutputLoad', T.Gauge, () => s.load],
  ];
  for (const [oid, name, type, get] of scalars) scalar(mib, { oid, name, type, get });
});
// On battery the charge drains; on line it recovers.
setInterval(() => { for (const s of Object.values(state)) s.charge = s.onBattery ? Math.max(5, s.charge - 1) : Math.min(100, s.charge + 0.5); }, 10_000);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const s = state[u.searchParams.get('label')];
  if (req.method === 'POST' && s && (u.pathname === '/battery' || u.pathname === '/online')) s.onBattery = u.pathname === '/battery';
  else if (u.pathname !== '/state') { res.writeHead(404); return res.end('label?\n'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(u.pathname === '/state' ? state : { [u.searchParams.get('label')]: s }) + '\n');
}).listen(9161, '127.0.0.1');
console.log(`[ups-fleet] ${devs.length} agents on udp/161, control http://127.0.0.1:9161`);
