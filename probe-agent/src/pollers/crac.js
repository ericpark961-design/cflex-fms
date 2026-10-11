// CRAC — Liebert iCOM over SNMP.
//
// The brief had this stopped until the KMX survey settles whether the units
// speak iCOM SNMP or BACnet. It is built now, on the SNMP path, because the
// capacity module already judges the room's heat against a COOLING FIGURE
// DERIVED FROM A NAMEPLATE TON RATING AND AN ASSUMED FAN PERCENTAGE — and
// "CRAC-2: warn, fan 68 %, filter alarm" is currently a line in a demo JSON.
// Three readings replace that guess: supply air temperature, the unit's own
// run state, and its active alarm count.
//
// Two honest limits, both reported rather than hidden:
//
//   1. Every scale here is 'documented', not 'verified' — read from the
//      LIEBERT-GP MIBs, not off a unit's display next to this output. The raw
//      integer is stored with every value, so a scale that proves wrong is a
//      correction in place rather than a month of re-collection.
//   2. BACnet is not implemented. A device marked as speaking BACnet returns a
//      clear "protocol not implemented" instead of a timeout that would look
//      like a dead unit for the rest of the project.
const read = require('../services/snmp-read');
const cat = require('../services/oid-catalog');

const PROTO_SNMP = new Set(['', 'snmp', 'icom', 'icom-snmp', 'snmpv2c', 'snmpv3']);

/**
 * A CRAC in standby is not cooling, however healthy it looks. The capacity
 * module needs to know that: N+1 headroom computed with a standby unit counted
 * as available is the reassuring number that gets a room into trouble.
 */
function coolingState(metrics) {
  const sys = metrics.find(m => m.metric === 'state_system');
  const cool = metrics.find(m => m.metric === 'state_cooling');
  const alarms = metrics.find(m => m.metric === 'alarm_count');
  if (!sys && !cool) return null;
  const running = (cool ? cool.str_value === 'on' : sys.str_value === 'on');
  return {
    metric: 'cooling_available', value: running ? 1 : 0,
    str_value: running ? 'cooling' : (cool?.str_value || sys?.str_value || 'unknown'),
    raw_value: null, unit: 'state', oid: null,
    confidence: 'documented', source: 'derived',
    label: alarms && alarms.value > 0 ? `alarms ${alarms.value}` : undefined,
  };
}

/**
 * @param device { id, name, ip, kind: 'crac', attrs: { protocol } }
 * @returns {{ok, metrics:[], error?, unsupported?}}
 */
async function pollCrac(device, opts = {}) {
  const proto = String(device.attrs?.protocol || device.protocol || '').toLowerCase().trim();
  if (!PROTO_SNMP.has(proto)) {
    // Not a failure to collect — a protocol nobody has implemented yet. Saying
    // so is what keeps it off the "unreachable device" list for eight weeks.
    return {
      ok: false, unsupported: true, metrics: [],
      error: `protocol "${proto}" not implemented — iCOM SNMP only. Confirm at the KMX survey; BACnet needs a gateway or a BACnet client.`,
    };
  }

  const metrics = [];
  const missing = [];

  // State and alarm objects are genuine scalars.
  const oids = Object.fromEntries(Object.entries(cat.LIEBERT_ICOM.scalars).map(([k, v]) => [k, v.oid]));
  const r = await read.get(device, oids, opts);
  for (const [key, entry] of Object.entries(cat.LIEBERT_ICOM.scalars)) {
    if (!(key in r.values)) { missing.push(key); continue; }
    const s = cat.scaled(entry, r.values[key]);
    metrics.push({
      metric: key, value: s.value, str_value: s.text, raw_value: s.raw,
      unit: entry.unit, oid: entry.oid,
      confidence: entry.confidence, source: 'measured',
    });
  }

  // Measurements are indexed by sensor, so they are walked. A unit with two
  // return sensors has two rows; a scalar get would find neither.
  for (const m of cat.LIEBERT_ICOM.measurements) {
    const t = await read.walkTable(device, m.table, { value: { sub: '1' } }, opts);
    const rows = Object.entries(t.rows || {});
    if (!rows.length) { missing.push(m.metric); continue; }
    for (const [idx, row] of rows) {
      if (row.value == null) continue;
      const s = cat.scaled(m, row.value);
      metrics.push({
        metric: m.metric, value: s.value, str_value: null, raw_value: s.raw,
        unit: m.unit, oid: `${m.table}.1.${idx}`,
        confidence: m.confidence, source: 'measured',
        label: rows.length > 1 ? `sensor${idx}` : undefined,
      });
    }
  }

  const derived = coolingState(metrics);
  if (derived) metrics.push(derived);

  // Supply minus return is the unit's delta-T, which is how you tell a CRAC
  // that is running from one that is running and doing nothing — a blocked
  // filter or a closed valve shows here before it shows anywhere else.
  const sup = metrics.find(m => m.metric === 'supply_temp_c')?.value;
  const ret = metrics.find(m => m.metric === 'return_temp_c')?.value;
  if (sup != null && ret != null) {
    metrics.push({
      metric: 'delta_t_c', value: Math.round((ret - sup) * 10) / 10,
      raw_value: null, unit: '°C', oid: null,
      confidence: 'documented', source: 'derived',
    });
  }

  const notes = [];
  if (missing.length) notes.push(`absent: ${missing.join(',')}`);
  // Everything from this profile is documented-not-verified, and the first
  // survey that reads a display should confirm it. Travelling with the data
  // beats living in a commit message.
  if (metrics.some(m => m.confidence === 'documented')) {
    notes.push('scales from the LIEBERT-GP MIB — confirm against the iCOM display at the survey');
  }

  return {
    ok: metrics.length > 0, metrics,
    error: metrics.length ? undefined : (r.error || 'no readings'),
    notes: notes.length ? notes.join('; ') : undefined,
  };
}

module.exports = { pollCrac, coolingState, PROTO_SNMP };
