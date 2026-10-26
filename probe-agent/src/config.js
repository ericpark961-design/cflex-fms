// config.js — load + validate env
require('dotenv').config();

// D-13 (WO-INT-012): a collector sends only to the FMS (the Local Console).
// It has no Portal URL, no device certificate or key, no proxy and no old-cloud
// path — those settings live on the app nodes (apps/console/src/config.js).
const csv = (v) => String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const cfg = {
  tenantId: process.env.TENANT_ID || 'HAEA',
  probeId: process.env.PROBE_ID || process.env.CFLEX_NODE_ID || 'cap01',

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

  // This collector. node_id (cap01, cap02 …) is how the FMS knows it (its key)
  // and becomes collector_id at the Portal (contract 00 v1.2). siteId is the
  // fallback site for a device row without one. sites is the scope: the FMS
  // hands this collector only those sites' devices (empty = every site, the
  // HAEA first deployment with one collector).
  node: {
    nodeId: process.env.CFLEX_NODE_ID || 'cap01',
    siteId: process.env.CFLEX_SITE_ID || 'HAEA-HQ',
    sites: csv(process.env.CFLEX_COLLECTOR_SITES),
    profile: process.env.CFLEX_PROFILE || 'bare',
  },

  // The Local Console (spec 01 §2.1): the inventory comes from it, telemetry
  // and alarm events go to it, and it sends the local notifications
  // (DECISIONS Q-2026-10-25-10 (A), firewall request v3 FW-7: cap → app 443).
  // The key is a file (issued by `node src/cli.js collector-key <node>` on
  // the console, 0600); only its path is here.
  console: {
    url: process.env.CFLEX_CONSOLE_URL || '',
    keyPath: process.env.CFLEX_CONSOLE_KEY_FILE || '',
    // The CA that signed the console's nginx certificate (HAEA internal CA).
    caPath: process.env.CFLEX_CONSOLE_CA || '',
    timeoutMs: parseInt(process.env.CFLEX_CONSOLE_TIMEOUT_MS || '20000', 10),
  },
  // How often the inventory and config (thresholds, maintenance windows) are pulled again.
  configReloadMs: parseInt(process.env.CONFIG_RELOAD_MS || String(5 * 60 * 1000), 10),

  // Alarm engine (alarms/engine.js). Defaults are the engine's; only what is set here overrides.
  alarms: Object.fromEntries(Object.entries({
    updateEveryMs: process.env.ALARM_UPDATE_EVERY_MS,
    flapWindowMs: process.env.ALARM_FLAP_WINDOW_MS,
    flapRaises: process.env.ALARM_FLAP_RAISES,
    flapQuietMs: process.env.ALARM_FLAP_QUIET_MS,
  }).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, parseInt(v, 10)])),

  // SNMP trap listener (WO-INT-006, trap/listener.js). 1162 in the container
  // (the host forwards 162 → 1162, docs/install/CONTAINER_PROFILE.md §2); 162
  // on bare, where the unit grants CAP_NET_BIND_SERVICE. Credentials are the
  // console's per-device SNMP credentials — none are configured here.
  trap: {
    enabled: process.env.CFLEX_TRAP_ENABLED !== '0',
    port: parseInt(process.env.CFLEX_TRAP_PORT || '1162', 10),
    bind: process.env.CFLEX_TRAP_BIND || '0.0.0.0',
  },

  bufferDbPath: process.env.BUFFER_DB_PATH || './data/buffer.db',
  bufferRetentionDays: parseInt(process.env.BUFFER_RETENTION_DAYS || '7', 10),

  localApiPort: parseInt(process.env.LOCAL_API_PORT || '8080', 10),
  localApiBind: process.env.LOCAL_API_BIND || '127.0.0.1',

  snmp: {
    version: process.env.SNMP_VERSION || '2c',
    community: process.env.SNMP_COMMUNITY || 'public',
    timeoutMs: parseInt(process.env.SNMP_TIMEOUT_MS || '3000', 10),
    retries: parseInt(process.env.SNMP_RETRIES || '2', 10),
    // NMC agents answer on 161; another port only for a simulator on a test host.
    port: parseInt(process.env.SNMP_PORT || '161', 10),
  },
};

if (cfg.console.url && !cfg.console.keyPath) {
  console.warn('[config] WARN: CFLEX_CONSOLE_URL set but CFLEX_CONSOLE_KEY_FILE not — the Local Console will refuse this node');
}

module.exports = cfg;
