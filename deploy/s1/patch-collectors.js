#!/usr/bin/env node
// Wire the new collectors into the running API. Idempotent: every edit is
// marker-guarded, so re-running changes nothing.
//
//   sudo node deploy/s1/patch-collectors.js [--app /opt/cflex-v2/cflex-api] [--dry]
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
  if (!DRY) { fs.copyFileSync(p, `${p}.bak.${STAMP}`); fs.writeFileSync(p, out); }
  edits.push(`+ ${file}: patched (${marker})`);
}

// ── 1. the non-UPS inventory the probe collects ───────────────────
edit('src/routes/probe.routes.js', 'collectors:objects-feed', (s) => {
  const anchor = `// ── GET /v1/probe/devices ─────────────────────────────────────────`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `// collectors:objects-feed
// ── GET /v1/probe/objects ─────────────────────────────────────────
// Everything that is not a UPS: PDUs, NetBotz, CRACs, switches. Two feeds
// because they are two tables with two collectors — fms_devices for rack
// inventory, fms_racks for room furniture (CRACs and PDU cabinets have a
// position in the room, not a U in a rack).
//
// Only rows with polling_enabled=1 AND an address. A device with no IP is a
// survey entry, not something to go and ask.
router.get('/objects', probeAuth, (req, res) => {
  const tid = req.probe.tenant_id;
  const out = [];
  try {
    const devs = db.prepare(\`SELECT id, label AS name, kind, cbu, location, room, rack, ip, model, vendor,
                                    protocol, pdu_type, snmp_version, snmp_community, snmp_port,
                                    snmp_v3_user, snmp_v3_auth_protocol, snmp_v3_auth_password,
                                    snmp_v3_priv_protocol, snmp_v3_priv_password, attrs
                             FROM fms_devices
                             WHERE tenant_id=? AND polling_enabled=1 AND decommissioned_at IS NULL
                               AND ip IS NOT NULL AND ip NOT IN ('','0.0.0.0')
                             ORDER BY id\`).all(tid);
    for (const d of devs) {
      let attrs = null;
      try { attrs = d.attrs ? JSON.parse(d.attrs) : null; } catch { attrs = null; }
      out.push({ ...d, subject_type: 'device', attrs: { ...(attrs || {}), pdu_type: d.pdu_type, protocol: d.protocol } });
    }
  } catch (e) { console.error('[probe/objects] devices:', e.message); }

  try {
    const objs = db.prepare(\`SELECT r.id, r.name, r.kind, r.ip, r.protocol, r.snmp_version, r.snmp_community,
                                    r.snmp_port, r.snmp_v3_user, r.snmp_v3_auth_protocol, r.snmp_v3_auth_password,
                                    r.snmp_v3_priv_protocol, r.snmp_v3_priv_password, r.attrs,
                                    m.cbu, m.location, m.name AS room
                             FROM fms_racks r JOIN fms_rooms m ON m.id = r.room_id
                             WHERE r.tenant_id=? AND r.polling_enabled=1
                               AND r.ip IS NOT NULL AND r.ip NOT IN ('','0.0.0.0')
                             ORDER BY r.id\`).all(tid);
    for (const o of objs) {
      let attrs = null;
      try { attrs = o.attrs ? JSON.parse(o.attrs) : null; } catch { attrs = null; }
      out.push({ ...o, subject_type: 'object', object_name: o.name,
        attrs: { ...(attrs || {}), protocol: o.protocol } });
    }
  } catch (e) { console.error('[probe/objects] racks:', e.message); }

  res.json({ ok: true, count: out.length, devices: out });
});

${anchor}`);
});

// ── 2. accept the metrics event ───────────────────────────────────
edit('src/routes/probe.routes.js', 'collectors:metrics-event', (s) => {
  const anchor = `    // Unknown kind — accept silently
    console.log('[probe/event] unknown kind:', kind);`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `    // collectors:metrics-event
    // Narrow readings from the PDU / NetBotz / network / CRAC collectors. Each
    // one carries its own unit, raw integer, OID and confidence, and a row
    // with no source is refused by the service rather than stored as something
    // a screen would read as measured.
    if (kind === 'metrics') {
      const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
      if (!metrics.length) return res.json({ ok: true, recorded: 'metrics', written: 0 });
      const isObject = payload.object_name != null;
      const subject = isObject
        ? { type: 'object', name: payload.object_name, tenant_id: probe.tenant_id, cbu: payload.cbu || null }
        : { type: 'device', id: payload.device_id, tenant_id: probe.tenant_id, cbu: payload.cbu || null,
            name: payload.device_name || null };
      let r;
      try {
        r = require('../services/fms-metrics').record(db, subject, metrics, {
          ts: payload.ts, probe_id: probe.probe_uuid, notes: payload.notes || null,
        });
      } catch (e) {
        console.error('[probe/event] metrics:', e.message);
        return res.status(400).json({ error: e.message });
      }
      // A successful read stamps last_ok_polled, which is the column "fresh
      // within 5 minutes" can actually be answered from — last_polled is
      // written on failure too.
      const now = Date.now();
      try {
        if (isObject) {
          db.prepare('UPDATE fms_racks SET last_polled=?, last_ok_polled=?, consecutive_fails=0, poll_error=NULL WHERE tenant_id=? AND name=?')
            .run(now, now, probe.tenant_id, payload.object_name);
        } else if (payload.device_id != null) {
          db.prepare('UPDATE fms_devices SET last_polled=?, last_ok_polled=?, consecutive_fails=0, poll_error=NULL WHERE tenant_id=? AND id=?')
            .run(now, now, probe.tenant_id, payload.device_id);
        }
      } catch (e) { console.error('[probe/event] stamp:', e.message); }
      if (r.rejected.length) console.warn('[probe/event] rejected:', JSON.stringify(r.rejected.slice(0, 5)));
      return res.json({ ok: true, recorded: 'metrics', written: r.written, rejected: r.rejected.length });
    }

${anchor}`);
});

// ── 3. the screens read it back, with provenance ──────────────────
edit('src/routes/fms.routes.js', 'collectors:metrics-routes', (s) => {
  const anchor = `// probe-health:route`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `// collectors:metrics-routes
// Item 6's contract: every number comes back with where it came from and when.
// /object/:name is the brief's own verification method for item 5 — a live
// metrics array with no mock behind it.
router.get('/object/:name', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  try {
    const M = require('../services/fms-metrics');
    const obj = db.prepare(\`SELECT r.id, r.name, r.kind, r.ip, r.protocol, r.attrs, r.polling_enabled,
                                   r.last_polled, r.last_ok_polled, r.poll_error,
                                   m.cbu, m.location, m.name AS room
                            FROM fms_racks r JOIN fms_rooms m ON m.id=r.room_id
                            WHERE r.tenant_id=? AND r.name=?\`).get(tid, req.params.name);
    const metrics = M.latest(db, { tenantId: tid, type: 'object', name: req.params.name });
    if (!obj && !metrics.length) return res.status(404).json({ error: 'not found' });
    let attrs = null;
    try { attrs = obj?.attrs ? JSON.parse(obj.attrs) : null; } catch { attrs = null; }
    res.json({ ok: true, object: obj ? { ...obj, attrs } : { name: req.params.name }, metrics, count: metrics.length });
  } catch (e) { console.error('[fms.object]', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/devices/:id/metrics', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const id = parseInt(String(req.params.id).replace(/^fd-/i, ''), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad device id' });
  try {
    const M = require('../services/fms-metrics');
    const metrics = M.latest(db, { tenantId: tid, type: 'device', id });
    const series = req.query.metric
      ? M.series(db, { tenantId: tid, type: 'device', id, metric: String(req.query.metric),
          label: req.query.label ? String(req.query.label) : null,
          sinceMs: (parseInt(req.query.hours, 10) || 24) * 3600 * 1000 })
      : undefined;
    res.json({ ok: true, count: metrics.length, metrics, series });
  } catch (e) { console.error('[fms.device.metrics]', e.message); res.status(500).json({ error: e.message }); }
});

${anchor}`);
});

// ── 4. retention for the new table ────────────────────────────────
edit('src/server.js', 'collectors:metrics-retention', (s) => {
  const anchor = `// probe-health:sweep`;
  if (!s.includes(anchor)) return s;
  return s.replace(anchor, `// collectors:metrics-retention — fms_metrics grows by a few thousand rows an
// hour once the collectors are live; ups_metrics already has a 7-day prune and
// this is the same idea with a longer window, because capacity planning wants a
// month.
(() => {
  const M = require("./services/fms-metrics");
  const db3 = require("./config/database");
  const run = () => {
    try {
      const r = M.prune(db3, { keepDays: parseInt(process.env.FMS_METRICS_KEEP_DAYS, 10) || 30 });
      if (r.deleted) console.log("[fms-metrics] pruned", r.deleted, "rows");
    } catch (e) { console.error("[fms-metrics] prune:", e.message); }
  };
  setInterval(run, 6 * 3600 * 1000).unref?.();
  setTimeout(run, 120000).unref?.();
})();

${anchor}`);
});

console.log(edits.join('\n'));
console.log(DRY ? '\n(dry run — nothing written)' : `\nbackups: *.bak.${STAMP}`);
