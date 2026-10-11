// The OIDs the collectors read, with how certain we are of each one.
//
// The dangerous part of SNMP is not whether an OID answers — it is the SCALE.
// `rPDU2PhaseStatusCurrent` returns tenths of an amp, so reading it as amps
// reports a 16 A circuit as 160 A and every capacity figure above it becomes
// nonsense. A wrong scale is worse than a missing value, because it looks like
// a measurement.
//
// So every entry carries:
//
//   oid         the object
//   scale       what to multiply the raw integer by to get `unit`
//   unit
//   confidence  'verified'   read off a real unit of this model, or an OID
//                            stable enough to be beyond doubt (IF-MIB)
//               'documented' from the vendor MIB, scale not yet confirmed
//                            against hardware we have touched
//   note        what to check on site
//
// The probe stores the RAW integer alongside the scaled value, so a scale that
// turns out to be wrong can be corrected in place without re-collecting a
// month of history. That is the whole reason raw_value exists.
//
// Nothing here is guessed. Where a vendor's numbering could not be established
// from the MIB, the entry is absent rather than approximated, and the metric
// simply does not appear.

// ── APC Rack PDU, PowerNet-MIB rPDU2 group (enterprise 318) ───────
// Device-level first, then per-phase and per-outlet tables. All three are
// TABLES in the MIB — rPDU2DeviceStatusEntry is indexed by device number, and
// asking for its columns as scalars gets noSuchObject from any agent that
// implements the MIB properly.
const APC_RPDU2 = {
  table: '1.3.6.1.4.1.318.1.1.26.4.3.1',
  columns: {
    // 1 = normal, 2 = low, 3 = nearOverload, 4 = overload
    load_state: { sub: '3', scale: 1, unit: 'state', confidence: 'documented',
      map: { 1: 'normal', 2: 'low', 3: 'nearOverload', 4: 'overload' } },
    power_kw: { sub: '5', scale: 0.01, unit: 'kW', confidence: 'documented',
      note: 'rPDU2DeviceStatusPower — hundredths of kW on the units documented; confirm against the display' },
    peak_power_kw: { sub: '6', scale: 0.01, unit: 'kW', confidence: 'documented' },
    energy_kwh: { sub: '11', scale: 0.1, unit: 'kWh', confidence: 'documented' },
  },
};

// Per-phase table — walked, one row per phase.
const APC_RPDU2_PHASE = {
  table: '1.3.6.1.4.1.318.1.1.26.6.3.1',
  columns: {
    number: { sub: '3', scale: 1, unit: 'index', confidence: 'documented' },
    load_state: { sub: '4', scale: 1, unit: 'state', confidence: 'documented',
      map: { 1: 'normal', 2: 'low', 3: 'nearOverload', 4: 'overload' } },
    current_a: { sub: '5', scale: 0.1, unit: 'A', confidence: 'documented',
      note: 'tenths of an amp — reading this as amps reports a 16 A circuit as 160 A' },
    voltage_v: { sub: '6', scale: 1, unit: 'V', confidence: 'documented' },
  },
};

// Switched / metered outlet tables. Only read when the ledger says the unit is
// switched or metered — a basic PDU has neither and would answer noSuchObject
// for every row.
const APC_RPDU2_OUTLET = {
  switched: {
    table: '1.3.6.1.4.1.318.1.1.26.9.2.3.1',
    columns: {
      state: { sub: '5', scale: 1, unit: 'state', confidence: 'documented',
        map: { 1: 'off', 2: 'on' } },
    },
  },
  metered: {
    table: '1.3.6.1.4.1.318.1.1.26.10.2.2.1',
    columns: {
      current_a: { sub: '5', scale: 0.1, unit: 'A', confidence: 'documented' },
    },
  },
};

// ── APC NetBotz (enterprise 5528) ─────────────────────────────────
// The 750 exposes its sensors through the NetBotz MIB's sensor tables. Which
// table a given probe port lands in depends on what is plugged into it, so
// these are walked and matched by the sensor's own label rather than assumed
// to sit at a fixed index.
const NETBOTZ = {
  temp: {
    table: '1.3.6.1.4.1.5528.100.4.1.1.1',
    columns: {
      label: { sub: '4', unit: 'text', confidence: 'documented' },
      value: { sub: '7', scale: 0.1, unit: '°C', confidence: 'documented',
        note: 'tenths of a degree in the units documented; confirm against the NetBotz web UI reading' },
    },
  },
  humidity: {
    table: '1.3.6.1.4.1.5528.100.4.1.2.1',
    columns: {
      label: { sub: '4', unit: 'text', confidence: 'documented' },
      value: { sub: '7', scale: 0.1, unit: '%RH', confidence: 'documented' },
    },
  },
  // Dry-contact / state sensors: door switches and leak-detection cable both
  // arrive here, distinguished by their label.
  state: {
    table: '1.3.6.1.4.1.5528.100.4.1.3.1',
    columns: {
      label: { sub: '4', unit: 'text', confidence: 'documented' },
      value: { sub: '7', scale: 1, unit: 'state', confidence: 'documented' },
    },
  },
};

// ── IF-MIB (RFC 2863) — every switch and router ───────────────────
// Standard, stable, and the one group here that needs no on-site confirmation.
const IF_MIB = {
  if_number: { oid: '1.3.6.1.2.1.2.1.0', scale: 1, unit: 'count', confidence: 'verified' },
  table: '1.3.6.1.2.1.2.2.1',
  columns: {
    descr: { sub: '2', unit: 'text', confidence: 'verified' },
    type: { sub: '3', scale: 1, unit: 'enum', confidence: 'verified' },
    admin_status: { sub: '7', scale: 1, unit: 'state', confidence: 'verified',
      map: { 1: 'up', 2: 'down', 3: 'testing' } },
    oper_status: { sub: '8', scale: 1, unit: 'state', confidence: 'verified',
      map: { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' } },
  },
};

// Physical ports only. A switch reports loopbacks, VLANs and tunnels in the
// same table, and counting them as ports turned a 48-port switch into 70-odd.
const IF_TYPE_PHYSICAL = new Set([6, 117]);   // ethernetCsmacd, gigabitEthernet

// ── ENTITY-SENSOR (RFC 3433) + CISCO-ENVMON ───────────────────────
const ENTITY_SENSOR = {
  table: '1.3.6.1.2.1.99.1.1.1',
  columns: {
    type: { sub: '1', scale: 1, unit: 'enum', confidence: 'verified',
      // entPhySensorType: 8 = celsius, 4 = volts DC, 3 = amperes, 6 = watts
      map: { 1: 'other', 2: 'unknown', 3: 'amperes', 4: 'voltsDC', 5: 'voltsAC', 6: 'watts', 7: 'hertz', 8: 'celsius', 9: 'percentRH', 10: 'rpm' } },
    scale_exp: { sub: '2', scale: 1, unit: 'enum', confidence: 'verified' },
    precision: { sub: '3', scale: 1, unit: 'digits', confidence: 'verified' },
    value: { sub: '4', scale: 1, unit: 'raw', confidence: 'verified' },
    oper_status: { sub: '5', scale: 1, unit: 'state', confidence: 'verified',
      map: { 1: 'ok', 2: 'unavailable', 3: 'nonoperational' } },
  },
};

// entPhySensorScale is an exponent enum, not a multiplier: the value must be
// scaled by it AND by 10^-precision. Getting this wrong is how a 42 °C inlet
// reads as 42,000.
const SENSOR_SCALE_EXP = {
  1: -24, 2: -21, 3: -18, 4: -15, 5: -12, 6: -9, 7: -6, 8: -3,
  9: 0, 10: 3, 11: 6, 12: 9, 13: 12, 14: 15, 15: 18, 16: 21, 17: 24,
};

const CISCO_ENVMON = {
  temperature: {
    table: '1.3.6.1.4.1.9.9.13.1.3.1',
    columns: {
      descr: { sub: '2', unit: 'text', confidence: 'verified' },
      value: { sub: '3', scale: 1, unit: '°C', confidence: 'verified' },
      state: { sub: '6', scale: 1, unit: 'state', confidence: 'verified',
        map: { 1: 'normal', 2: 'warning', 3: 'critical', 4: 'shutdown', 5: 'notPresent', 6: 'notFunctioning' } },
    },
  },
  supply: {
    table: '1.3.6.1.4.1.9.9.13.1.5.1',
    columns: {
      descr: { sub: '2', unit: 'text', confidence: 'verified' },
      state: { sub: '3', scale: 1, unit: 'state', confidence: 'verified',
        map: { 1: 'normal', 2: 'warning', 3: 'critical', 4: 'shutdown', 5: 'notPresent', 6: 'notFunctioning' } },
    },
  },
};

// ── Vertiv / Liebert iCOM, LIEBERT-GP-* (enterprise 476) ──────────
// The CRAC group. The brief had this stopped until the KMX survey settles
// whether the units speak iCOM SNMP or BACnet; it is implemented here on the
// SNMP path with every scale marked 'documented', because that is what it is
// until someone reads a unit's display next to this output.
//
// The two numbers that matter operationally are supply air temperature (what
// the room is actually being given) and the unit's own state (running,
// standby, alarm) — a CRAC in standby is not cooling, however healthy it looks.
const LIEBERT_ICOM = {
  // Genuine scalars — instance .0.
  scalars: {
    state_system: { oid: '1.3.6.1.4.1.476.1.42.3.4.1.1.1.0', scale: 1, unit: 'state', confidence: 'documented',
      map: { 1: 'on', 2: 'standby', 3: 'off' } },
    state_cooling: { oid: '1.3.6.1.4.1.476.1.42.3.4.1.1.2.0', scale: 1, unit: 'state', confidence: 'documented',
      map: { 1: 'on', 2: 'standby', 3: 'off' } },
    // Fan speed as a percentage of maximum — the figure the capacity module
    // uses to turn a nameplate ton rating into the heat actually being moved.
    fan_pct: { oid: '1.3.6.1.4.1.476.1.42.3.4.5.1.1.1.0', scale: 1, unit: '%', confidence: 'documented' },
    // Active alarm count: a non-zero here is why a healthy-looking CRAC is not
    // cooling, and it is the first thing an engineer asks for.
    alarm_count: { oid: '1.3.6.1.4.1.476.1.42.3.9.20.1.0', scale: 1, unit: 'count', confidence: 'documented' },
  },
  // Measurements are indexed by sensor: a unit with two return sensors has two
  // rows, and a scalar get would find neither.
  measurements: [
    { metric: 'supply_temp_c', table: '1.3.6.1.4.1.476.1.42.3.4.1.2.3', scale: 0.1, unit: '°C', confidence: 'documented',
      note: 'LIEBERT-GP-ENVIRONMENTAL tenths of a degree; confirm against the iCOM display' },
    { metric: 'return_temp_c', table: '1.3.6.1.4.1.476.1.42.3.4.1.2.4', scale: 0.1, unit: '°C', confidence: 'documented' },
    { metric: 'humidity_pct', table: '1.3.6.1.4.1.476.1.42.3.4.2.2.3', scale: 0.1, unit: '%RH', confidence: 'documented' },
  ],
};

// sysDescr, for identifying a unit and confirming a profile fits it at all.
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const SYS_OBJECT_ID = '1.3.6.1.2.1.1.2.0';

/** Apply an entry's scale, returning both the raw integer and the scaled value. */
function scaled(entry, raw) {
  if (raw == null) return { raw: null, value: null, text: null };
  if (entry.unit === 'text') return { raw: String(raw), value: null, text: String(raw) };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { raw, value: null, text: String(raw) };
  const value = entry.scale == null ? n : Math.round(n * entry.scale * 1000) / 1000;
  return { raw: n, value, text: entry.map ? (entry.map[n] || `unknown(${n})`) : null };
}

/** ENTITY-SENSOR needs its exponent and precision applied, not a fixed scale. */
function sensorValue(raw, scaleEnum, precision) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const exp = SENSOR_SCALE_EXP[Number(scaleEnum)] ?? 0;
  const p = Number.isFinite(Number(precision)) ? Number(precision) : 0;
  const v = n * Math.pow(10, exp) * Math.pow(10, -p);
  return Math.round(v * 1000) / 1000;
}

module.exports = {
  APC_RPDU2, APC_RPDU2_PHASE, APC_RPDU2_OUTLET,
  NETBOTZ, IF_MIB, IF_TYPE_PHYSICAL, ENTITY_SENSOR, SENSOR_SCALE_EXP,
  CISCO_ENVMON, LIEBERT_ICOM,
  SYS_DESCR, SYS_OBJECT_ID,
  scaled, sensorValue,
};
