// pollers/thresholds.js — the UPS poller's threshold defaults, and the Local
// Console's threshold shape translated into them.
//
// The console keeps thresholds per metric ({battery_pct: {critical, warn}},
// apps/console views.js); the poller reads flat keys. A device override on
// the console wins over the console-wide values, which win over these.
const DEFAULT_THRESHOLDS = Object.freeze({
  battery_critical_pct: 30,
  battery_warn_pct: 60,
  temp_critical_c: 45,
  temp_warn_c: 38,
  load_critical_pct: 90,
  load_warn_pct: 75,
  runtime_critical_min: 5,
  runtime_warn_min: 15,
});

const FLAT = {
  battery_pct: ['battery_critical_pct', 'battery_warn_pct'],
  temp_c: ['temp_critical_c', 'temp_warn_c'],
  load_pct: ['load_critical_pct', 'load_warn_pct'],
  runtime_min: ['runtime_critical_min', 'runtime_warn_min'],
};

/** Console threshold objects (site-wide, then per device) → the poller's flat thresholds. */
function fromConsole(...layers) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [metric, [crit, warn]] of Object.entries(FLAT)) {
      const t = layer[metric];
      if (!t || typeof t !== 'object') continue;
      if (Number.isFinite(Number(t.critical))) out[crit] = Number(t.critical);
      if (Number.isFinite(Number(t.warn))) out[warn] = Number(t.warn);
    }
  }
  return out;
}

module.exports = { DEFAULT_THRESHOLDS, fromConsole };
