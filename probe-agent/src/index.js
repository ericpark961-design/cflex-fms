// index.js — cflex-probe main entry
// Responsibilities:
//   1. Fetch device config (this collector's sites) from the Local Console on boot + periodically
//   2. Poll all UPS devices on POLL_INTERVAL_MS schedule
//   3. Forward telemetry + alarm events to the Local Console — the only destination;
//      the FMS merges collectors and sends to the Portal (D-13, WO-INT-012)
//   4. Drain local buffer when the console is reachable
//   5. Send heartbeat every HEARTBEAT_INTERVAL_MS
//   6. Purge old buffered events daily
//   7. Receive SNMP traps (UDP CFLEX_TRAP_PORT) into the same alarm engine
const cfg = require('./config');
const buffer = require('./buffer');
const forwarder = require('./forwarder');
const upsPoller = require('./pollers/ups');
const collectors = require('./pollers');
const health = require('./health');
const { createTrapHandler } = require('./trap/handler');
const { createTrapListener } = require('./trap/listener');

let devices = [];
let objects = [];
let polling = false;
let traps = null;

async function loadDevices() {
  const remote = await forwarder.fetchDeviceConfig();
  // The Local Console's answer is the inventory, even when it is empty (every
  // device removed or polling disabled). null = unreachable: keep the last list.
  const fromConsole = forwarder.consoleConfigured();
  if (remote && fromConsole) {
    devices = remote;
    console.log(`[probe] loaded ${devices.length} UPS from the Local Console`);
  } else if (!devices.length) {
    console.log(`[probe] no devices from ${fromConsole ? 'the Local Console' : 'anywhere (no CFLEX_CONSOLE_URL)'} yet — polling disabled`);
  }
  // The rest of the room: PDUs, NetBotz, CRACs, switches. A separate feed
  // because they live in a separate table and have separate collectors; a
  // server with neither endpoint simply has none of them.
  const net = await forwarder.fetchObjectConfig();
  if (net && net.length) {
    objects = net;
    const byKind = {};
    for (const d of objects) byKind[d.kind || '?'] = (byKind[d.kind || '?'] || 0) + 1;
    console.log(`[probe] loaded ${objects.length} objects —`,
      Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(' '));
  }
  // The trap listener knows senders by these rows, and accepts their credentials.
  if (traps) traps.setInventory([...devices.map(d => ({ kind: 'ups', ...d })), ...objects]);
  // The ledger for the contract device_id. The FMS sends the inventory to the Portal (D-13).
  await forwarder.syncInventory([...devices.map(d => ({ kind: 'ups', ...d })), ...objects]);
}

// The last cycle's outcome, sent with every heartbeat so the FMS (and through
// it the Portal) can tell a collector that is working from one that is merely running.
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
  let ok = 0, fail = 0, lastError = null, metricsSent = 0, skipped = 0, unsupported = 0;
  // One queue, both feeds: a UPS keeps its own path (it evaluates thresholds
  // and writes ups_metrics), everything else goes through the collector
  // registry and reports narrow metrics.
  const queue = [...devices.map(d => ({ d, ups: true })), ...objects.map(d => ({ d, ups: false }))];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const { d, ups } = item;
      try {
        if (ups) {
          // pollDevice now reports its outcome. Counting "the call returned" as
          // a success is what made the agent log 41 ok / 0 fail while every
          // device had timed out.
          const r = await upsPoller.pollDevice(d);
          if (r && r.ok === false) { fail++; lastError = r.error || lastError; }
          else ok++;
          continue;
        }
        const r = await collectors.pollOne(d, {
          timeoutMs: cfg.snmp.timeoutMs, retries: cfg.snmp.retries,
        });
        if (r.skipped) { skipped++; continue; }
        if (r.unsupported) { unsupported++; lastError = r.error || lastError; continue; }
        if (r.ok && r.metrics.length) {
          await forwarder.sendEvent('metrics', {
            device_id: d.id, device_name: d.name, object_name: d.object_name || null,
            kind: d.kind, ts: Date.now(), metrics: r.metrics, notes: r.notes || null,
          });
          metricsSent += r.metrics.length;
          ok++;
        } else {
          fail++; lastError = r.error || lastError;
          await forwarder.sendEvent('telemetry', {
            device_id: d.id, device_name: d.name, kind: d.kind,
            ts: Date.now(), ok: false, error: r.error || 'no readings',
          });
        }
      } catch (e) {
        console.error('[probe]', d.name, 'poll error:', e.message);
        fail++; lastError = e.message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.pollConcurrency, Math.max(1, queue.length)) }, worker));
  const took = Date.now() - t0;
  lastCycle = { ok, fail, took, error: lastError, at: Date.now(), metrics: metricsSent, skipped, unsupported };
  health.mark(lastCycle);
  console.log(`[probe] cycle: ${ok} ok, ${fail} fail, ${took}ms` +
    (metricsSent ? `, ${metricsSent} metrics` : '') +
    (skipped ? `, ${skipped} skipped` : '') +
    (unsupported ? `, ${unsupported} unsupported` : ''));
  if (took > cfg.pollIntervalMs) {
    console.warn(`[probe] cycle (${took}ms) exceeded the poll interval (${cfg.pollIntervalMs}ms) — raise POLL_CONCURRENCY or lower SNMP_TIMEOUT_MS`);
  }
  polling = false;
}

async function bootstrap() {
  console.log(`[probe] starting cflex-probe v${require('../package.json').version}`);
  console.log(`[probe] tenant=${cfg.tenantId} node=${cfg.node.nodeId} sites=${cfg.node.sites.join(',') || '*'}`);
  console.log(`[probe] console=${cfg.console.url || '(not set)'}`);

  // Traps go into the forwarder's alarm engine, so a trap and a poll seeing
  // the same fault are one alarm (same alarm_id), and out the same way.
  if (cfg.trap.enabled) {
    const handler = createTrapHandler({
      engine: forwarder.alarms(), emit: (items) => forwarder.emitAlarms(items), defaultCommunity: cfg.snmp.community,
    });
    traps = createTrapListener({ handler, port: cfg.trap.port, bind: cfg.trap.bind, defaultCommunity: cfg.snmp.community }).start();
  } else {
    console.log('[probe] trap listener off (CFLEX_TRAP_ENABLED=0)');
  }

  await loadDevices();

  // Reload device config (and the console's thresholds and maintenance windows), every 5 minutes by default
  setInterval(loadDevices, cfg.configReloadMs);

  // Poll cycle
  setInterval(pollAll, cfg.pollIntervalMs);
  // First cycle after 5 seconds (let device config settle)
  setTimeout(pollAll, 5000);

  // Heartbeat to the FMS (relayed to the Portal, contract §3.1). A probe that
  // is up and failing every device is not healthy, so the last cycle's
  // outcome rides along as an ok ratio.
  const beat = () => {
    const tried = lastCycle.ok + lastCycle.fail;
    return forwarder.heartbeat({
      devices_total: devices.length + objects.length,
      devices_unreachable: lastCycle.fail,
      last_poll_ok_ratio: tried ? Math.round((lastCycle.ok / tried) * 1000) / 1000 : null,
    });
  };
  setInterval(() => beat(), cfg.heartbeatIntervalMs);
  beat();

  // Telemetry batch to the FMS (contract §3.3 shape) — the console client also cuts one at 500 points.
  setInterval(() => forwarder.flushTelemetry(), cfg.telemetryFlushMs);

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
