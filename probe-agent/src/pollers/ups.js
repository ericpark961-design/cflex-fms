// pollers/ups.js — wraps ups-probe-engine and threshold-evaluates each poll.
// Forwards normalized telemetry + threshold breaches as events to cflex.
const { pollMetrics } = require('../services/ups-metrics');
const forwarder = require('../forwarder');
// Default thresholds (per-device override comes from the device config).
const { DEFAULT_THRESHOLDS } = require('./thresholds');

function evaluateAlerts(device, metrics, thresholds) {
  // A ledger row with no override carries `thresholds: null`, which a default
  // parameter would let through.
  thresholds = thresholds || DEFAULT_THRESHOLDS;
  const alerts = [];

  // Output source first: the alarm engine holds the battery-capacity warning
  // while the UPS is on battery, so it has to know that before it sees the
  // capacity (contract appendix B v1.1).
  if (metrics.output_source && metrics.output_source !== 'onLine' && metrics.output_source !== 'normal') {
    alerts.push({ severity: 'P2', metric: 'output_source', value: metrics.output_source, message: `Output source: ${metrics.output_source}` });
  }
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
  if (metrics.battery_status && /low|depleted|replace/i.test(metrics.battery_status)) {
    alerts.push({ severity: 'P1', metric: 'battery_status', value: metrics.battery_status, message: `Battery status: ${metrics.battery_status}` });
  }
  return alerts;
}

// Per-device reachability memory, so a device that has been down for six weeks
// does not produce a fresh P2 on every cycle. It produced 3,594 alert rows in
// October alone, which is not monitoring — it is a wall nobody can read.
//
// One alert per hour per device was still 41 an hour for this fleet, because
// all 41 HAEA devices are unreachable and will stay that way until a probe is
// placed inside their network. The interval therefore doubles each time: a
// device that has just gone down is urgent, and one that has been down for a
// fortnight is a fact, not news.
const unreachableSince = new Map();
const FIRST_RE_ALERT_MS = 60 * 60 * 1000;      // 1 h after the transition
const MAX_RE_ALERT_MS = 24 * 60 * 60 * 1000;   // then 2, 4, 8, 16, capped at a day

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
    // Alert on the transition, then on a doubling interval while it stays down.
    const prev = unreachableSince.get(device.id);
    const wait = prev ? prev.interval : 0;
    if (!prev || Date.now() - prev.lastAlert >= wait) {
      const downMin = prev ? Math.round((Date.now() - prev.since) / 60000) : 0;
      const next = prev ? Math.min(prev.interval * 2, MAX_RE_ALERT_MS) : FIRST_RE_ALERT_MS;
      await forwarder.sendEvent('alert', {
        device_id: device.id, device_name: device.name,
        severity: 'P2', metric: 'reachability',
        message: prev
          ? `UPS unreachable ${downMin}분 경과: ${why} (다음 알림 ${Math.round(next / 60000)}분 후)`
          : `UPS unreachable: ${why}`,
        ts: Date.now(),
      });
      unreachableSince.set(device.id, {
        since: prev?.since || Date.now(), lastAlert: Date.now(), interval: next,
      });
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
