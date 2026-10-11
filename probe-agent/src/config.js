// config.js — load + validate env
require('dotenv').config();

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
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10),

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

if (!cfg.cflexToken) {
  console.warn('[config] WARN: CFLEX_TOKEN not set — events will buffer locally only');
}

module.exports = cfg;
