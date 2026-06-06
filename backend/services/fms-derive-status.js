// services/fms-derive-status.js — port of the TypeScript derive-status logic
// shipped in cflex-ups-icons. Given a UPS reading (the metrics + SNMP enum
// values that the probe forwards), return { status, reasons[] } where status
// is one of: 'ok' | 'warn' | 'critical' | 'unreachable'.
// Output names match the legacy ups_devices.status column convention so the
// existing UI keeps working.

const THRESHOLDS = {
  loadCritical: 100,
  loadWarning: 90,
  capacityCritical: 30,
  capacityWarning: 50,
  tempWarningC: 45,
  runtimeWarningSec: 300,
};

// PowerNet-MIB upsBasicOutputStatus enum
const OutputStatus = {
  unknown: 1, onLine: 2, onBattery: 3, onSmartBoost: 4, timedSleeping: 5,
  softwareBypass: 6, off: 7, rebooting: 8, switchedBypass: 9,
  hardwareFailureBypass: 10, sleepingUntilPowerReturn: 11, onSmartTrim: 12,
  ecoMode: 13, hotStandby: 14, onBatteryTest: 15, emergencyStaticBypass: 16,
};
const BatteryStatus = { unknown: 1, normal: 2, low: 3 };
const ReplaceIndicator = { no: 1, needsReplacing: 2 };
const OUTPUT_STATUS_LABEL = {
  1: 'Unknown', 2: 'Online', 3: 'On Battery', 4: 'Smart Boost', 5: 'Timed Sleeping',
  6: 'Software Bypass', 7: 'Off', 8: 'Rebooting', 9: 'Switched Bypass',
  10: 'Hardware Fault Bypass', 11: 'Sleeping', 12: 'Smart Trim', 13: 'ECO Mode',
  14: 'Hot Standby', 15: 'Battery Test', 16: 'Emergency Static Bypass',
};

const RANK = { ok: 0, warn: 1, critical: 2, unreachable: 3 };

/**
 * Reading shape (all optional except reachable):
 *   { reachable, error,
 *     outputStatus, batteryStatus, batteryReplace,
 *     outputLoadPct, batteryCapacity, batteryTempC, runtimeRemainingSec }
 */
function deriveStatus(r) {
  if (r == null || r.reachable === false) {
    return { status: 'unreachable', reasons: [r?.error ? `SNMP: ${r.error}` : 'SNMP unreachable'] };
  }
  const reasons = [];
  let level = 'ok';
  const raise = (to, why) => {
    reasons.push(why);
    if (RANK[to] > RANK[level]) level = to;
  };

  const os = r.outputStatus;
  const osLabel = os != null ? (OUTPUT_STATUS_LABEL[os] || `Status ${os}`) : 'Unknown';

  // ── critical ──
  if (os === OutputStatus.off) raise('critical', 'Output OFF');
  if (os === OutputStatus.hardwareFailureBypass) raise('critical', 'Hardware fault bypass');
  if (os === OutputStatus.sleepingUntilPowerReturn) raise('critical', 'Awaiting power return');
  if (os === OutputStatus.onBattery) raise('critical', 'On battery');
  if (r.batteryStatus === BatteryStatus.low) raise('critical', 'Battery low');
  if (r.outputLoadPct != null && r.outputLoadPct > THRESHOLDS.loadCritical)
    raise('critical', `Overload ${r.outputLoadPct}%`);
  if (r.batteryCapacity != null && r.batteryCapacity < THRESHOLDS.capacityCritical)
    raise('critical', `Charge ${r.batteryCapacity}%`);

  // ── warning ──
  if (os === OutputStatus.softwareBypass || os === OutputStatus.switchedBypass || os === OutputStatus.emergencyStaticBypass)
    raise('warn', osLabel);
  if (os === OutputStatus.onSmartBoost || os === OutputStatus.onSmartTrim)
    raise('warn', osLabel);
  if (os === OutputStatus.onBatteryTest) raise('warn', 'Self-test running');
  if (r.batteryReplace === ReplaceIndicator.needsReplacing) raise('warn', 'Replace battery');
  if (r.batteryCapacity != null && r.batteryCapacity < THRESHOLDS.capacityWarning && r.batteryCapacity >= THRESHOLDS.capacityCritical)
    raise('warn', `Charge ${r.batteryCapacity}%`);
  if (r.outputLoadPct != null && r.outputLoadPct > THRESHOLDS.loadWarning && r.outputLoadPct <= THRESHOLDS.loadCritical)
    raise('warn', `High load ${r.outputLoadPct}%`);
  if (r.batteryTempC != null && r.batteryTempC > THRESHOLDS.tempWarningC)
    raise('warn', `Battery ${r.batteryTempC}°C`);
  if (r.runtimeRemainingSec != null && r.runtimeRemainingSec < THRESHOLDS.runtimeWarningSec)
    raise('warn', `Runtime ${Math.round(r.runtimeRemainingSec / 60)} min`);

  if (level === 'ok') reasons.push(osLabel || 'Online');
  return { status: level, reasons };
}

module.exports = { deriveStatus, THRESHOLDS, OutputStatus, BatteryStatus, ReplaceIndicator, OUTPUT_STATUS_LABEL };
