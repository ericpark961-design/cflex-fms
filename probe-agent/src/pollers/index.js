// Which collector a device gets, and the one shape they all return.
//
// The agent polled exactly one kind of thing — a UPS — and everything else in
// the room was a shape on a floor plan with a number typed under it. Adding
// three more collectors means the cycle has to choose, so the choice lives
// here rather than as a growing if-chain in the loop.
//
// Every collector returns { ok, metrics[], error?, notes?, unsupported? } and
// every metric carries its own unit, raw value, OID and confidence. A
// collector that cannot read a device returns ok:false with a reason; one that
// reads some of it returns what it got. Partial is normal: which objects a PDU
// or a NetBotz exposes depends on what is plugged into it.
const { pollPdu } = require('./pdu');
const { pollNetbotz } = require('./netbotz');
const { pollNetwork } = require('./network');
const { pollCrac } = require('./crac');

// `ups` is deliberately absent, and not even imported: a UPS goes down its own
// path, which evaluates thresholds and forwards telemetry in the shape the
// cloud already stores in ups_metrics. Routing it here would mean two writers
// for the same table — and requiring it here would drag the SNMP engine into
// every caller that only wanted to ask which collector a PDU gets.
const COLLECTORS = {
  pdu: pollPdu,
  netbotz: pollNetbotz,
  crac: pollCrac,
  switch: pollNetwork,
  router: pollNetwork,
  sbc: pollNetwork,
  server: pollNetwork,
  storage: pollNetwork,
};

// Things that are in the ledger, take up U, and have nothing to say over the
// network. Asking them anyway produces a timeout per cycle and a device that
// looks broken because it is a patch panel.
const PASSIVE = new Set(['patch', 'passive', 'blank', 'cable', 'rack', 'ats']);

const kindOf = (d) => String(d.kind || '').toLowerCase().trim();

/** The collector for a device, or null when it is passive or a UPS. */
function collectorFor(device) {
  const k = kindOf(device);
  if (k === 'ups') return null;
  if (PASSIVE.has(k)) return null;
  return COLLECTORS[k] || null;
}

/** Why a device has no collector — for a report that says so rather than silence. */
function skipReason(device) {
  const k = kindOf(device);
  if (k === 'ups') return 'ups (own path)';
  if (PASSIVE.has(k)) return 'passive';
  if (!k) return 'kind not set in the ledger';
  return `no collector for kind "${k}"`;
}

/**
 * Poll one non-UPS device.
 * @returns {{ok, metrics, error?, notes?, unsupported?, skipped?}}
 */
async function pollOne(device, opts = {}) {
  const fn = collectorFor(device);
  if (!fn) return { ok: false, skipped: true, metrics: [], error: skipReason(device) };
  try {
    const r = await fn(device, opts);
    return { metrics: [], ...r };
  } catch (e) {
    return { ok: false, metrics: [], error: e.message };
  }
}

module.exports = { pollOne, collectorFor, skipReason, COLLECTORS, PASSIVE };
