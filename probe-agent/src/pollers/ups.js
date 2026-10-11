// pollers/ups.js — wraps ups-probe-engine and threshold-evaluates each poll.
// Forwards normalized telemetry + threshold breaches as events to cflex.
const { pollMetrics } = require('../services/ups-metrics');
const forwarder = require('../forwarder');

// Default thresholds (per-device override comes from cflex device config).
const DEFAULT_THRESHOLDS = {
  battery_critical_pct: 30,
  battery_warn_pct: 60,
  temp_critical_c: 45,
  temp_warn_c: 38,
  load_critical_pct: 90,
  load_warn_pct: 75,
  runtime_critical_min: 5,
  runtime_warn_min: 15,
};

function evaluateAlerts(device, metrics, thresholds = DEFAULT_THRESHOLDS) {
  const alerts = [];

  if (metrics.battery_pct != null) {
    if (metrics.battery_pct < thresholds.battery_critical_pct) {
      alerts.push({ severity: 'P1', metric: 'battery_pct', value: metrics.battery_pct, threshold: thresholds.battery_critical_pct, message: `Battery critically low (${metrics.battery_pct}%)` });
    } else if (metrics.battery_pct < thresholds.battery_warn_pct) {
      alerts.push({ severity: 'P2', metric: 'battery_pct', value: metrics.battery_pct, threshold: thresholds.battery_warn_pct, message: `Battery low (${metrics.battery_pct}%)` });
    }
  }
  if (metrics.temp_c != null) {
    if (metrics.temp_c > thresholds.temp_critical_c) {
      alerts.push({ severity: 'P1', metric: 'temp_c', value: metrics.temp_c, threshold: thresholds.temp_critical_c, message: `Battery overheating (${metrics.temp_c}°C)` });
    } else if (metrics.temp_c > thresholds.temp_warn_c) {
      alerts.push({ severity: 'P2', metric: 'temp_c', value: metrics.temp_c, threshold: thresholds.temp_warn_c, message: `Battery temperature elevated (${metrics.temp_c}°C)` });
    }
  }
  if (metrics.load_pct != null) {
    if (metrics.load_pct > thresholds.load_critical_pct) {
      alerts.push({ severity: 'P1', metric: 'load_pct', value: metrics.load_pct, threshold: thresholds.load_critical_pct, message: `Load critical (${metrics.load_pct}%)` });
    } else if (metrics.load_pct > thresholds.load_warn_pct) {
      alerts.push({ severity: 'P2', metric: 'load_pct', value: metrics.load_pct, threshold: thresholds.load_warn_pct, message: `Load high (${metrics.load_pct}%)` });
    }
  }
  if (metrics.runtime_min != null && metrics.output_source === 'onBattery') {
    if (metrics.runtime_min < thresholds.runtime_critical_min) {
      alerts.push({ severity: 'P1', metric: 'runtime_min', value: metrics.runtime_min, threshold: thresholds.runtime_critical_min, message: `On battery — runtime critically low (${metrics.runtime_min} min)` });
    } else if (metrics.runtime_min < thresholds.runtime_warn_min) {
      alerts.push({ severity: 'P2', metric: 'runtime_min', value: metrics.runtime_min, threshold: thresholds.runtime_warn_min, message: `On battery — runtime low (${metrics.runtime_min} min)` });
    }
  }
  if (metrics.output_source && metrics.output_source !== 'onLine' && metrics.output_source !== 'normal') {
    alerts.push({ severity: 'P2', metric: 'output_source', value: metrics.output_source, message: `Output source: ${metrics.output_source}` });
  }
  if (metrics.battery_status && /low|depleted|replace/i.test(metrics.battery_status)) {
    alerts.push({ severity: 'P1', metric: 'battery_status', value: metrics.battery_status, message: `Battery status: ${metrics.battery_status}` });
  }
  return alerts;
}

// Per-device reachability memory, so a device that has been down for six weeks
// does not produce a fresh P2 on every cycle. It produced 3,594 alert rows in
// October alone, which is not monitoring — it is a wall nobody can read.
const unreachableSince = new Map();
const RE_ALERT_MS = 60 * 60 * 1000;

async function pollDevice(device) {
  const startedAt = Date.now();
  let metrics, error;
  try {
    metrics = await pollMetrics(device);
  } catch (e) {
    error = e.message;
  }
  const took = Date.now() - startedAt;

  if (error || !metrics || metrics.ok === false) {
    const why = error || 'no response';
    await forwarder.sendEvent('telemetry', {
      device_id: device.id, device_name: device.name, kind: 'ups',
      ts: Date.now(), ok: false, error: error || 'no metrics', took_ms: took,
    });
    // Alert on the transition, then at most hourly while it stays down.
    const prev = unreachableSince.get(device.id);
    if (!prev || Date.now() - prev.lastAlert >= RE_ALERT_MS) {
      const downFor = prev ? Math.round((Date.now() - prev.since) / 60000) : 0;
      await forwarder.sendEvent('alert', {
        device_id: device.id, device_name: device.name,
        severity: 'P2', metric: 'reachability',
        message: downFor
          ? `UPS unreachable ${downFor}분 경과: ${why}`
          : `UPS unreachable: ${why}`,
        ts: Date.now(),
      });
      unreachableSince.set(device.id, { since: prev?.since || Date.now(), lastAlert: Date.now() });
    }
    // The caller could not tell success from failure: both paths returned
    // undefined, so the cycle logged "41 ok, 0 fail" while every one of the 41
    // had timed out, and the heartbeat reported a healthy collector.
    return { ok: false, error: why, took_ms: took };
  }
  if (unreachableSince.has(device.id)) {
    unreachableSince.delete(device.id);
    await forwarder.sendEvent('alert', {
      device_id: device.id, device_name: device.name,
      severity: 'P4', metric: 'reachability',
      message: 'UPS reachable again', ts: Date.now(),
    });
  }

  await forwarder.sendEvent('telemetry', {
    device_id: device.id, device_name: device.name, kind: 'ups',
    ts: Date.now(), ok: true, metrics, took_ms: took,
  });

  const alerts = evaluateAlerts(device, metrics, device.thresholds);
  for (const a of alerts) {
    await forwarder.sendEvent('alert', {
      device_id: device.id, device_name: device.name, ts: Date.now(), ...a,
    });
  }
  return { ok: true, took_ms: took, alerts: alerts.length };
}

module.exports = { pollDevice, evaluateAlerts, unreachableSince };
