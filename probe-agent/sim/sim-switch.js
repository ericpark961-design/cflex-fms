// Switch simulator with a real IF-MIB table and ENTITY-SENSOR. Dev-only.
//
// The production sim-network.js serves ifNumber and some custom counters, but
// no interface table at all — so the port counts the twin draws could not be
// verified against anything. This serves the table, including the rows that
// are the actual trap:
//
//   · a VLAN interface, a loopback and a port-channel sit in the same table as
//     the ports. Counting every row made a 48-port switch a 70-port one.
//   · one port is DOWN while administratively up (a fault) and one is
//     administratively shut (a configuration). Treating those alike makes a
//     correctly configured switch look half broken.
//   · the inlet temperature is served as 420 with a scale enum of 9 and a
//     precision of 1, which is 42 °C. Applying either as a multiplier gives
//     42,000 or 420.
//
//   SNMP_PORT=16701 PORTS=48 DOWN=2 SHUT=1 TEMP_C=42 node sim/sim-switch.js
const { agent, scalar, table, sysGroup, T } = require('./lib');

const PORT = parseInt(process.env.SNMP_PORT, 10) || 16701;
const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const LABEL = process.env.LABEL || 'Sim Catalyst 9300-48P';
const PORTS = parseInt(process.env.PORTS, 10) || 48;
const DOWN = parseInt(process.env.DOWN, 10) || 2;        // down, admin up -> faults
const SHUT = parseInt(process.env.SHUT, 10) || 1;        // administratively shut
const TEMP_C = parseFloat(process.env.TEMP_C || '42');

const IF_ETHERNET = 6, IF_LOOPBACK = 24, IF_PROP_VIRTUAL = 53, IF_LAG = 161;

// Physical ports first, then the virtual rows that must not be counted.
const rows = [];
for (let i = 1; i <= PORTS; i++) {
  const shut = i > PORTS - SHUT;
  const down = !shut && i > PORTS - SHUT - DOWN;
  rows.push([rows.length + 1, `GigabitEthernet1/0/${i}`, IF_ETHERNET,
    shut ? 2 : 1,                      // ifAdminStatus
    (shut || down) ? 2 : 1]);          // ifOperStatus
}
rows.push([rows.length + 1, 'Vlan1', IF_PROP_VIRTUAL, 1, 1]);
rows.push([rows.length + 1, 'Vlan100', IF_PROP_VIRTUAL, 1, 1]);
rows.push([rows.length + 1, 'Loopback0', IF_LOOPBACK, 1, 1]);
rows.push([rows.length + 1, 'Port-channel1', IF_LAG, 1, 1]);

const { mib } = agent({ port: PORT, community: COMMUNITY });
sysGroup(mib, { descr: 'Cisco IOS Software, Catalyst L3 Switch - Simulator', name: LABEL });

scalar(mib, { oid: '1.3.6.1.2.1.2.1', name: 'ifNumber', type: T.Integer, get: () => rows.length });
table(mib, {
  oid: '1.3.6.1.2.1.2.2.1', name: 'ifEntry',
  columns: [
    { number: 1, name: 'ifIndex', type: T.Integer },
    { number: 2, name: 'ifDescr', type: T.OctetString },
    { number: 3, name: 'ifType', type: T.Integer },
    { number: 7, name: 'ifAdminStatus', type: T.Integer },
    { number: 8, name: 'ifOperStatus', type: T.Integer },
  ],
  rows: () => rows,
});

// ENTITY-SENSOR: value 420, scale enum 9 (10^0), precision 1 -> 42.0 °C
table(mib, {
  oid: '1.3.6.1.2.1.99.1.1.1', name: 'entPhySensorEntry',
  columns: [
    { number: 1, name: 'entPhySensorType', type: T.Integer },
    { number: 2, name: 'entPhySensorScale', type: T.Integer },
    { number: 3, name: 'entPhySensorPrecision', type: T.Integer },
    { number: 4, name: 'entPhySensorValue', type: T.Integer },
    { number: 5, name: 'entPhySensorOperStatus', type: T.Integer },
  ],
  // entPhySensorEntry is indexed by entPhysicalIndex, which is not one of its
  // own columns, so the type column stands in as the index here. That means
  // the two rows must be different sensor types: the second is a humidity
  // sensor reporting nonoperational, which tests the same rule — a sensor that
  // says it is broken has no reading, and 0 is not a measurement.
  rows: () => [
    [8, 9, 1, Math.round(TEMP_C * 10), 1],      // celsius, ok
    [9, 9, 1, 0, 3],                            // percentRH, nonoperational
  ],
  index: [1],
});

// CISCO-ENVMON supplies: one normal, one notPresent — the empty bay of a
// dual-supply chassis, which is not a failed supply.
table(mib, {
  oid: '1.3.6.1.4.1.9.9.13.1.5.1', name: 'ciscoEnvMonSupplyStatusEntry',
  columns: [
    { number: 1, name: 'supplyIndex', type: T.Integer },
    { number: 2, name: 'supplyDescr', type: T.OctetString },
    { number: 3, name: 'supplyState', type: T.Integer },
  ],
  rows: () => [[1, 'Sw1 PS1 PWR-C1-715WAC', 1], [2, 'Sw1 PS2 empty', 5]],
});

console.log(`[sim-switch] ${LABEL} udp/${PORT} community=${COMMUNITY}`);
console.log(`[sim-switch] TRUE ports ${PORTS} physical (+4 virtual rows that must NOT count)`);
console.log(`[sim-switch] TRUE up ${PORTS - DOWN - SHUT}, down-unexpected ${DOWN}, admin-shut ${SHUT}`);
console.log(`[sim-switch] TRUE inlet ${TEMP_C}°C served as ${Math.round(TEMP_C * 10)} with scale=9 precision=1`);
console.log('[sim-switch] a second sensor (humidity) is nonoperational and must be ignored');
