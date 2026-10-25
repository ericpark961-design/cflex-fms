// config.js — load + validate env
//
// dotenv is a convenience, not a requirement: in production systemd supplies
// the environment (`EnvironmentFile=/opt/cflex-probe/.env` in the unit), so
// `.env` is already loaded by the time this runs. Requiring it hard meant an
// install-time CLI — cflex-csr, cflex-test-ticket — died with
// MODULE_NOT_FOUND on a host where dependencies are not installed yet, which
// is exactly when those tools are needed.
try { require('dotenv').config(); } catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}

const cfg = {
  cflexUrl: process.env.CFLEX_URL || 'https://cflex.runless.co.uk',
  cflexToken: process.env.CFLEX_TOKEN || '',
  tenantId: process.env.TENANT_ID || 'HAEA',
  probeId: process.env.PROBE_ID || 'probe-haea-vm1',

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  // How many devices to poll at once. Serial polling could not finish a cycle
  // inside the interval, let alone inside the cloud's 5-minute freshness gate.
  // 8 brought a 41-device unreachable fleet from 420 s to 62 s, which clears
  // the cloud's 5-minute freshness gate but still overran the 60 s interval and
  // skipped every other tick. 12 puts it at about 40 s.
  pollConcurrency: parseInt(process.env.POLL_CONCURRENCY || '12', 10),
  // Contract §3.1 / D-07: 60 s. The Portal's PROBE_OFFLINE gate is 5 minutes.
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10),
  // Contract §3.3: a telemetry batch every 60 s (or at 500 points, whichever first).
  telemetryFlushMs: parseInt(process.env.TELEMETRY_FLUSH_MS || '60000', 10),

  // The Portal, per contract IFC-CFLEX-2026-1023 v1.0. Only paths go in env —
  // the key file stays on the node (0600) and is never read into a log.
  portal: {
    enabled: process.env.CFLEX_PORTAL_ENABLED !== '0',
    url: process.env.CFLEX_PORTAL_URL || 'https://cflex.fms.support',
    nodeId: process.env.CFLEX_NODE_ID || 'cap01',
    siteId: process.env.CFLEX_SITE_ID || 'HAEA-HQ',
    profile: process.env.CFLEX_PROFILE || 'bare',
    tls: {
      certPath: process.env.CFLEX_TLS_CERT || '',
      keyPath: process.env.CFLEX_TLS_KEY || '',
      caPath: process.env.CFLEX_TLS_CA || '',
      proxyCaPath: process.env.CFLEX_PROXY_CA || '',
    },
    proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    noProxy: process.env.NO_PROXY || process.env.no_proxy || '',
  },

  // The old cloud path (/v1/probe/event with X-Probe-Key). Kept only so a site
  // still on it can be switched back; off unless asked for.
  legacy: {
    enabled: process.env.CFLEX_LEGACY_FORWARD === '1',
  },

  // Local notification (HAEA SMTP relay / Teams / ServiceNow). The file holds
  // the channel config and, by reference (…File keys), its secrets; 0600.
  notify: {
    configPath: process.env.CFLEX_NOTIFY_CONFIG || '',
    itsmStorePath: process.env.CFLEX_ITSM_STORE || './data/itsm-map.json',
    idStorePath: process.env.CFLEX_ID_STORE || './data/device-ids.json',
  },

  // Alarm engine (alarms/engine.js). Defaults are the engine's; only what is set here overrides.
  alarms: Object.fromEntries(Object.entries({
    updateEveryMs: process.env.ALARM_UPDATE_EVERY_MS,
    flapWindowMs: process.env.ALARM_FLAP_WINDOW_MS,
    flapRaises: process.env.ALARM_FLAP_RAISES,
    flapQuietMs: process.env.ALARM_FLAP_QUIET_MS,
  }).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, parseInt(v, 10)])),

  bufferDbPath: process.env.BUFFER_DB_PATH || './data/buffer.db',
  bufferRetentionDays: parseInt(process.env.BUFFER_RETENTION_DAYS || '7', 10),

  localApiPort: parseInt(process.env.LOCAL_API_PORT || '8080', 10),
  localApiBind: process.env.LOCAL_API_BIND || '127.0.0.1',

  snmp: {
    version: process.env.SNMP_VERSION || '2c',
    community: process.env.SNMP_COMMUNITY || 'public',
    timeoutMs: parseInt(process.env.SNMP_TIMEOUT_MS || '3000', 10),
    retries: parseInt(process.env.SNMP_RETRIES || '2', 10),
  },
};

if (cfg.legacy.enabled && !cfg.cflexToken) {
  console.warn('[config] WARN: CFLEX_LEGACY_FORWARD=1 but CFLEX_TOKEN not set — legacy events will fail and buffer');
}
if (cfg.portal.enabled && !(cfg.portal.tls.certPath && cfg.portal.tls.keyPath)) {
  console.warn('[config] WARN: CFLEX_TLS_CERT/CFLEX_TLS_KEY not set — the Portal will refuse this node (mTLS, contract §1)');
}

module.exports = cfg;
