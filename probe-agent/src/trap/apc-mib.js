// trap/apc-mib.js — APC PowerNet-MIB traps → contract appendix-B codes.
//
// PowerNet-MIB defines its traps as SNMPv1 TRAP-TYPE, ENTERPRISE apc
// (1.3.6.1.4.1.318), so a v1 trap arrives as enterprise 318 / generic 6 /
// specific N, and the same trap sent as v2c or v3 has snmpTrapOID
// 1.3.6.1.4.1.318.0.N (RFC 3584 §3.1). Both are looked up by N.
//
// Only traps whose condition has an appendix-B code are here. The dictionary
// is UPS-only: environment (temperature/humidity probes), NetBotz (door, leak,
// smoke) and Rack PDU (bank overload, outlet state) traps have no code, so
// they are not listed and take the unknown path (trap/handler.js) — recorded
// on the Probe, never sent as an alarm. New codes are a contract change
// (DECISIONS Q-2026-10-26-05), not something this table may invent.
//
// `raise` opens the code's alarm, `clear` closes it. Every raise here has its
// clear, so an alarm opened by a trap can always be closed by one.
// UPS_COMM_LOST keeps appendix B's 30-minute rule: `hold` = raise only when the
// UPS has not come back by then.
//
// Trap numbers are PowerNet-MIB's; check them against the site's NMC firmware
// MIB file at SAT (DECISIONS Q-2026-10-26-06). This is a table, so a wrong
// number is a one-line fix.
const APC_ENTERPRISE = '1.3.6.1.4.1.318';

const TRAPS = Object.freeze({
  1: { name: 'communicationLost', code: 'UPS_COMM_LOST', action: 'raise', hold: 'comm_lost' },
  2: { name: 'upsOverload', code: 'UPS_OVERLOAD', action: 'raise' },
  3: { name: 'upsDiagnosticsFailed', code: 'UPS_SELFTEST_FAIL', action: 'raise' },
  5: { name: 'upsOnBattery', code: 'UPS_ON_BATTERY', action: 'raise' },
  7: { name: 'lowBattery', code: 'UPS_LOW_BATTERY', action: 'raise' },
  8: { name: 'communicationEstablished', code: 'UPS_COMM_LOST', action: 'clear' },
  9: { name: 'powerRestored', code: 'UPS_ON_BATTERY', action: 'clear' },
  10: { name: 'upsDiagnosticsPassed', code: 'UPS_SELFTEST_FAIL', action: 'clear' },
  11: { name: 'returnFromLowBattery', code: 'UPS_LOW_BATTERY', action: 'clear' },
  12: { name: 'upsTurnedOff', code: 'UPS_OUTPUT_OFF', action: 'raise' },
  17: { name: 'upsBatteryNeedsReplacement', code: 'UPS_BATTERY_REPLACE', action: 'raise' },
  20: { name: 'hardwareFailureBypass', code: 'UPS_ON_BYPASS', action: 'raise' },
  21: { name: 'softwareBypass', code: 'UPS_ON_BYPASS', action: 'raise' },
  22: { name: 'switchedBypass', code: 'UPS_ON_BYPASS', action: 'raise' },
  23: { name: 'returnFromBypass', code: 'UPS_ON_BYPASS', action: 'clear' },
  30: { name: 'upsTurnedOn', code: 'UPS_OUTPUT_OFF', action: 'clear' },
  33: { name: 'upsOverloadCleared', code: 'UPS_OVERLOAD', action: 'clear' },
  36: { name: 'upsBatteryReplaced', code: 'UPS_BATTERY_REPLACE', action: 'clear' },
});

/**
 * Codes the UPS poller also sees (alarms/codes.js classify). For these the
 * poll stays the judge of "still there", as for any poll alarm; the rest are
 * latched until their clear trap (alarms/engine.js observe).
 */
const POLL_SEEN = new Set([
  'UPS_ON_BATTERY', 'UPS_LOW_BATTERY', 'UPS_OVERLOAD', 'UPS_OUTPUT_OFF', 'UPS_ON_BYPASS', 'UPS_BATTERY_REPLACE',
]);

const PREFIX = `${APC_ENTERPRISE}.0.`;

/** snmpTrapOID → mapping entry with its oid, or null (not APC, or not in the table). */
function lookup(trapOid) {
  const s = String(trapOid || '');
  if (!s.startsWith(PREFIX)) return null;
  const n = s.slice(PREFIX.length);
  if (!/^\d+$/.test(n)) return null;
  const t = TRAPS[n];
  return t ? { ...t, specific: Number(n), oid: s, latched: !POLL_SEEN.has(t.code) } : null;
}

module.exports = { APC_ENTERPRISE, TRAPS, POLL_SEEN, lookup };
