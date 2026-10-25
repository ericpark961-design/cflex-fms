// alarms/codes.js — contract appendix B, the alarm code dictionary (v1).
//
// The severity of an alarm is its code's, not whatever the poller guessed.
// Site-level overrides are Portal policy (appendix B, last line), so there is
// no override here: the Probe sends the dictionary severity and the Portal
// re-ranks if a tenant asked it to.
const SEVERITY = Object.freeze({
  UPS_ON_BATTERY: 'P1',
  UPS_LOW_BATTERY: 'P1',
  UPS_OUTPUT_OFF: 'P1',
  UPS_BATTERY_FAILED: 'P1',
  UPS_OVERLOAD_SHUTDOWN_IMMINENT: 'P1',
  UPS_OVERLOAD: 'P2',
  UPS_ON_BYPASS: 'P2',
  UPS_HIGH_TEMP: 'P2',
  UPS_BATTERY_REPLACE: 'P2',
  UPS_FAN_FAIL: 'P2',
  COLLECTOR_DOWN: 'P2',
  UPS_SELFTEST_FAIL: 'P3',
  UPS_COMM_LOST: 'P3',
  UPS_RUNTIME_LOW_WARN: 'P3',
  PORTAL_LINK_DOWN: 'P3',
  UPS_SELFTEST_OK: 'P4',
  UPS_RETURN_FROM_BATTERY: 'P4',
  UPS_CONFIG_CHANGED: 'P4',
  BATTERY_EOL_90D: 'P4',
  CLOCK_DRIFT: 'P4',
  CONFIG_CONFLICT: 'P4',
});

const CODES = Object.freeze(Object.keys(SEVERITY));

/** Codes about the node itself; their events carry device_id null. */
const NODE_CODES = Object.freeze(['COLLECTOR_DOWN', 'PORTAL_LINK_DOWN', 'CLOCK_DRIFT', 'CONFIG_CONFLICT']);

/** Appendix B: `UPS_COMM_LOST (30분)` — only after 30 minutes without an answer. */
const COMM_LOST_AFTER_MS = 30 * 60 * 1000;

const severityOf = (code) => SEVERITY[code] || null;

/**
 * Which appendix-B code a poller threshold alert is. null = no code for it,
 * and the caller counts it rather than inventing one.
 *
 * The poller's own P1/P2 picks between two codes where the dictionary has two
 * (runtime critical = low battery, runtime warning = runtime-low warning); it
 * never sets the severity.
 *
 * `reachability` is not classified here: comm loss is decided from the poll
 * outcome itself (alarms/engine.js commStatus), with the 30-minute hold.
 */
function classify(a) {
  switch (a.metric) {
    case 'battery_pct':
      // Capacity under the critical floor is a low battery. Under the warning
      // floor only, the dictionary has no code — DECISIONS Q-2026-10-25-07.
      return a.severity === 'P1' ? 'UPS_LOW_BATTERY' : null;
    case 'temp_c': return 'UPS_HIGH_TEMP';
    case 'load_pct': return 'UPS_OVERLOAD';
    case 'runtime_min': return a.severity === 'P1' ? 'UPS_LOW_BATTERY' : 'UPS_RUNTIME_LOW_WARN';
    case 'output_source':
      if (a.value === 'onBattery') return 'UPS_ON_BATTERY';
      if (/bypass/i.test(a.value)) return 'UPS_ON_BYPASS';
      if (a.value === 'off') return 'UPS_OUTPUT_OFF';
      return null;
    case 'battery_status':
      if (/replace/i.test(a.value)) return 'UPS_BATTERY_REPLACE';
      if (/fail/i.test(a.value)) return 'UPS_BATTERY_FAILED';
      if (/low|depleted/i.test(a.value)) return 'UPS_LOW_BATTERY';
      return null;
    default: return null;
  }
}

module.exports = { SEVERITY, CODES, NODE_CODES, COMM_LOST_AFTER_MS, severityOf, classify };
