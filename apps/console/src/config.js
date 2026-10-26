// config.js — the Local Console's settings, all from the environment so that
// app01 and app02 run the same image with the same file (spec 01 §2.2).
//
// Nothing here is per-node state. Sessions and login-failure counters live in
// Redis, data in PostgreSQL; the process itself can be killed and replaced
// on either VM without anyone being logged out.
const path = require('path');
const fs = require('fs');

const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => { const v = parseInt(env(k, ''), 10); return Number.isFinite(v) ? v : d; };

/** A secret is read from a file (systemd credential / Podman secret, 0600), never from argv or a log line. */
function secretFile(k) {
  const f = env(k, null);
  return f ? fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '') : null;
}

function load() {
  return {
    // Behind nginx on 443. The default is every interface (WO-INT-004); the
    // installer sets 127.0.0.1, because the nginx in front is always on the
    // same host (or network namespace) and the other node is reached through
    // its nginx on 443, never on this port (Q-2026-10-25-10). firewalld opens
    // only 443 either way.
    bind: env('CONSOLE_BIND', '0.0.0.0'),
    port: int('CONSOLE_PORT', 8080),
    nodeId: env('CONSOLE_NODE_ID', require('os').hostname()),
    // PostgreSQL 16 on db01 (WO-INT-008), the same database for app01 and app02.
    // CFLEX_DB_URL (no password in it) or the four parts; the password only from a 0600 file.
    db: {
      url: env('CFLEX_DB_URL', null),
      host: env('CFLEX_DB_HOST', '127.0.0.1'),
      port: int('CFLEX_DB_PORT', 5432),
      database: env('CFLEX_DB_NAME', 'cflex'),
      user: env('CFLEX_DB_USER', 'cflex'),
      passwordFile: env('CFLEX_DB_PASSWORD_FILE', null),
      poolMax: int('CFLEX_DB_POOL_MAX', 10),
    },
    // Spec 01 §2.3 / site.yaml `retention`. aggregateYears has no table to apply to yet.
    retention: {
      rawYears: int('CFLEX_RETENTION_RAW_YEARS', 3),
      aggregateYears: int('CFLEX_RETENTION_AGGREGATE_YEARS', 10),
      eventsYears: int('CFLEX_RETENTION_EVENTS_YEARS', 10),
    },
    // Month partitions made this many months ahead; the round runs on start and every intervalH.
    partitions: {
      aheadMonths: int('CFLEX_PARTITION_AHEAD_MONTHS', 3),
      intervalH: int('CFLEX_PARTITION_INTERVAL_H', 6),
    },
    redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379/0'),
    redisPassword: secretFile('REDIS_PASSWORD_FILE'),
    // AES-256-GCM key for stored SNMP / channel secrets (32 bytes, base64 or hex, in a 0600 file).
    secretKey: secretFile('CONSOLE_SECRET_KEY_FILE'),
    tenant: env('CFLEX_TENANT', 'HAEA'),
    tenantName: env('CFLEX_TENANT_NAME', 'HAEA'),
    defaultSite: env('CFLEX_SITE_ID', 'HAEA-HQ'),
    twinDir: env('CONSOLE_TWIN_DIR', path.resolve(__dirname, '../../twin/dist-console')),
    publicDir: path.resolve(__dirname, '../public'),
    // nginx terminates TLS, so the cookie is Secure; tests over plain HTTP turn it off.
    cookieSecure: env('CONSOLE_COOKIE_SECURE', '1') !== '0',
    trustProxy: env('CONSOLE_TRUST_PROXY', '1') !== '0',
    session: {
      idleS: int('CONSOLE_SESSION_IDLE_S', 30 * 60),
      absoluteS: int('CONSOLE_SESSION_MAX_S', 12 * 3600),
    },
    lockout: {
      maxFails: int('CONSOLE_LOCKOUT_FAILS', 5),
      windowS: int('CONSOLE_LOCKOUT_S', 15 * 60),
    },
    // Data with no poll inside this window shows as "no data" (the old backend's 5 minutes).
    staleMs: int('CONSOLE_STALE_S', 300) * 1000,
    saml: { enabled: env('CONSOLE_SAML', '0') === '1' },
    // DECISIONS Q-2026-10-25-09 (B): the HAEA build serves only the internal
    // screens' API. `portal` keeps the compatibility answers twin's portal
    // screens used to get (empty routes / control actions); nothing else differs.
    profile: env('CONSOLE_PROFILE', 'internal') === 'portal' ? 'portal' : 'internal',
    // The Portal (contract 00 v1.2, D-13): this node sends for every collector.
    // Only paths here — the device key stays on the node (0600) and is never
    // read into a log. On when CFLEX_PORTAL_ENABLED=1, or when a URL is set and
    // CFLEX_PORTAL_ENABLED is not 0.
    portal: {
      enabled: env('CFLEX_PORTAL_ENABLED', env('CFLEX_PORTAL_URL', null) ? '1' : '0') !== '0',
      url: env('CFLEX_PORTAL_URL', 'https://cflex.fms.support'),
      // The contract node id (app01): X-CFlex-Node and the certificate CN tenant.<node>.
      nodeId: env('CFLEX_NODE_ID', env('CONSOLE_NODE_ID', require('os').hostname())).toLowerCase(),
      profile: env('CFLEX_PROFILE', 'bare'),
      tls: {
        certPath: env('CFLEX_TLS_CERT', ''),
        keyPath: env('CFLEX_TLS_KEY', ''),
        caPath: env('CFLEX_TLS_CA', ''),
        // A TLS-inspecting proxy's CA: the same one local notification uses unless set apart.
        proxyCaPath: env('CFLEX_PROXY_CA', env('CONSOLE_PROXY_CA', '')),
      },
      proxy: env('HTTPS_PROXY', env('https_proxy', null)),
      noProxy: env('NO_PROXY', env('no_proxy', null)),
      timeoutMs: int('CFLEX_PORTAL_TIMEOUT_MS', 15000),
      // Contract §1 / D-07: what could not be delivered is kept 7 days.
      bufferDays: int('CFLEX_PORTAL_BUFFER_DAYS', 7),
      heartbeatMs: int('CFLEX_PORTAL_HEARTBEAT_MS', 60000),
      flushMs: int('CFLEX_PORTAL_FLUSH_MS', 5000),
      inventoryMs: int('CFLEX_PORTAL_INVENTORY_MS', 5 * 60000),
    },
    // Local notification goes out from here (Q-2026-10-25-10 (A), v3 FW-8):
    // SMTP to the relay directly, Teams/ServiceNow through HAEA's proxy.
    notify: {
      proxy: env('HTTPS_PROXY', env('https_proxy', null)),
      noProxy: env('NO_PROXY', env('no_proxy', null)),
      caPath: env('CONSOLE_PROXY_CA', null),
      // A Collector re-sending events after the console was down: older than
      // this, they are stored but nobody is paged (the Portal has them).
      replayMaxMs: int('CONSOLE_NOTIFY_REPLAY_MAX_S', 900) * 1000,
    },
  };
}

module.exports = { load };
