#!/usr/bin/env node
// Wire probe health into the running API. Idempotent: every edit is guarded by
// a marker, so re-running it changes nothing.
//
//   sudo -u cflex node deploy/s1/patch-probe-health.js [--app /opt/cflex-v2/cflex-api] [--dry]
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP = arg('--app', '/opt/cflex-v2/cflex-api');
const DRY = argv.includes('--dry');
const STAMP = Date.now();

const edits = [];
function edit(file, marker, apply) {
  const p = path.join(APP, file);
  const src = fs.readFileSync(p, 'utf8');
  if (src.includes(marker)) { edits.push(`= ${file}: already patched (${marker})`); return; }
  const out = apply(src);
  if (out === src) throw new Error(`${file}: anchor not found for ${marker}`);
  if (!DRY) {
    fs.copyFileSync(p, `${p}.bak.${STAMP}`);
    fs.writeFileSync(p, out);
  }
  edits.push(`+ ${file}: patched (${marker})`);
}

// ── 1. the probe heartbeat records health, not just liveness ──────
edit('src/routes/probe.routes.js', 'probe-health:heartbeat', (s) => {
  const anchor = `router.post('/heartbeat', probeAuth, (req, res) => {
  const { version, os, capabilities } = req.body || {};`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `router.post('/heartbeat', probeAuth, (req, res) => {
  const { version, os, capabilities } = req.body || {};
  // probe-health:heartbeat — the row in \`probes\` says the agent is alive. It
  // says nothing about whether the polling it is doing works, which is the
  // question an operator is actually asking, so the cycle counters go to
  // probe_status beside it.
  try {
    const b = req.body || {};
    require('../services/fms-probe-health').heartbeat(db, {
      probe_id: req.probe.probe_uuid,
      tenant_id: req.probe.tenant_id,
      cbu: b.cbu || null,
      label: req.probe.label,
      version: version || null,
      host: req.ip || req.connection?.remoteAddress || null,
      poll_ok: b.poll_ok, poll_fail: b.poll_fail,
      // The agent has always sent devices_count; `devices` is the newer name.
      // Reading only one of them pinned the count at 0 for every live probe.
      devices: b.devices ?? b.devices_count,
      cycle_ms: b.cycle_ms, last_error: b.last_error ?? null,
    });
  } catch (e) { console.error('[probe-health] heartbeat:', e.message); }`);
});

// ── 2. the in-process poller reports its own cycle ────────────────
// This is the collector that died for six weeks. If it does not report, the
// one alarm that would have caught that still does not exist.
edit('src/services/ups-poller.js', 'probe-health:cycle', (s) => {
  const anchor = `async function pollAllUpsDevices() {
  const devices = db.prepare("SELECT * FROM ups_devices WHERE polling_enabled IS NULL OR polling_enabled = 1").all();
  if (devices.length === 0) return;
`;
  if (!s.includes(anchor)) return s;
  let out = s.replace(anchor, `async function pollAllUpsDevices() {
  const devices = db.prepare("SELECT * FROM ups_devices WHERE polling_enabled IS NULL OR polling_enabled = 1").all();
  // probe-health:cycle — report the cycle even when there is nothing to poll,
  // because "no devices enabled" and "the poller is dead" look identical on
  // screen and are not the same problem.
  const _cyc = { t0: Date.now(), ok: 0, fail: 0, lastError: null };
  const _report = () => {
    try {
      require('./fms-probe-health').heartbeat(db, {
        probe_id: 'inproc', tenant_id: null, label: 'in-process UPS poller',
        version: process.env.npm_package_version || 'api',
        host: require('os').hostname(),
        poll_ok: _cyc.ok, poll_fail: _cyc.fail, devices: devices.length,
        cycle_ms: Date.now() - _cyc.t0, last_error: _cyc.lastError,
      });
    } catch (e) { logger.warn('[probe-health] cycle report: ' + e.message); }
  };
  if (devices.length === 0) { _report(); return; }
`);
  // success and failure both counted, and the success path stamps the column
  // that makes "fresh" mean "we have a reading", not "we tried".
  out = out.replace(`          status=?, health_score=?, last_polled=?, poll_error=NULL,`,
    `          status=?, health_score=?, last_polled=?, last_ok_polled=?, poll_error=NULL,`);
  out = out.replace(`          r.status, r.health_score, now,`,
    `          r.status, r.health_score, now, now,`);
  out = out.replace(`        logger.info(\`[ups-poller] \${dev.label} (\${dev.ip}): batt=`,
    `        _cyc.ok++;
        logger.info(\`[ups-poller] \${dev.label} (\${dev.ip}): batt=`);
  out = out.replace(`        logger.warn(\`[ups-poller] \${dev.label} (\${dev.ip}) FAILED (#\${fails}): \${r.error}\`);`,
    `        _cyc.fail++; _cyc.lastError = r.error || null;
        logger.warn(\`[ups-poller] \${dev.label} (\${dev.ip}) FAILED (#\${fails}): \${r.error}\`);`);
  out = out.replace(`    } catch (e) {
      logger.error(\`[ups-poller] \${dev.label} unexpected error: \${e.message}\`);
    }
  }
}`, `    } catch (e) {
      _cyc.fail++; _cyc.lastError = e.message;
      logger.error(\`[ups-poller] \${dev.label} unexpected error: \${e.message}\`);
    }
  }
  _report();
}`);
  return out;
});

// ── 3. the sweep, and the operator's view of it ───────────────────
edit('src/server.js', 'probe-health:sweep', (s) => {
  const anchor = `require("./services/local-probe-runner").start();`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `${anchor}
// probe-health:sweep — silence is an alarm. Every minute, any collector that
// has not reported for ten minutes gets one P2 incident; a heartbeat resolves
// it. Without this, a dead collector is indistinguishable from a healthy site.
(() => {
  const health = require("./services/fms-probe-health");
  const db2 = require("./config/database");
  const run = () => {
    try {
      const r = health.sweep(db2);
      if (r.raised.length) console.warn("[probe-health] raised:", JSON.stringify(r.raised));
    } catch (e) { console.error("[probe-health] sweep:", e.message); }
  };
  setInterval(run, health.SWEEP_MS).unref?.();
  setTimeout(run, 30000).unref?.();
})();`);
});

edit('src/routes/fms.routes.js', 'probe-health:route', (s) => {
  const anchor = `router.get('/devices', (req, res) => {`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `// probe-health:route — is this site being collected at all? A separate
// question from whether its devices are healthy, and the one nothing could
// answer before.
router.get('/probes', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  try {
    const probes = require('../services/fms-probe-health').list(db, tid);
    res.json({ ok: true, count: probes.length, probes });
  } catch (e) { console.error('[fms.probes]', e.message); res.status(500).json({ error: e.message }); }
});

${anchor}`);
});

console.log(edits.join('\n'));
console.log(DRY ? '\n(dry run — nothing written)' : `\nbackups: *.bak.${STAMP}`);
