// /v1/probe/* — Probe-facing API. Probe agents authenticate with X-Probe-Key header.
// Cloud users authenticate with normal JWT for management endpoints.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const alarmNotifier = require('../services/alarm-notifier');

router.use(express.json({ limit: '10mb' }));

const isAdminLike = (role) => ['super_admin', 'admin', 'engineer', 'si_operator'].includes(role);

// ── Probe-only auth middleware (X-Probe-Key) ─────────────────────
async function probeAuth(req, res, next) {
  const key = req.headers['x-probe-key'];
  if (!key) return res.status(401).json({ error: 'X-Probe-Key required' });
  // Optimization: lookup by prefix first (first 8 chars)
  const prefix = String(key).slice(0, 8);
  const candidates = db.prepare(`SELECT id, probe_uuid, label, tenant_id, status, api_key_hash FROM probes WHERE api_key_prefix = ?`).all(prefix);
  for (const p of candidates) {
    if (p.status === 'disabled') continue;
    try {
      if (await bcrypt.compare(key, p.api_key_hash)) {
        req.probe = p;
        return next();
      }
    } catch (_) {}
  }
  return res.status(401).json({ error: 'invalid probe key' });
}

// ── PROBE-FACING ENDPOINTS ───────────────────────────────────────

// Heartbeat — probe pings every 30s with status info
router.post('/heartbeat', probeAuth, (req, res) => {
  const { version, os, capabilities } = req.body || {};
  const ip = req.ip || req.connection?.remoteAddress;
  db.prepare(`UPDATE probes SET status='online', last_seen_at=?, last_ip=?, version=COALESCE(?,version), os=COALESCE(?,os), capabilities=COALESCE(?,capabilities) WHERE id=?`)
    .run(Date.now(), ip, version || null, os || null, capabilities ? JSON.stringify(capabilities) : null, req.probe.id);
  res.json({ ok: true, probe_uuid: req.probe.probe_uuid });
});

// Long-poll for next job (returns immediately if available)
router.get('/jobs/next', probeAuth, (req, res) => {
  // Atomic claim: pick oldest queued job, mark claimed
  const job = db.prepare(`SELECT * FROM probe_jobs WHERE probe_id = ? AND status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 1`).get(req.probe.id);
  if (!job) return res.json({ ok: true, job: null });
  db.prepare(`UPDATE probe_jobs SET status='claimed', claimed_at=? WHERE id=? AND status='queued'`).run(Date.now(), job.id);
  res.json({
    ok: true,
    job: {
      job_uuid: job.job_uuid,
      type: job.type,
      payload: job.payload ? JSON.parse(job.payload) : null,
      priority: job.priority,
      created_at: job.created_at,
    },
  });
});

// Probe submits result for a job
router.post('/jobs/:jobUuid/result', probeAuth, (req, res) => {
  const { jobUuid } = req.params;
  const { ok, result, error } = req.body || {};
  const job = db.prepare(`SELECT * FROM probe_jobs WHERE job_uuid = ? AND probe_id = ?`).get(jobUuid, req.probe.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!['claimed', 'running'].includes(job.status)) return res.status(409).json({ error: 'job not claimed' });

  db.prepare(`UPDATE probe_jobs SET status=?, result=?, error=?, completed_at=? WHERE id=?`)
    .run(ok === false || error ? 'error' : 'done',
         result != null ? JSON.stringify(result) : null,
         error || null, Date.now(), job.id);

  // Side-effects based on job type
  if (ok && result) {
    try {
      if (job.type === 'snmp_scan_cidr' && job.related_scan_id) {
        const candidates = (result.candidates || []).filter(c => c && c.is_ups);
        db.prepare(`UPDATE ups_discovery_scans SET status='done', total_ips=?, scanned=?, responsive=?, candidates=?, completed_at=? WHERE scan_id=?`)
          .run(result.total || 0, result.scanned || 0, result.responsive || 0, JSON.stringify(candidates), Date.now(), job.related_scan_id);
      } else if (job.type === 'snmp_verify_device' && job.related_device_id) {
        const m = result.metrics || {};
        db.prepare(`UPDATE ups_devices SET battery_pct=?, load_pct=?, temp_c=?, runtime_min=?, status=?, health_score=?, last_polled=?, poll_error=NULL, consecutive_fails=0, updated_at=? WHERE id=?`)
          .run(m.battery_pct ?? null, m.load_pct ?? null, m.temp_c ?? null, m.runtime_min ?? null,
               m.status || 'online', m.health_score ?? null, Date.now(), Date.now(), job.related_device_id);
      } else if (job.type === 'snmp_poll_device' && job.related_device_id) {
        const m = result.metrics || {};
        db.prepare(`UPDATE ups_devices SET battery_pct=?, load_pct=?, temp_c=?, runtime_min=?, status=?, health_score=?, last_polled=?, updated_at=? WHERE id=?`)
          .run(m.battery_pct ?? null, m.load_pct ?? null, m.temp_c ?? null, m.runtime_min ?? null,
               m.status || 'online', m.health_score ?? null, Date.now(), Date.now(), job.related_device_id);
        // Time-series row
        if (m.battery_pct != null) {
          db.prepare(`INSERT INTO ups_metrics (device_id, ts, battery_pct, load_pct, temp_c, runtime_min) VALUES (?,?,?,?,?,?)`)
            .run(job.related_device_id, Date.now(), m.battery_pct, m.load_pct ?? null, m.temp_c ?? null, m.runtime_min ?? null);
        }
      }
    } catch (e) { console.error('[probe.result side-effect]', e); }
  } else if (error && job.type === 'snmp_scan_cidr' && job.related_scan_id) {
    db.prepare(`UPDATE ups_discovery_scans SET status='error', error=?, completed_at=? WHERE scan_id=?`)
      .run(error, Date.now(), job.related_scan_id);
  }

  res.json({ ok: true });
});

// Probe progress update during long jobs (optional)
router.post('/jobs/:jobUuid/progress', probeAuth, (req, res) => {
  const { jobUuid } = req.params;
  const { scanned, responsive, total } = req.body || {};
  const job = db.prepare(`SELECT id, related_scan_id FROM probe_jobs WHERE job_uuid = ? AND probe_id = ?`).get(jobUuid, req.probe.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  db.prepare(`UPDATE probe_jobs SET status='running' WHERE id = ?`).run(job.id);
  if (job.related_scan_id) {
    db.prepare(`UPDATE ups_discovery_scans SET scanned=?, responsive=?, total_ips=COALESCE(?,total_ips) WHERE scan_id = ?`)
      .run(scanned || 0, responsive || 0, total || null, job.related_scan_id);
  }
  res.json({ ok: true });
});

// ── ADMIN ENDPOINTS (require JWT) ────────────────────────────────

// List probes (super/admin)
router.get('/list', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  if (!isAdminLike(req.user.role)) return res.status(403).json({ error: 'admin required' });
  const rows = db.prepare(`SELECT id, probe_uuid, tenant_id, label, site, status, version, os, capabilities, last_seen_at, last_ip, created_at, enrolled_at, api_key_prefix FROM probes ORDER BY status='online' DESC, last_seen_at DESC`).all();
  // Job counts
  const jobs = db.prepare(`SELECT probe_id, status, COUNT(*) AS n FROM probe_jobs GROUP BY probe_id, status`).all();
  const jobMap = {};
  jobs.forEach(j => { if (!jobMap[j.probe_id]) jobMap[j.probe_id] = {}; jobMap[j.probe_id][j.status] = j.n; });
  res.json({
    ok: true,
    probes: rows.map(r => ({
      ...r,
      capabilities: (() => { try { return r.capabilities ? JSON.parse(r.capabilities) : null; } catch (_) { return null; } })(),
      job_counts: jobMap[r.id] || {},
    })),
  });
});

// Create new probe (returns one-time API key shown only once)
router.post('/create', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  if (!isAdminLike(req.user.role)) return res.status(403).json({ error: 'admin required' });
  const { tenant_id, label, site } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label required' });

  const probeUuid = 'p_' + crypto.randomBytes(8).toString('hex');
  const apiKey = 'pk_' + crypto.randomBytes(32).toString('hex'); // 66 chars
  const apiKeyHash = await bcrypt.hash(apiKey, 10);
  const apiKeyPrefix = apiKey.slice(0, 8);
  const enrollmentToken = crypto.randomBytes(16).toString('hex');
  const enrollExpires = Date.now() + 24 * 60 * 60 * 1000;

  const r = db.prepare(`INSERT INTO probes (probe_uuid, tenant_id, label, site, api_key_hash, api_key_prefix, status, created_at, created_by, enrollment_token, enrollment_expires) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(probeUuid, tenant_id || null, label, site || null, apiKeyHash, apiKeyPrefix, 'pending', Date.now(), req.user.email, enrollmentToken, enrollExpires);

  res.json({
    ok: true,
    probe: { id: r.lastInsertRowid, probe_uuid: probeUuid, label, site, status: 'pending' },
    api_key: apiKey,                  // shown ONCE
    enrollment_token: enrollmentToken, // alternative bootstrap
    install_command: `curl -fsSL https://cflex.runless.co.uk/probe/install.sh | PROBE_KEY=${apiKey} bash`,
  });
});

router.post('/:id/disable', (req, res) => {
  if (!req.user || !isAdminLike(req.user.role)) return res.status(403).json({ error: 'admin required' });
  db.prepare(`UPDATE probes SET status='disabled' WHERE id = ?`).run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.post('/:id/enable', (req, res) => {
  if (!req.user || !isAdminLike(req.user.role)) return res.status(403).json({ error: 'admin required' });
  db.prepare(`UPDATE probes SET status='pending' WHERE id = ? AND status='disabled'`).run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => {
  if (!req.user || !isAdminLike(req.user.role)) return res.status(403).json({ error: 'admin required' });
  db.prepare(`DELETE FROM probes WHERE id = ?`).run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.get('/:id/jobs', (req, res) => {
  if (!req.user || !isAdminLike(req.user.role)) return res.status(403).json({ error: 'admin required' });
  const rows = db.prepare(`SELECT id, job_uuid, type, status, priority, created_at, claimed_at, completed_at, error FROM probe_jobs WHERE probe_id = ? ORDER BY id DESC LIMIT 50`).all(parseInt(req.params.id, 10));
  res.json({ ok: true, jobs: rows });
});


// ── POST /v1/probe/event ──────────────────────────────────────────
// Telemetry + alerts from probe. body = { kind, payload }.
// Recognized kinds: 'telemetry', 'alert'. Anything else accepted and logged only.
router.post('/event', probeAuth, (req, res) => {
  try {
    const { kind, payload, buffered_ts } = req.body || {};
    if (!kind || !payload) return res.status(400).json({ error: 'kind + payload required' });
    const now = Date.now();
    const ts = payload.ts || buffered_ts || now;
    const probe = req.probe;

    if (kind === 'telemetry') {
      // payload: { device_id, device_name, kind: 'ups', ok, metrics, took_ms }
      const dev = db.prepare('SELECT id FROM ups_devices WHERE id = ? AND tenant_id = ?').get(payload.device_id, probe.tenant_id);
      if (!dev) return res.status(404).json({ error: 'device not found in tenant scope' });
      if (payload.ok === false) {
        const fails = (db.prepare('SELECT consecutive_fails FROM ups_devices WHERE id = ?').get(dev.id).consecutive_fails || 0) + 1;
        db.prepare('UPDATE ups_devices SET status=?, last_polled=?, poll_error=?, consecutive_fails=?, updated_at=? WHERE id=?')
          .run(fails >= 3 ? 'unreachable' : 'unknown', ts, payload.error || 'no metrics', fails, now, dev.id);
        return res.json({ ok: true, recorded: 'telemetry-fail' });
      }
      const m = payload.metrics || {};
      db.prepare(`UPDATE ups_devices SET
          battery_pct=?, load_pct=?, temp_c=?, runtime_min=?, output_v=?, input_v=?,
          output_status=?, battery_status=?, status=?, health_score=?,
          last_polled=?, poll_error=NULL, consecutive_fails=0,
          vendor=COALESCE(?, vendor), model=COALESCE(?, model), firmware=COALESCE(?, firmware),
          updated_at=?
          WHERE id=?`).run(
          m.battery_pct, m.load_pct, m.temp_c, m.runtime_min, m.output_v, m.input_v,
          m.output_source, m.battery_status, m.status, m.health_score,
          ts, m.manufacturer, m.model, m.firmware, now, dev.id);
      try {
        db.prepare(`INSERT INTO ups_metrics
            (device_id, ts, battery_pct, load_pct, temp_c, runtime_min, input_v, output_v, output_status, battery_status, health_score, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            dev.id, ts, m.battery_pct, m.load_pct, m.temp_c, m.runtime_min,
            m.input_v, m.output_v, m.output_source, m.battery_status, m.health_score, m.status);
      } catch (e) { console.warn('[probe/event] metrics insert:', e.message); }
      return res.json({ ok: true, recorded: 'telemetry' });
    }

    if (kind === 'alert') {
      // payload: { device_id, device_name, severity, metric, message, value, threshold, ts }
      // Dedup: skip if same device+metric+priority within last 10 minutes
      const dup = db.prepare("SELECT id FROM alerts WHERE tenant_id=? AND device_id=? AND metric=? AND priority=? AND received_at > ? ORDER BY id DESC LIMIT 1").get(probe.tenant_id, 'ups-' + payload.device_id, payload.metric || null, payload.severity || 'P3', Date.now() - 10*60*1000);
      if (dup) { return res.json({ ok: true, recorded: 'alert', deduped: true }); }
      const dev = db.prepare('SELECT id, label, site FROM ups_devices WHERE id = ? AND tenant_id = ?').get(payload.device_id, probe.tenant_id);
      db.prepare(`INSERT INTO alerts (tenant_id, device_id, site, priority, metric, message, value, threshold, received_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(
        probe.tenant_id, 'ups-' + payload.device_id, dev?.site || null,
        payload.severity || 'P3', payload.metric || null, payload.message || '',
        payload.value != null ? Number(payload.value) : null,
        payload.threshold != null ? Number(payload.threshold) : null,
        ts);
      // Auto-ticket on P1 (+ fire-and-forget AI RCA)
      let p1TicketId = null;
      if (payload.severity === 'P1') {
        try {
          const ticketNo = 'INC' + String(now).slice(-9);
          const r = db.prepare(`INSERT INTO tickets (tenant_id, ticket_no, site, device_id, device_label, priority, domain, title, description, alert_metric, alert_value, alert_threshold, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            probe.tenant_id, ticketNo, dev?.site || null,
            'ups-' + payload.device_id, dev?.label || payload.device_name || null,
            'P1', 'UPS',
            (payload.device_name || dev?.label || 'UPS') + ' — ' + (payload.message || payload.metric),
            payload.message || '',
            payload.metric || null,
            payload.value != null ? Number(payload.value) : null,
            payload.threshold != null ? Number(payload.threshold) : null,
            now, now);
          p1TicketId = r.lastInsertRowid;
        } catch (e) { console.warn('[probe/event] auto-ticket:', e.message); }
      }
      if (p1TicketId) {
        setImmediate(() => {
          try {
            require('../services/fms-rca').generateRcaForTicket(p1TicketId)
              .then(r => console.log('[fms-rca]', p1TicketId, r.ok ? 'OK' : ('SKIP/ERR ' + r.error)))
              .catch(e => console.error('[fms-rca]', e.message));
          } catch (e) { console.error('[fms-rca] hook:', e.message); }
        });
      }
      // Fire-and-forget notify
      setImmediate(() => {
        try {
          alarmNotifier.notify({
            id: 0,
            tenant_id: probe.tenant_id,
            device_id: 'ups-' + payload.device_id,
            priority: payload.severity || 'P3',
            metric: payload.metric,
            message: payload.message,
            value: payload.value,
            threshold: payload.threshold,
          }).catch(e => console.error('[notify]', e.message));
        } catch (e) { console.error('[notify-load]', e.message); }
      });
      return res.json({ ok: true, recorded: 'alert' });
    }

    // Unknown kind — accept silently
    console.log('[probe/event] unknown kind:', kind);
    return res.json({ ok: true, recorded: 'unknown' });
  } catch (e) {
    console.error('[probe/event]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /v1/probe/devices ─────────────────────────────────────────
// Returns devices the probe should poll. Tenant scope enforced via probe.tenant_id.
router.get('/devices', probeAuth, (req, res) => {
  const probe = req.probe;
  const rows = db.prepare(`SELECT id, label AS name, site, ip, snmp_community, snmp_port,
                                  snmp_version, oid_profile, polling_interval_sec, vendor, criticality, metadata
                           FROM ups_devices
                           WHERE tenant_id = ? AND polling_enabled = 1
                             AND (decommissioned_at IS NULL)
                           ORDER BY id`).all(probe.tenant_id);
  const devices = rows.map(r => ({
    id: r.id,
    name: r.name,
    site: r.site,
    ip: r.ip,
    community: r.snmp_community || 'public',
    port: r.snmp_port || 161,
    version: r.snmp_version || 'v2c',
    oid_profile: r.oid_profile || 'auto',
    vendor: r.vendor,
    poll_interval_sec: r.polling_interval_sec || 60,
    criticality: r.criticality,
  }));
  res.json({ ok: true, tenant_id: probe.tenant_id, count: devices.length, devices });
});

module.exports = router;
