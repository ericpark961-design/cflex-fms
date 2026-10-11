// services/ups-metrics.js — pure SNMP metrics fetcher for a single UPS device.
// Extracted from cflex-v2 ups-poller.js, stripped of DB / logger / ticket coupling.
// Returns { ok, ...metrics } — caller decides what to do with it.
const snmp = require('net-snmp');
const { createSession, selectOidProfile, isApcVendor } = require('./snmp-helpers');

function numberOrNull(v) {
  if (v == null) return null;
  const n = +v;
  return isNaN(n) ? null : n;
}
function batteryStatusName(code) {
  return ({ 2: 'normal', 3: 'low', 4: 'depleted' }[code]) || 'unknown';
}
function apcOutputStatusName(code) {
  return ({ 2: 'onLine', 3: 'onBattery', 4: 'onSmartBoost', 6: 'softwareBypass', 7: 'off', 8: 'rebooting', 12: 'onSmartTrim' }[code]) || 'unknown';
}
function outputSourceName(code) {
  return ({ 1: 'other', 2: 'none', 3: 'onLine', 4: 'bypass', 5: 'onBattery', 6: 'booster', 7: 'reducer' }[code]) || 'unknown';
}

function pollMetrics(device, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  const retries = opts.retries ?? 1;
  return new Promise((resolve) => {
    let session;
    try {
      session = createSession(device, { timeout: timeoutMs, retries });
    } catch (e) {
      return resolve({ ok: false, error: 'session: ' + e.message });
    }
    const isApc = isApcVendor(device);
    const OID = selectOidProfile(device);
    const oidKeys = Object.keys(OID);
    const oids = oidKeys.map((k) => OID[k]);

    session.get(oids, (err, varbinds) => {
      session.close();
      if (err) return resolve({ ok: false, error: err.message });

      const result = {};
      varbinds.forEach((vb, i) => {
        const key = oidKeys[i];
        if (snmp.isVarbindError(vb)) { result[key] = null; return; }
        let v = vb.value;
        if (Buffer.isBuffer(v)) v = v.toString('utf8').trim();
        result[key] = v;
      });

      const battery_pct = numberOrNull(result.batteryCharge);
      const load_pct = numberOrNull(result.outputLoad);
      const temp_c = numberOrNull(result.batteryTemp);
      let runtime_min = numberOrNull(result.batteryRuntime);
      if (isApc && runtime_min != null) runtime_min = Math.round(runtime_min / 6000); // ticks → minutes
      const output_v = result.outputVoltage != null ? (isApc ? +result.outputVoltage : +result.outputVoltage / 10) : null;
      const input_v = result.inputVoltage != null ? (isApc ? +result.inputVoltage : +result.inputVoltage / 10) : null;
      const battery_status = batteryStatusName(result.batteryStatus);
      const output_source = isApc ? apcOutputStatusName(result.outputSource) : outputSourceName(result.outputSource);

      // Health 0-100
      let health = 100;
      if (battery_pct != null && battery_pct < 50) health -= (50 - battery_pct) * 1.5;
      if (load_pct != null && load_pct > 80) health -= (load_pct - 80) * 2;
      if (temp_c != null && temp_c > 35) health -= (temp_c - 35) * 4;
      if (battery_status === 'low' || battery_status === 'depleted') health -= 40;
      if (output_source === 'onBattery') health -= 30;
      health = Math.max(0, Math.min(100, Math.round(health)));
      const status = health >= 80 ? 'ok' : health >= 50 ? 'warn' : 'critical';

      resolve({
        ok: true,
        battery_pct, load_pct, temp_c, runtime_min,
        output_v, input_v, output_source, battery_status,
        status, health_score: health,
        manufacturer: result.identManufacturer || null,
        model: result.identModel || null,
        firmware: result.identFirmware || null,
      });
    });
  });
}

module.exports = { pollMetrics };
