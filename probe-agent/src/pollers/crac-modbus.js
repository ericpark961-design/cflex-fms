// CRAC over Modbus TCP — the path for units whose controller does not speak
// iCOM SNMP (KMX CCR: Stulz, directly or behind an RS-485 → TCP gateway).
// (WO-INT-017 §3.3)
//
// What is read comes from a register-map profile (profiles/modbus/<name>.json,
// services/modbus-profiles.js), named by the device row:
//
//   attrs: { protocol: 'modbus-tcp', modbus: { unit_id: 1, port: 502, profile: 'sim-crac' } }
//
// The host is the ledger device's IP and nothing else.
//
// The metric names are the SNMP path's — supply_temp_c, return_temp_c,
// state_system, state_cooling, alarm_count — so coolingState() and delta-T are
// derived exactly as for an iCOM unit. That matters for one reason above the
// rest: a unit in STANDBY must come out cooling_available 0 whichever protocol
// it was read over.
//
// Read only. The read client cannot send a write function code.
const { createModbusPool, DEFAULTS } = require('../services/modbus-read');
const profiles = require('../services/modbus-profiles');

const unitOk = (u) => Number.isInteger(u) && u >= 0 && u <= 255;

/** The device's Modbus target, or a reason it has none. */
function targetOf(device, opts) {
  const mb = device.attrs?.modbus || {};
  const host = device.ip || device.nmc_ip || null;
  const port = mb.port ?? opts.modbus?.port ?? DEFAULTS.port;
  if (!unitOk(mb.unit_id)) return { error: 'attrs.modbus.unit_id missing or not 0–255' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `attrs.modbus.port ${port} is not a TCP port` };
  return { host, port, unitId: mb.unit_id };
}

/**
 * Run fn(pool) with the cycle's pool, or a private one closed afterwards
 * (a device polled outside a cycle — a test, a one-off).
 */
async function withPool(opts, fn) {
  if (opts.modbusPool) return fn(opts.modbusPool);
  const pool = createModbusPool(opts.modbus || {});
  try { return await fn(pool); } finally { pool.close(); }
}

/** Why a read failed, kept apart: a register map that does not match is not a dead unit. */
function describe(err) {
  if (err && err.mapMismatch) return `register map mismatch — ${err.message}`;
  if (err && err.kind === 'exception') return `device exception — ${err.message}`;
  if (err && (err.kind === 'comms' || err.kind === 'protocol')) return `communication failure — ${err.message}`;
  return err ? err.message : 'no readings';
}

/**
 * @param device { id, name, ip, kind: 'crac', attrs: { protocol: 'modbus'|'modbus-tcp', modbus: { unit_id, port?, profile } } }
 * @param opts   { modbusPool?, modbus?: {timeoutMs, retries, port}, modbusProfileDir? }
 * @returns {{ok, metrics:[], error?, notes?, unsupported?}}
 */
async function pollCracModbus(device, opts = {}) {
  const name = device.attrs?.modbus?.profile;
  const loaded = profiles.loadProfile(name, { dir: opts.modbusProfileDir });
  if (!loaded.ok) {
    // A configuration fault, not a dead unit — and not a reason to stop the cycle.
    return { ok: false, unsupported: true, metrics: [], error: `modbus profile "${name ?? ''}" unusable: ${loaded.errors.join('; ')}` };
  }
  const profile = loaded.profile;
  const t = targetOf(device, opts);
  if (t.error) return { ok: false, unsupported: true, metrics: [], error: t.error };
  if (!t.host) return { ok: false, metrics: [], error: 'no IP for this device in the ledger' };

  const { readings, missing } = await withPool(opts, (pool) => profiles.readProfile(pool, t, profile));

  const metrics = readings.map(({ point: p, raw, value, text }) => ({
    metric: p.metric, value, str_value: text, raw_value: raw,
    unit: p.unit, oid: profiles.sourceOf(t.unitId, p.type, p.pdu),
    confidence: p.confidence, source: 'measured',
    ...(p.label ? { label: p.label } : {}),
  }));

  // The SNMP path's derivations, unchanged — required late, crac.js requires this file.
  const { coolingState, deltaT } = require('./crac');
  const derived = coolingState(metrics);
  if (derived) metrics.push(derived);
  const dt = deltaT(metrics);
  if (dt) metrics.push(dt);

  const notes = [];
  if (missing.length) {
    // One line per cause, so "two points, map mismatch" and "everything, timeout" read differently.
    const byCause = new Map();
    for (const m of missing) {
      const why = describe(m.error);
      byCause.set(why, [...(byCause.get(why) || []), m.point.metric]);
    }
    for (const [why, list] of byCause) notes.push(`absent: ${list.join(',')} (${why})`);
  }
  if (metrics.some(m => m.confidence === 'documented')) {
    notes.push(`values per profile ${profile.id} (${profile.source_doc.title}) — documented, confirm against the unit display at commissioning`);
  }

  const measured = metrics.filter(m => m.source === 'measured').length;
  return {
    ok: measured > 0, metrics: measured > 0 ? metrics : [],
    error: measured > 0 ? undefined : describe(missing[0]?.error),
    notes: notes.length ? notes.join('; ') : undefined,
  };
}

module.exports = { pollCracModbus, targetOf, withPool, describe };
