// FMS → @cflex/notify. The shim that lets the existing database-backed
// routing use the extracted package.
//
// `alarm-notifier.js` stays as it is: it is in production, it works, and
// swapping it out mid-sprint buys nothing. This adapter does the translation
// so new callers — the installer, the on-premises app, Codex's work — use the
// package directly, and so the two implementations can be compared on the
// same inputs before anything is switched over.
//
// Everything the package refuses to know lives here: which tables hold the
// routes, what an FMS `alert` row looks like, and where the secrets come from.
const notify = require('../../packages/notify/src');

/**
 * An FMS alert row + its asset → a package Notification.
 *
 * The package does not take an `alert`, on purpose: an alert is a row in this
 * product's schema, and a notification is a thing to deliver.
 */
function toNotification(alert, asset) {
  return {
    priority: alert.priority || 'P4',
    title: alert.message || alert.metric || 'alarm',
    where: [asset?.location, asset?.room, asset?.rack].filter(Boolean).join(' · ') || null,
    deviceId: alert.device_id ?? null,
    deviceLabel: asset?.label || alert.device_label || null,
    metric: alert.metric ?? null,
    value: alert.value ?? null,
    threshold: alert.threshold ?? null,
    id: alert.id != null ? String(alert.id) : null,
    // PagerDuty and ServiceNow group repeats on this. The incident layer
    // already computes a dedup key per cause; reuse it rather than inventing a
    // second scheme that disagrees with the first.
    dedupKey: alert.dedup_key || (alert.device_id && alert.metric
      ? `${alert.device_id}/${alert.metric}` : null),
    at: alert.received_at || Date.now(),
  };
}

/** `fms_alarm_routes` rows → package Routes. */
function toRoutes(rows = []) {
  return rows.map(r => ({
    channel: r.channel,
    target: r.target,
    minPriority: r.min_priority || 'P2',
    enabled: r.enabled == null ? true : !!r.enabled,
    label: r.label || null,
  }));
}

/**
 * Build the package config from this process's environment.
 *
 * This is the ONLY place that reads the environment. The package takes config
 * as an argument precisely so an on-premises install can load it from a 0600
 * file or a systemd credential instead, without the delivery code caring.
 */
function configFromEnv(env = process.env, overrides = {}) {
  return {
    productName: 'C-Flex FMS',
    dashboardUrl: env.FMS_DASHBOARD_URL || 'https://cflex.runless.co.uk/fms',
    fromName: 'RingOn FMS',
    fromAddress: env.FMS_FROM_ADDRESS || 'fms-alarm@ringonservice.net',
    timeoutMs: parseInt(env.FMS_NOTIFY_TIMEOUT_MS || '10000', 10),
    email: env.RESEND_API_KEY
      ? { transport: 'resend', resendKey: env.RESEND_API_KEY }
      : { transport: 'smtp' },
    sentinelConnect: {
      url: env.SC_INTERNAL_URL || 'http://localhost:3200',
      apiKey: env.INTERNAL_API_KEY || '',
      senderEmail: env.FMS_FROM_ADDRESS || 'fms-alarm@ringonservice.net',
    },
    runlessUc: { url: env.RUNLESS_UC_URL || 'http://localhost:3100', apiKey: env.INTERNAL_API_KEY || '' },
    ...(env.SNOW_INSTANCE_URL
      ? { servicenow: { instanceUrl: env.SNOW_INSTANCE_URL, auth: env.SNOW_AUTH || '' } }
      : {}),
    ...overrides,
  };
}

/**
 * Deliver one FMS alert through the package, using the DB's routes.
 *
 * Returns the package's result plus the rows to write to
 * `fms_alarm_dispatch_log` — the log is the caller's table, so this hands back
 * the data rather than writing it.
 */
async function dispatchAlert(db, alert, { asset = null, config = null, deps = {} } = {}) {
  const rows = db.prepare(
    'SELECT channel, min_priority, target, enabled FROM fms_alarm_routes WHERE tenant_id = ? AND enabled = 1',
  ).all(alert.tenant_id);
  if (!rows.length) return { sent: 0, failed: 0, results: [], skipped: [], logRows: [] };

  const out = await notify.send(
    toNotification(alert, asset),
    toRoutes(rows),
    config || configFromEnv(),
    deps,
  );
  const now = Date.now();
  return {
    ...out,
    logRows: out.results.map(r => ({
      alert_id: alert.id || 0, channel: r.channel, target: r.target,
      ok: r.ok ? 1 : 0, error: r.error || null, sent_at: now,
      tenant_id: alert.tenant_id ?? null,
    })),
  };
}

module.exports = { toNotification, toRoutes, configFromEnv, dispatchAlert, notify };
