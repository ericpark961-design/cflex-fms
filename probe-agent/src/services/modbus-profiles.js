// Modbus register-map profiles: what to read from a model, and how to turn
// the words into numbers. (WO-INT-017 §3.2)
//
// Addresses do not belong in code. One JSON file under profiles/modbus/ is one
// model or controller family, and it carries the vendor document it was taken
// from. The loader is strict on purpose, because every field it refuses to
// guess is one that goes wrong silently on site:
//
//   · address_base (0 or 1) is mandatory. Vendor point lists number registers
//     from 1 ("40001", "30012") or from 0, and the PDU address on the wire is
//     always 0-based. Off by one reads the neighbouring register — a plausible
//     number, wrong by a whole quantity.
//   · 32-bit values need word_order (ABCD or CDAB). The two orders give
//     different numbers from the same registers, and both look like numbers.
//   · scale and unit are written out, never defaulted. A tenths-of-a-degree
//     register read as degrees is a 235 °C room.
//   · everything starts 'documented' and becomes 'verified' only after someone
//     has compared it with the unit's own display on site. raw_value travels
//     with every reading, so a wrong scale is a correction, not re-collection.
//
// A profile that fails these checks does not stop the probe: the device using
// it is reported `unsupported` with the reasons, and the cycle carries on.
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = path.resolve(__dirname, '../../profiles/modbus');

const TABLES = new Set(['holding', 'input', 'coil', 'discrete']);
const WORDS = { uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2, bit: 1 };
const WORD_ORDERS = new Set(['ABCD', 'CDAB']);
const CONFIDENCE = new Set(['documented', 'verified']);
const METRIC = /^[a-z][a-z0-9_]{0,63}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Metrics the derived CRAC values depend on (crac.js coolingState): a state
 * has to arrive as on / standby / off text, so a state point needs an enum.
 */
const STATE_METRICS = new Set(['state_system', 'state_cooling']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Problems with one point, as text. Empty = usable. */
function checkPoint(p, i, base) {
  const at = `points[${i}]${p && p.metric ? ` (${p.metric})` : ''}`;
  const e = [];
  if (!p || typeof p !== 'object') return [`${at}: not an object`];
  if (!METRIC.test(String(p.metric || ''))) e.push(`${at}: metric must be snake_case`);
  if (!TABLES.has(p.type)) e.push(`${at}: type must be holding | input | coil | discrete`);
  if (!(p.data in WORDS)) e.push(`${at}: data must be one of ${Object.keys(WORDS).join(', ')}`);
  if (!Number.isInteger(p.address)) e.push(`${at}: address must be an integer`);
  else if (p.address - base < 0 || p.address - base + (WORDS[p.data] || 1) > 0x10000) e.push(`${at}: address ${p.address} outside the ${base}-based range`);
  if ((p.type === 'coil' || p.type === 'discrete') && p.data !== 'bit') e.push(`${at}: a ${p.type} is a single bit — data must be "bit"`);
  if (p.data === 'bit' && (p.type === 'holding' || p.type === 'input') && !(Number.isInteger(p.bit) && p.bit >= 0 && p.bit <= 15)) {
    e.push(`${at}: a bit of a register needs bit 0–15`);
  }
  if (WORDS[p.data] === 2 && !WORD_ORDERS.has(p.word_order)) e.push(`${at}: ${p.data} needs word_order ABCD or CDAB — not guessed`);
  if (!isNum(p.scale) || p.scale === 0) e.push(`${at}: scale must be written out (a non-zero number)`);
  if (typeof p.unit !== 'string' || !p.unit.trim()) e.push(`${at}: unit must be written out`);
  if (!CONFIDENCE.has(p.confidence)) e.push(`${at}: confidence must be documented | verified`);
  if (p.enum != null && (typeof p.enum !== 'object' || Array.isArray(p.enum))) e.push(`${at}: enum must be an object of raw value → text`);
  if (STATE_METRICS.has(p.metric) && !p.enum) e.push(`${at}: ${p.metric} needs an enum to on / standby / off`);
  return e;
}

/**
 * Validate a parsed profile.
 * @returns {{ok:true, profile} | {ok:false, errors:string[]}}
 *   profile.points[] gain `pdu` (0-based wire address) and `words`.
 */
function validateProfile(p) {
  const errors = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: ['profile is not a JSON object'] };
  if (!PROFILE_ID.test(String(p.id || ''))) errors.push('id missing or not a plain name');
  if (typeof p.vendor !== 'string' || !p.vendor.trim()) errors.push('vendor missing');
  if (!p.source_doc || typeof p.source_doc !== 'object' || !p.source_doc.title) errors.push('source_doc.title missing — a profile names the document its addresses come from');
  if (p.address_base !== 0 && p.address_base !== 1) errors.push('address_base must be 0 or 1 (written out, not assumed)');
  // The probe connects to the ledger's device IP and nowhere else (§3.1).
  for (const k of ['host', 'ip', 'hosts', 'address_host']) if (k in p) errors.push(`"${k}" is not allowed in a profile — the device IP comes from the ledger only`);
  if (!Array.isArray(p.points) || !p.points.length) errors.push('points missing or empty');
  const base = p.address_base === 1 ? 1 : 0;
  const seen = new Set();
  for (const [i, pt] of (Array.isArray(p.points) ? p.points : []).entries()) {
    errors.push(...checkPoint(pt, i, base));
    const key = pt && `${pt.metric}|${pt.label || ''}`;
    if (key && seen.has(key)) errors.push(`points[${i}]: ${pt.metric} appears twice (give each a label)`);
    seen.add(key);
  }
  if (errors.length) return { ok: false, errors };
  const points = p.points.map(pt => ({ ...pt, pdu: pt.address - base, words: WORDS[pt.data] }));
  return { ok: true, profile: { ...p, points } };
}

/**
 * Load profiles/modbus/<id>.json.
 * @param {string} id
 * @param {{dir?:string}} [o]  dir is for tests
 */
function loadProfile(id, o = {}) {
  if (!PROFILE_ID.test(String(id || ''))) return { ok: false, errors: [`profile name "${id ?? ''}" missing or not a plain name`] };
  const file = path.join(o.dir || PROFILE_DIR, `${id}.json`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, errors: [`profile "${id}" not found`] }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, errors: [`profile "${id}" is not valid JSON: ${e.message}`] }; }
  const v = validateProfile(parsed);
  if (v.ok && v.profile.id !== id) return { ok: false, errors: [`profile file ${id}.json declares id "${v.profile.id}"`] };
  return v;
}

/**
 * Words (or one bit) → { raw, value, text }. Throws when the point does not
 * say enough to convert it — the loader stops such a point first, this is the
 * second line for callers that build points by hand.
 *
 * @param point  { data, word_order?, bit?, scale, unit, enum? }
 * @param words  register words for the point (1 or 2), or [bit] for coil/discrete
 */
function decodeValue(point, words) {
  if (!isNum(point.scale) || typeof point.unit !== 'string' || !point.unit) throw new Error(`${point.metric || 'point'}: scale and unit must be explicit`);
  let raw;
  switch (point.data) {
    case 'uint16': raw = words[0]; break;
    case 'int16': raw = words[0] > 0x7fff ? words[0] - 0x10000 : words[0]; break;
    case 'bit': raw = (point.type === 'coil' || point.type === 'discrete') ? words[0] : (words[0] >> point.bit) & 1; break;
    case 'uint32': case 'int32': case 'float32': {
      if (!WORD_ORDERS.has(point.word_order)) throw new Error(`${point.metric || 'point'}: ${point.data} needs word_order ABCD or CDAB`);
      const [hi, lo] = point.word_order === 'CDAB' ? [words[1], words[0]] : [words[0], words[1]];
      const b = Buffer.alloc(4);
      b.writeUInt16BE(hi, 0); b.writeUInt16BE(lo, 2);
      raw = point.data === 'uint32' ? b.readUInt32BE(0) : point.data === 'int32' ? b.readInt32BE(0) : b.readFloatBE(0);
      break;
    }
    default: throw new Error(`${point.metric || 'point'}: unknown data type ${point.data}`);
  }
  if (!Number.isFinite(raw)) return { raw: null, value: null, text: null };
  // Rounded to absorb binary fractions (183 × 0.1 = 18.300000000000001);
  // raw keeps the exact integer.
  const value = Math.round(raw * point.scale * 1e6) / 1e6;
  const text = point.enum ? (point.enum[String(raw)] ?? `code${raw}`) : null;
  return { raw, value, text };
}

/**
 * Plan the reads for a set of points: per table, points whose words touch or
 * overlap are read as one range (split again by the read client at 125
 * registers / 2000 bits). Gaps are not bridged — reading addresses the profile
 * does not list is how a working map earns an exception 02.
 */
function planReads(points) {
  const byTable = {};
  for (const p of points) (byTable[p.type] = byTable[p.type] || []).push(p);
  const ranges = [];
  for (const [table, list] of Object.entries(byTable)) {
    list.sort((a, b) => a.pdu - b.pdu);
    let cur = null;
    for (const p of list) {
      const end = p.pdu + p.words;
      if (cur && p.pdu <= cur.address + cur.count) {
        cur.count = Math.max(cur.count, end - cur.address);
        cur.points.push(p);
      } else {
        cur = { table, address: p.pdu, count: p.words, points: [p] };
        ranges.push(cur);
      }
    }
  }
  return ranges;
}

/** Where a value came from, in the metric's `oid` slot: modbus:<unit>:<table>:<pdu address>. */
const sourceOf = (unitId, table, pdu) => `modbus:${unitId}:${table}:${pdu}`;

/**
 * Read every point of a profile from one unit.
 * @param pool    modbus-read createModbusPool()
 * @param target  { host, port, unitId }
 * @returns {{ readings: [{point, raw, value, text}], missing: [{point, error}] }}
 */
async function readProfile(pool, target, profile) {
  const readings = [];
  const missing = [];
  for (const r of planReads(profile.points)) {
    let vals;
    try {
      vals = await pool.read({ host: target.host, port: target.port, unitId: target.unitId, table: r.table, address: r.address, count: r.count });
    } catch (e) {
      for (const p of r.points) missing.push({ point: p, error: e });
      continue;
    }
    for (const p of r.points) {
      const off = p.pdu - r.address;
      try { readings.push({ point: p, ...decodeValue(p, vals.slice(off, off + p.words)) }); }
      catch (e) { missing.push({ point: p, error: e }); }
    }
  }
  return { readings, missing };
}

module.exports = {
  PROFILE_DIR, TABLES, WORDS, STATE_METRICS,
  validateProfile, loadProfile, decodeValue, planReads, readProfile, sourceOf,
};
