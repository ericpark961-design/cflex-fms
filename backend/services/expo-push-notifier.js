// services/expo-push-notifier.js
// Expo push fan-out for FMS mobile app subscribers.
// Called from alarm-notifier.js as an additional channel (NOT through fms_alarm_routes).
const axios = require('axios');
const db = require('../config/database');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const TIMEOUT = 12_000;

// Priority (P1-P4) → severity tier used by the mobile app.
// Allows per-subscriber min_severity filtering and channel selection on Android.
const PRIORITY_TO_SEVERITY = {
  P1: 'critical',
  P2: 'warn',
  P3: 'warn',
  P4: 'ok',
};

const SEVERITY_RANK = { critical: 0, warn: 1, unreachable: 1, ok: 2 };

function severityFor(alert) {
  if (alert.severity && SEVERITY_RANK[alert.severity] != null) return alert.severity;
  return PRIORITY_TO_SEVERITY[alert.priority] || 'warn';
}

function channelIdFor(sev) {
  if (sev === 'critical') return 'fms-critical';
  if (sev === 'warn' || sev === 'unreachable') return 'fms-warn';
  return 'fms-info';
}

function buildTitle(alert, asset) {
  const where = asset?.label || alert.device_id;
  return `[${alert.priority || 'P?'}] ${where}`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Drop tokens Expo says are no longer registered, so we don't keep retrying.
function pruneInvalid(tickets, tokens) {
  if (!Array.isArray(tickets)) return;
  for (let i = 0; i < tickets.length; i++) {
    const tk = tickets[i];
    if (tk?.status === 'error') {
      const err = tk.details?.error;
      if (err === 'DeviceNotRegistered') {
        try {
          db.prepare('DELETE FROM fms_push_subscriptions WHERE expo_push_token = ?').run(tokens[i]);
          console.log('[expo-push] pruned DeviceNotRegistered', tokens[i].slice(0, 24) + '…');
        } catch (_) {}
      } else {
        console.warn('[expo-push] error', err, tk.message || '');
      }
    }
  }
}

async function dispatch(alert, asset) {
  try {
    if (!alert || !alert.tenant_id) return { sent: 0 };
    const sev = severityFor(alert);

    const subs = db.prepare(
      "SELECT id, expo_push_token, min_severity FROM fms_push_subscriptions WHERE tenant_id = ? AND app = 'fms'"
    ).all(alert.tenant_id);
    if (!subs.length) return { sent: 0 };

    const targets = subs.filter((s) => {
      const min = s.min_severity || 'warn';
      return SEVERITY_RANK[sev] <= SEVERITY_RANK[min];
    });
    if (!targets.length) return { sent: 0 };

    const title = buildTitle(alert, asset);
    const body = String(alert.message || '').slice(0, 240);

    const messages = targets.map((s) => ({
      to: s.expo_push_token,
      title,
      body,
      sound: sev === 'critical' ? 'default' : null,
      priority: 'high',
      channelId: channelIdFor(sev),
      data: {
        alertId: alert.id,
        deviceId: alert.device_id,
        severity: sev,
        priority: alert.priority,
        tenantId: alert.tenant_id,
      },
    }));

    let sent = 0;
    for (const batch of chunk(messages, 100)) {
      try {
        const r = await axios.post(EXPO_URL, batch, {
          headers: {
            accept: 'application/json',
            'accept-encoding': 'gzip, deflate',
            'content-type': 'application/json',
          },
          timeout: TIMEOUT,
        });
        const tickets = r.data?.data || [];
        pruneInvalid(
          tickets,
          batch.map((m) => m.to),
        );
        sent += tickets.filter((t) => t?.status === 'ok').length;
      } catch (e) {
        console.error('[expo-push] batch failed:', e.message);
      }
    }
    // Best-effort audit log; reuse fms_alarm_dispatch_log table if present.
    try {
      db.prepare(
        'INSERT INTO fms_alarm_dispatch_log (alert_id, channel, target, ok, error, sent_at) VALUES (?,?,?,?,?,?)'
      ).run(alert.id || 0, 'expo', `subs:${targets.length}`, sent > 0 ? 1 : 0, sent > 0 ? null : 'no_ok', Date.now());
    } catch (_) {}

    console.log('[expo-push]', alert.id, '→', `${sent}/${targets.length} delivered`);
    return { sent, attempted: targets.length };
  } catch (e) {
    console.error('[expo-push] dispatch error:', e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = { dispatch };
