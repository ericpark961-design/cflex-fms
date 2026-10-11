// APC NetBotz 750 — room temperature, humidity, door and leak.
//
// The KMX ledger already draws six sensors, three smoke zones and four leak
// zones, and every one of them is a shape on a floor plan with no reading
// behind it. This is where those readings come from.
//
// Sensors are matched by their own LABEL, not by a fixed index. Which port a
// leak cable or a door switch is plugged into is a site decision, so assuming
// "index 1 is the inlet temperature" produces a confident number about the
// wrong thing the first time someone moves a cable.
const read = require('../services/snmp-read');
const cat = require('../services/oid-catalog');

// What a state sensor's label means. A dry contact reports 1 or 2; which of
// those is "bad" depends on whether it is a door or a leak detector, so the
// label decides and an unrecognised label stays a raw state rather than being
// guessed into an alarm.
const STATE_KINDS = [
  { match: /leak|water|fluid|누수/i, metric: 'leak', closedMeans: 'dry', openMeans: 'wet' },
  { match: /door|contact|access|도어|출입/i, metric: 'door', closedMeans: 'closed', openMeans: 'open' },
  { match: /smoke|fire|연기|화재/i, metric: 'smoke', closedMeans: 'clear', openMeans: 'detected' },
];

function stateKindFor(label) {
  for (const k of STATE_KINDS) if (k.match.test(label || '')) return k;
  return null;
}

/**
 * @param device { id, name, ip, kind: 'netbotz' }
 * @returns {{ok, metrics:[], error?}}
 */
async function pollNetbotz(device, opts = {}) {
  const metrics = [];
  const notes = [];

  for (const [group, spec] of Object.entries(cat.NETBOTZ)) {
    const t = await read.walkTable(device, spec.table, spec.columns, opts);
    if (t.error && !Object.keys(t.rows || {}).length) { notes.push(`${group}: ${t.error}`); continue; }

    for (const [idx, row] of Object.entries(t.rows || {})) {
      if (row.value == null) continue;
      const label = row.label != null ? String(row.label) : `${group}${idx}`;
      const entry = spec.columns.value;
      const s = cat.scaled(entry, row.value);
      const oid = `${spec.table}.${entry.sub}.${idx}`;

      if (group === 'state') {
        const kind = stateKindFor(label);
        // The NetBotz convention is 1 = closed/normal, 2 = open/alarm on the
        // units documented. Without a recognised label we do not claim to know
        // which of those is trouble, so the reading travels as a raw state.
        const str = kind
          ? (Number(row.value) === 1 ? kind.closedMeans : kind.openMeans)
          : `state(${row.value})`;
        metrics.push({
          metric: kind ? kind.metric : 'contact_state',
          value: Number(row.value), str_value: str, raw_value: Number(row.value),
          unit: 'state', oid, confidence: entry.confidence, source: 'measured', label,
        });
        if (!kind) notes.push(`unlabelled state sensor "${label}" — reported raw`);
        continue;
      }

      metrics.push({
        metric: group === 'temp' ? 'temp_c' : 'humidity_pct',
        value: s.value, str_value: null, raw_value: s.raw,
        unit: entry.unit, oid, confidence: entry.confidence, source: 'measured', label,
      });
    }
  }

  // A NetBotz that answers with no sensors at all is a different problem from
  // one that cannot be reached, and the distinction decides who gets called.
  if (!metrics.length) {
    return { ok: false, metrics, error: notes.length ? notes.join('; ') : 'no sensors reported' };
  }
  return { ok: true, metrics, notes: notes.length ? notes.join('; ') : undefined };
}

module.exports = { pollNetbotz, stateKindFor };
