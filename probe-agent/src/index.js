// index.js — cflex-probe main entry
// Responsibilities:
//   1. Fetch device config from cflex on boot + periodically (config sync)
//   2. Poll all UPS devices on POLL_INTERVAL_MS schedule
//   3. Forward telemetry + alerts to cflex
//   4. Drain local buffer when cflex reachable
//   5. Send heartbeat every HEARTBEAT_INTERVAL_MS
//   6. Purge old buffered events daily
const cfg = require('./config');
const buffer = require('./buffer');
const forwarder = require('./forwarder');
const upsPoller = require('./pollers/ups');

let devices = [];
let polling = false;

async function loadDevices() {
  const remote = await forwarder.fetchDeviceConfig();
  if (remote && remote.length) {
    devices = remote;
    console.log(`[probe] loaded ${devices.length} devices from cflex`);
  } else if (!devices.length) {
    console.log('[probe] no devices from cflex yet — polling disabled');
  }
}

// The last cycle's outcome, sent with every heartbeat so the cloud can tell a
// collector that is working from one that is merely running.
let lastCycle = { ok: 0, fail: 0, took: null, error: null, at: null };

/**
 * One poll cycle, with bounded concurrency.
 *
 * It used to be a serial for-await. With 41 devices and a 3 s SNMP timeout
 * retried twice, an unreachable fleet took 420 s per cycle against a 60 s
 * interval — so every tick logged "skip, previous cycle still running", and no
 * device could ever satisfy the cloud's 5-minute freshness gate even once the
 * network was fixed. Eight at a time brings the same fleet to about 50 s.
 */
async function pollAll() {
  if (polling) { console.log('[probe] skip — previous cycle still running'); return; }
  polling = true;
  const t0 = Date.now();
  let ok = 0, fail = 0, lastError = null;
  const queue = devices.slice();
  const worker = async () => {
    for (;;) {
      const d = queue.shift();
      if (!d) return;
      try {
        // pollDevice now reports its outcome. Counting "the call returned" as a
        // success is what made the agent log 41 ok / 0 fail while every device
        // had timed out.
        const r = await upsPoller.pollDevice(d);
        if (r && r.ok === false) { fail++; lastError = r.error || lastError; }
        else ok++;
      } catch (e) {
        console.error('[probe]', d.name, 'poll error:', e.message);
        fail++; lastError = e.message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.pollConcurrency, Math.max(1, queue.length)) }, worker));
  const took = Date.now() - t0;
  lastCycle = { ok, fail, took, error: lastError, at: Date.now() };
  console.log(`[probe] cycle: ${ok} ok, ${fail} fail, ${took}ms`);
  if (took > cfg.pollIntervalMs) {
    console.warn(`[probe] cycle (${took}ms) exceeded the poll interval (${cfg.pollIntervalMs}ms) — raise POLL_CONCURRENCY or lower SNMP_TIMEOUT_MS`);
  }
  polling = false;
}

async function bootstrap() {
  console.log(`[probe] starting cflex-probe v${require('../package.json').version}`);
  console.log(`[probe] tenant=${cfg.tenantId} probe_id=${cfg.probeId}`);
  console.log(`[probe] cflex=${cfg.cflexUrl}`);

  await loadDevices();

  // Reload device config every 5 minutes
  setInterval(loadDevices, 5 * 60 * 1000);

  // Poll cycle
  setInterval(pollAll, cfg.pollIntervalMs);
  // First cycle after 5 seconds (let device config settle)
  setTimeout(pollAll, 5000);

  // Heartbeat
  const beat = (extra = {}) => forwarder.heartbeat({
    devices_count: devices.length,
    // The cloud records these in probe_status: a probe that is up and failing
    // every device is not 'online', and nothing could say so before.
    devices: devices.length,
    poll_ok: lastCycle.ok, poll_fail: lastCycle.fail,
    cycle_ms: lastCycle.took, last_error: lastCycle.error,
    ...extra,
  });
  setInterval(() => beat(), cfg.heartbeatIntervalMs);
  beat({ boot: true, devices_count: 0, devices: 0 });

  // Drain buffer every 30s
  setInterval(async () => {
    const r = await forwarder.drain();
    if (r.drained > 0) console.log(`[probe] drained ${r.drained} buffered events`);
  }, 30000);

  // Daily retention purge
  setInterval(() => {
    const removed = buffer.purgeOld();
    if (removed > 0) console.log(`[probe] purged ${removed} buffered events older than ${cfg.bufferRetentionDays}d`);
  }, 24 * 3600 * 1000);
}

process.on('SIGTERM', () => { console.log('[probe] SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[probe] SIGINT received, exiting');  process.exit(0); });
process.on('uncaughtException', (e) => { console.error('[probe] uncaught:', e); });
process.on('unhandledRejection', (e) => { console.error('[probe] unhandled rejection:', e); });

bootstrap().catch((e) => { console.error('[probe] fatal bootstrap:', e); process.exit(1); });
