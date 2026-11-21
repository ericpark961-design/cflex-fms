// Contact inputs on a Modbus TCP I/O module — kind `dio`. (WO-INT-017 §3.4)
//
// The fire panel (FM-200) and the smoke detectors hand over dry relay
// contacts; an I/O module turns them into coils or discrete inputs. Which
// channel carries which signal is wiring, and wiring is per site, so it lives
// on the device row rather than in a profile:
//
//   attrs: {
//     protocol: 'modbus-tcp',
//     modbus: { port: 502, unit_id: 1, type: 'discrete', address_base: 0 },
//     inputs: [ { channel: 0, metric: 'fire_alarm', active_state: 'closed', label: 'FM-200 Alarm' }, … ]
//   }
//
// Three rules, all about not showing a fire signal wrongly:
//
//   1. active_state (closed | open) says whether the contact is normally open
//      or normally closed. Without it the channel is NOT converted — it is
//      reported with no value and named in notes. A guessed polarity shows
//      "normal" while the panel is in alarm.
//   2. A module that does not answer is ok:false. Nothing is filled with 0:
//      "could not read" must never look like "no fire".
//   3. Metric names come from a fixed list. A typo would otherwise create a
//      signal nobody watches.
//
// Values only (metrics). Alarm codes for these signals are not in contract 00
// appendix B and are not invented here (WO-INT-017 §8-1).
const { DEFAULTS } = require('../services/modbus-read');
const { sourceOf } = require('../services/modbus-profiles');
const { withPool, describe } = require('./crac-modbus');

const NAMES = /^(fire_alarm|fire_trouble|fire_supervisory|fire_predischarge|fire_discharge|leak_alarm|smoke_zone_[1-9][0-9]{0,2}|contact_[0-9]{1,3})$/;
const TYPES = { coil: 'coil', discrete: 'discrete' };
const ACTIVE = new Set(['closed', 'open']);

/** The module's read settings and the input table, or the reasons they are unusable. */
function configOf(device, opts) {
  const mb = device.attrs?.modbus || {};
  const inputs = device.attrs?.inputs;
  const errors = [];
  if (!(Number.isInteger(mb.unit_id) && mb.unit_id >= 0 && mb.unit_id <= 255)) errors.push('attrs.modbus.unit_id missing or not 0–255');
  if (!TYPES[mb.type]) errors.push('attrs.modbus.type must be coil or discrete');
  if (mb.address_base !== 0 && mb.address_base !== 1) errors.push('attrs.modbus.address_base must be 0 or 1 (written out, not assumed)');
  const port = mb.port ?? opts.modbus?.port ?? DEFAULTS.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`attrs.modbus.port ${port} is not a TCP port`);
  if (!Array.isArray(inputs) || !inputs.length) errors.push('attrs.inputs missing or empty');
  const base = mb.address_base === 1 ? 1 : 0;
  const metrics = new Set(), channels = new Set();
  for (const [i, x] of (Array.isArray(inputs) ? inputs : []).entries()) {
    const at = `inputs[${i}]`;
    if (!x || typeof x !== 'object') { errors.push(`${at}: not an object`); continue; }
    if (!NAMES.test(String(x.metric || ''))) errors.push(`${at}: metric "${x.metric ?? ''}" is not an allowed contact name`);
    if (!Number.isInteger(x.channel) || x.channel - base < 0 || x.channel - base > 0xffff) errors.push(`${at}: channel must be an integer ≥ ${base}`);
    if (x.active_state != null && !ACTIVE.has(x.active_state)) errors.push(`${at}: active_state must be closed or open`);
    if (metrics.has(x.metric)) errors.push(`${at}: ${x.metric} used twice`);
    if (channels.has(x.channel)) errors.push(`${at}: channel ${x.channel} used twice`);
    metrics.add(x.metric); channels.add(x.channel);
  }
  if (errors.length) return { errors };
  return {
    unitId: mb.unit_id, port, table: TYPES[mb.type], base,
    inputs: inputs.map(x => ({ ...x, pdu: x.channel - base })),
  };
}

/**
 * @param device { id, name, ip, kind: 'dio', attrs: {...} }
 * @param opts   { modbusPool?, modbus?: {timeoutMs, retries, port} }
 * @returns {{ok, metrics:[], error?, notes?, unsupported?}}
 */
async function pollDio(device, opts = {}) {
  const proto = String(device.attrs?.protocol || device.protocol || '').toLowerCase().trim();
  if (proto !== 'modbus' && proto !== 'modbus-tcp') {
    return { ok: false, unsupported: true, metrics: [], error: `dio: protocol "${proto}" not implemented — Modbus TCP only` };
  }
  const c = configOf(device, opts);
  if (c.errors) return { ok: false, unsupported: true, metrics: [], error: `dio configuration: ${c.errors.join('; ')}` };
  const host = device.ip || device.nmc_ip || null;
  if (!host) return { ok: false, metrics: [], error: 'no IP for this device in the ledger' };

  // One range over the wired channels; the read client splits it at 2000 bits.
  const lo = Math.min(...c.inputs.map(x => x.pdu));
  const hi = Math.max(...c.inputs.map(x => x.pdu));
  let bits;
  try {
    bits = await withPool(opts, (pool) => pool.read({ host, port: c.port, unitId: c.unitId, table: c.table, address: lo, count: hi - lo + 1 }));
  } catch (e) {
    // Rule 2: no metrics at all, not zeros.
    return { ok: false, metrics: [], error: describe(e) };
  }

  const metrics = [];
  const unset = [];
  for (const x of c.inputs) {
    const raw = bits[x.pdu - lo];
    const m = {
      metric: x.metric, raw_value: raw, unit: 'state',
      oid: sourceOf(c.unitId, c.table, x.pdu),
      confidence: 'documented', source: 'measured',
      ...(x.label ? { label: String(x.label).slice(0, 64) } : {}),
    };
    if (!x.active_state) {
      // Rule 1: raw kept, nothing converted.
      unset.push(`${x.metric} (channel ${x.channel}, raw ${raw})`);
      metrics.push({ ...m, value: null, str_value: null });
      continue;
    }
    // A closed contact reads 1. active_state says which position means "active".
    const active = x.active_state === 'closed' ? raw === 1 : raw === 0;
    metrics.push({ ...m, value: active ? 1 : 0, str_value: active ? 'active' : 'normal' });
  }

  const notes = [];
  if (unset.length) notes.push(`active_state 미지정 — not converted: ${unset.join(', ')}`);
  notes.push('channel wiring and polarity per the device row — confirm each input against the panel at commissioning');
  return { ok: true, metrics, notes: notes.join('; ') };
}

module.exports = { pollDio, configOf, NAMES };
