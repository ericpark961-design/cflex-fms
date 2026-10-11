// forwarder.js — outbound HTTPS to cflex with retry + local buffer fallback
const axios = require('axios');
const cfg = require('./config');
const buffer = require('./buffer');

const http = axios.create({
  baseURL: cfg.cflexUrl,
  timeout: 15000,
  headers: {
    'X-Probe-Key': cfg.cflexToken,
    'X-Probe-Id': cfg.probeId,
    'X-Tenant-Id': cfg.tenantId,
    'Content-Type': 'application/json',
  },
});

let lastReachable = null;

async function sendEvent(kind, payload) {
  if (!cfg.cflexToken) {
    buffer.enqueue(kind, payload);
    return { ok: false, buffered: true };
  }
  try {
    const r = await http.post('/v1/probe/event', { kind, payload });
    lastReachable = Date.now();
    return { ok: true, data: r.data };
  } catch (e) {
    buffer.enqueue(kind, payload);
    return { ok: false, buffered: true, error: e.message };
  }
}

async function drain(maxBatch = 50) {
  const rows = buffer.dequeue(maxBatch);
  if (!rows.length) return { drained: 0 };
  const okIds = [];
  for (const row of rows) {
    try {
      await http.post('/v1/probe/event', {
        kind: row.kind,
        payload: JSON.parse(row.payload),
        buffered_ts: row.ts,
      });
      okIds.push(row.id);
      lastReachable = Date.now();
    } catch (e) {
      buffer.fail(row.id, e.message);
      // stop on first failure to avoid hammering during outage
      break;
    }
  }
  buffer.ack(okIds);
  return { drained: okIds.length, total: rows.length };
}

async function heartbeat(extra = {}) {
  if (!cfg.cflexToken) return { ok: false };
  try {
    const r = await http.post('/v1/probe/heartbeat', {
      probe_id: cfg.probeId,
      tenant_id: cfg.tenantId,
      version: require('../package.json').version,
      buffer_stats: buffer.stats(),
      ts: Date.now(),
      ...extra,
    });
    lastReachable = Date.now();
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The non-UPS inventory: PDUs, NetBotz, CRACs, switches.
 *
 * A separate call because they live in a separate table with separate
 * collectors. A server that does not have this endpoint yet answers 404, and
 * the agent carries on with the UPS feed alone rather than treating the whole
 * load as failed.
 */
async function fetchObjectConfig() {
  if (!cfg.cflexToken) return [];
  try {
    const r = await http.get(`/v1/probe/objects?tenant=${cfg.tenantId}`);
    return r.data?.devices || [];
  } catch (e) {
    if (e.response?.status === 404) return [];           // server predates this feed
    console.error('[forwarder] fetchObjectConfig failed:', e.message);
    return [];
  }
}

async function fetchDeviceConfig() {
  if (!cfg.cflexToken) return [];
  try {
    const r = await http.get(`/v1/probe/devices?tenant=${cfg.tenantId}`);
    return r.data?.devices || [];
  } catch (e) {
    console.error('[forwarder] fetchDeviceConfig failed:', e.message);
    return [];
  }
}

module.exports = { sendEvent, drain, heartbeat, fetchDeviceConfig, fetchObjectConfig, lastReachable: () => lastReachable };
