// APC NetBotz 750 simulator — room temperature, humidity, door, leak. Dev-only.
//
// Proves two things the collector cannot be trusted on otherwise: that sensor
// values arrive as tenths (23.2 °C as 232), and that sensors are matched by
// their LABEL rather than their index. Which port a leak cable is plugged into
// is a site decision, so a collector that assumes "index 1 is the inlet" is
// confidently wrong the first time someone moves a cable — and the order here
// is deliberately not the order anyone would guess.
//
//   SNMP_PORT=16501 TEMPS="Rack A01 inlet:23.2" STATES="Leak cable:2" node sim/sim-netbotz.js
const { agent, table, sysGroup, T } = require('./lib');

const PORT = parseInt(process.env.SNMP_PORT, 10) || 16501;
const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const LABEL = process.env.LABEL || 'Sim NetBotz 750';

const pairs = (s, dflt) => (s || dflt).split(',').map((p) => {
  const i = p.lastIndexOf(':');
  return { label: p.slice(0, i).trim(), value: parseFloat(p.slice(i + 1)) };
});

const temps = pairs(process.env.TEMPS, 'Rack A01 inlet:23.2,CCR ambient:24.8');
const hums = pairs(process.env.HUMIDITY, 'CCR ambient:41.8');
// 1 = closed/dry/clear, 2 = open/wet/detected. "Port 3" carries no meaning in
// its name on purpose: the collector must report it raw rather than invent one.
const states = pairs(process.env.STATES, 'Leak cable north aisle:1,Door CCR main:1,Port 3:1');

if (process.env.DRIFT !== '0') {
  setInterval(() => {
    for (const t of temps) t.value = Math.round((t.value + (Math.random() * 0.2 - 0.1)) * 10) / 10;
    for (const h of hums) h.value = Math.round((h.value + (Math.random() * 0.4 - 0.2)) * 10) / 10;
  }, 20_000);
}

const { mib } = agent({ port: PORT, community: COMMUNITY });
sysGroup(mib, { descr: 'APC NetBotz 750 (NBES7550) - Simulator', name: LABEL });

const sensorTable = (oid, name, rows, scale) => table(mib, {
  oid, name,
  columns: [
    { number: 1, name: `${name}Index`, type: T.Integer },
    { number: 4, name: `${name}Label`, type: T.OctetString },
    { number: 7, name: `${name}Value`, type: T.Integer },
  ],
  rows: () => rows.map((r, i) => [i + 1, r.label, Math.round(r.value * scale)]),
});

sensorTable('1.3.6.1.4.1.5528.100.4.1.1.1', 'nbTemp', temps, 10);       // tenths of a degree
sensorTable('1.3.6.1.4.1.5528.100.4.1.2.1', 'nbHumidity', hums, 10);    // tenths of a percent
sensorTable('1.3.6.1.4.1.5528.100.4.1.3.1', 'nbState', states, 1);      // raw contact state

console.log(`[sim-netbotz] ${LABEL} udp/${PORT} community=${COMMUNITY}`);
console.log(`[sim-netbotz] TRUE temps    ${temps.map(t => `${t.label}=${t.value}°C`).join(', ')}`);
console.log(`[sim-netbotz] TRUE humidity ${hums.map(h => `${h.label}=${h.value}%`).join(', ')}`);
console.log(`[sim-netbotz] TRUE states   ${states.map(s => `${s.label}=${s.value === 1 ? 'closed/dry' : 'open/wet'}`).join(', ')}`);
console.log('[sim-netbotz] served as tenths; labels are NOT in index order');
