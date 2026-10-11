// APC Rack PDU simulator — rPDU2 group of the PowerNet-MIB. Dev-only.
//
// It exists for one reason: rPDU2PhaseStatusCurrent returns TENTHS of an amp,
// and a collector that reads it as amps reports a 16 A circuit at 160 A. Every
// capacity figure above it becomes nonsense and nothing on screen looks wrong.
// That cannot be checked against hardware on the far side of a network we have
// no route to, so it is checked here: this agent serves raw integers whose true
// values are printed in plain decimal at startup, and the collector has to
// arrive at those numbers.
//
//   SNMP_PORT=16401 LOAD_A=6.1,7.4,5.2 PDU_TYPE=switched node sim/sim-pdu.js
const { agent, table, sysGroup, T } = require('./lib');

const PORT = parseInt(process.env.SNMP_PORT, 10) || 16401;
const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const LABEL = process.env.LABEL || 'Sim Rack PDU';
const MODEL = process.env.MODEL || 'AP8959 Switched Rack PDU';
const VOLTS = parseInt(process.env.VOLTS, 10) || 220;
const PDU_TYPE = (process.env.PDU_TYPE || 'switched').toLowerCase();
const OUTLETS = parseInt(process.env.OUTLETS, 10) || 24;
const DRIFT = process.env.DRIFT !== '0';

const TRUE_A = (process.env.LOAD_A || '6.1,7.4,5.2').split(',').map(Number);
const state = {
  phases: TRUE_A.slice(),
  outlets: Array.from({ length: OUTLETS }, (_, i) => (i < OUTLETS - 2 ? 2 : 1)),  // 2=on 1=off
};

// Bounded drift. A simulator whose numbers wander into the next order of
// magnitude hides exactly the bug it is here to catch.
if (DRIFT) {
  setInterval(() => {
    state.phases = state.phases.map((a, i) => Math.max(TRUE_A[i] * 0.8,
      Math.min(TRUE_A[i] * 1.2, Math.round((a + (Math.random() * 0.2 - 0.1)) * 10) / 10)));
  }, 20_000);
}

const totalKw = () => state.phases.reduce((s, a) => s + a * VOLTS, 0) / 1000;
const phaseState = (a) => (a > 14 ? 4 : a > 11 ? 3 : a < 0.5 ? 2 : 1);

const { mib } = agent({ port: PORT, community: COMMUNITY });
sysGroup(mib, { descr: `APC ${MODEL} - Simulator`, name: LABEL });

// rPDU2DeviceStatusEntry — a TABLE indexed by device number, with power in
// HUNDREDTHS of a kW. Registering these as scalars is what made a collector ask
// for `...4.3.1.5` and get noSuchObject from both this agent and real hardware.
const started = Date.now();
table(mib, {
  oid: '1.3.6.1.4.1.318.1.1.26.4.3.1', name: 'rPDU2DeviceStatusEntry',
  columns: [
    { number: 1, name: 'devIndex', type: T.Integer },
    { number: 3, name: 'devLoadState', type: T.Integer },
    { number: 5, name: 'devPower', type: T.Integer },
    { number: 6, name: 'devPeakPower', type: T.Integer },
    { number: 11, name: 'devEnergy', type: T.Integer },
  ],
  rows: () => [[1,
    phaseState(Math.max(...state.phases)),
    Math.round(totalKw() * 100),
    Math.round(totalKw() * 1.3 * 100),
    Math.round(((Date.now() - started) / 3.6e6) * totalKw() * 10)]],
});

// rPDU2PhaseStatus — current in TENTHS of an amp. The whole point.
table(mib, {
  oid: '1.3.6.1.4.1.318.1.1.26.6.3.1', name: 'rPDU2PhaseStatusEntry',
  columns: [
    { number: 1, name: 'phIndex', type: T.Integer },
    { number: 3, name: 'phNumber', type: T.Integer },
    { number: 4, name: 'phLoadState', type: T.Integer },
    { number: 5, name: 'phCurrent', type: T.Integer },
    { number: 6, name: 'phVoltage', type: T.Integer },
  ],
  rows: () => state.phases.map((a, i) => [i + 1, i + 1, phaseState(a), Math.round(a * 10), VOLTS]),
});

// Outlet tables only for the type this unit claims to be — a basic PDU answers
// noSuchObject here, which is what makes "do not walk what does not exist"
// testable.
if (PDU_TYPE === 'switched') {
  table(mib, {
    oid: '1.3.6.1.4.1.318.1.1.26.9.2.3.1', name: 'rPDU2OutletSwitchedStatusEntry',
    columns: [
      { number: 1, name: 'swIndex', type: T.Integer },
      { number: 5, name: 'swState', type: T.Integer },
    ],
    rows: () => state.outlets.map((s, i) => [i + 1, s]),
  });
} else if (PDU_TYPE === 'metered') {
  table(mib, {
    oid: '1.3.6.1.4.1.318.1.1.26.10.2.2.1', name: 'rPDU2OutletMeteredStatusEntry',
    columns: [
      { number: 1, name: 'mtIndex', type: T.Integer },
      { number: 5, name: 'mtCurrent', type: T.Integer },
    ],
    rows: () => state.outlets.map((_, i) => [i + 1, Math.round((state.phases[i % state.phases.length] / 8) * 10)]),
  });
}

console.log(`[sim-pdu] ${LABEL} (${MODEL}) udp/${PORT} community=${COMMUNITY} type=${PDU_TYPE}`);
console.log(`[sim-pdu] TRUE phase amps ${TRUE_A.join(' / ')} A at ${VOLTS} V → total ${totalKw().toFixed(2)} kW`);
console.log(`[sim-pdu] served as tenths (${TRUE_A.map(a => Math.round(a * 10)).join('/')}); a correct collector reports the decimals`);
console.log(`[sim-pdu] outlets ${PDU_TYPE === 'basic' ? 'none (noSuchObject)' : `${state.outlets.filter(s => s === 2).length}/${OUTLETS} on`}`);
