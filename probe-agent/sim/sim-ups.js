// APC Smart-UPS (PowerNet-MIB) simulator — the scalars the UPS poller reads
// (services/snmp-helpers.js OID_APC_POWERNET). Dev and E2E only.
//
// Starts on line or on battery; switch while running by writing a line to
// stdin — `battery` or `online` — which is how the probe ↔ console E2E makes
// an alarm raise and then clear without touching a real UPS.
//
//   SNMP_PORT=16161 SNMP_COMMUNITY=public OUTPUT=battery node sim/sim-ups.js
const readline = require('readline');
const { agent, scalar, sysGroup, T } = require('./lib');

const PORT = parseInt(process.env.SNMP_PORT, 10) || 16161;
const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const LABEL = process.env.LABEL || 'Sim Smart-UPS SRT5K';

const s = {
  onBattery: process.env.OUTPUT === 'battery',
  charge: parseFloat(process.env.CHARGE || '100'),
};

const { mib } = agent({ port: PORT, community: COMMUNITY });
sysGroup(mib, { descr: 'APC Web/SNMP Management Card (MB:v4.2.6 PF:v2.2.0.1 PN:apc_hw21_aos) - Simulator', name: LABEL });

const apc = (sub) => `1.3.6.1.4.1.318.1.1.1.${sub}`;
const scalars = [
  ['1.3.6.1.2.1.33.1.1.1', 'upsIdentManufacturer', T.OctetString, () => 'APC'],
  [apc('1.1.1'), 'upsBasicIdentModel', T.OctetString, () => 'SRT5KRMXLT'],
  [apc('1.2.1'), 'upsAdvIdentFirmwareRevision', T.OctetString, () => 'UPS 16.9 (ID1031)'],
  [apc('2.1.1'), 'upsBasicBatteryStatus', T.Integer, () => 2],                       // normal
  [apc('2.1.2'), 'upsBasicBatteryTimeOnBattery', T.TimeTicks, () => (s.onBattery ? 6000 : 0)],
  [apc('2.2.1'), 'upsAdvBatteryCapacity', T.Gauge, () => Math.round(s.charge)],
  [apc('2.2.2'), 'upsAdvBatteryTemperature', T.Gauge, () => 24],
  [apc('2.2.3'), 'upsAdvBatteryRunTimeRemaining', T.TimeTicks, () => 45 * 6000],     // 45 min
  [apc('2.2.4'), 'upsAdvBatteryReplaceIndicator', T.Integer, () => 1],               // noBatteryNeedsReplacing
  [apc('3.2.1'), 'upsAdvInputLineVoltage', T.Gauge, () => (s.onBattery ? 0 : 120)],
  [apc('4.1.1'), 'upsBasicOutputStatus', T.Integer, () => (s.onBattery ? 3 : 2)],    // 3 onBattery, 2 onLine
  [apc('4.2.1'), 'upsAdvOutputVoltage', T.Gauge, () => 120],
  [apc('4.2.3'), 'upsAdvOutputLoad', T.Gauge, () => 38],
];
for (const [oid, name, type, get] of scalars) scalar(mib, { oid, name, type, get });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === 'battery') s.onBattery = true;
  else if (cmd === 'online') s.onBattery = false;
  else return;
  console.log(`[sim-ups] output ${s.onBattery ? 'onBattery' : 'onLine'}`);
});

console.log(`[sim-ups] ${LABEL} on udp/${PORT}, community "${COMMUNITY}", output ${s.onBattery ? 'onBattery' : 'onLine'}`);
