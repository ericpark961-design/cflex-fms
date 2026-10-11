// Liebert iCOM CRAC simulator. Dev-only.
//
// The one that matters most for the capacity module: a room's cooling has been
// judged against a nameplate ton rating times a fan percentage TYPED INTO A
// DEMO JSON. "CRAC-2: warn, fan 68 %, filter alarm" was a literal.
//
// What it proves is the distinction the capacity module depends on — a CRAC in
// STANDBY is not cooling, however healthy it looks, and N+1 headroom computed
// with a standby unit counted as available is the reassuring number that gets
// a room into trouble.
//
//   SNMP_PORT=16601 SUPPLY_C=18.3 RETURN_C=26.5 COOLING=standby ALARMS=1 node sim/sim-crac.js
const { agent, scalar, table, sysGroup, T } = require('./lib');

const PORT = parseInt(process.env.SNMP_PORT, 10) || 16601;
const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const LABEL = process.env.LABEL || 'Sim CRAC';
const MODEL = process.env.MODEL || 'Liebert PDX 100 kW';

const CODE = { on: 1, standby: 2, off: 3 };
const nameOf = (c) => Object.keys(CODE).find(k => CODE[k] === c) || `code${c}`;
const state = {
  supply: parseFloat(process.env.SUPPLY_C || '18.3'),
  ret: parseFloat(process.env.RETURN_C || '26.5'),
  humidity: parseFloat(process.env.HUMIDITY || '45.0'),
  system: CODE[(process.env.SYSTEM || 'on').toLowerCase()] ?? 1,
  cooling: CODE[(process.env.COOLING || 'on').toLowerCase()] ?? 1,
  fan: parseInt(process.env.FAN_PCT || '72', 10),
  alarms: parseInt(process.env.ALARMS || '0', 10),
};

if (process.env.DRIFT !== '0') {
  setInterval(() => {
    state.supply = Math.round((state.supply + (Math.random() * 0.2 - 0.1)) * 10) / 10;
    state.ret = Math.round((state.ret + (Math.random() * 0.2 - 0.1)) * 10) / 10;
  }, 20_000);
}

const { mib } = agent({ port: PORT, community: COMMUNITY });
sysGroup(mib, { descr: `Vertiv ${MODEL} iCOM - Simulator`, name: LABEL });

// LIEBERT-GP-ENVIRONMENTAL. The state and alarm objects are scalars; the
// measurements are tables indexed by sensor, because a unit can have more than
// one return sensor and a scalar would hide all but one.
const s = (oid, name, get) => scalar(mib, { oid, name, type: T.Integer, get });
s('1.3.6.1.4.1.476.1.42.3.4.1.1.1', 'lgpEnvStateSystem', () => state.system);
s('1.3.6.1.4.1.476.1.42.3.4.1.1.2', 'lgpEnvStateCooling', () => state.cooling);
s('1.3.6.1.4.1.476.1.42.3.4.5.1.1.1', 'lgpEnvFanSpeed', () => state.fan);
s('1.3.6.1.4.1.476.1.42.3.9.20.1', 'lgpAlarmCount', () => state.alarms);

const measurement = (oid, name, get) => table(mib, {
  oid, name,
  columns: [{ number: 1, name: `${name}Value`, type: T.Integer }],
  rows: () => [[Math.round(get() * 10)]],      // tenths, as the MIB documents
});
measurement('1.3.6.1.4.1.476.1.42.3.4.1.2.3', 'lgpEnvSupplyTemp', () => state.supply);
measurement('1.3.6.1.4.1.476.1.42.3.4.1.2.4', 'lgpEnvReturnTemp', () => state.ret);
measurement('1.3.6.1.4.1.476.1.42.3.4.2.2.3', 'lgpEnvHumidity', () => state.humidity);

console.log(`[sim-crac] ${LABEL} (${MODEL}) udp/${PORT} community=${COMMUNITY}`);
console.log(`[sim-crac] TRUE supply ${state.supply}°C  return ${state.ret}°C  deltaT ${Math.round((state.ret - state.supply) * 10) / 10}°C`);
console.log(`[sim-crac] TRUE system=${nameOf(state.system)} cooling=${nameOf(state.cooling)} fan=${state.fan}% alarms=${state.alarms}`);
console.log(`[sim-crac] cooling_available must come out ${state.cooling === 1 ? '1 (cooling)' : `0 (${nameOf(state.cooling)})`}`);
