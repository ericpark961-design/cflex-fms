// routes/fms-push.routes.js
// Mount under the SAME router base as fms.routes.js (i.e. /v1/fms).
// In your app bootstrap:
//   app.use('/v1/fms', require('./routes/fms.routes'));
//   app.use('/v1/fms', require('./routes/fms-push.routes'));
const express = require('express');
const router = express.Router();
const db = require('../config/database');

router.use(express.json({ limit: '64kb' }));

function tenantOf(req) {
  if (!req.user) return null;
  if (req.user.role === 'super_admin' || req.user.role === 'admin') {
    return req.body?.tenant_id ? parseInt(req.body.tenant_id, 10) : (req.user.tenantId || null);
  }
  return req.user.tenantId || null;
}

const VALID_PLATFORMS = new Set(['ios', 'android', 'web']);
const VALID_SEVERITIES = new Set(['ok', 'warn', 'critical', 'unreachable']);

// POST /v1/fms/devices/push-token — upsert subscription for this user.
router.post('/devices/push-token', (req, res) => {
  const tid = tenantOf(req);
  if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const uid = req.user?.id || req.user?.userId || null;
  const { expo_push_token, platform, device_name, app, min_severity } = req.body || {};

  if (!expo_push_token || typeof expo_push_token !== 'string' || expo_push_token.length < 10) {
    return res.status(400).json({ error: 'expo_push_token required' });
  }
  if (!expo_push_token.startsWith('ExponentPushToken[') && !expo_push_token.startsWith('ExpoPushToken[')) {
    return res.status(400).json({ error: 'invalid expo_push_token format' });
  }
  const plat = VALID_PLATFORMS.has(platform) ? platform : null;
  const sev = VALID_SEVERITIES.has(min_severity) ? min_severity : 'warn';
  const now = Date.now();

  try {
    const existing = db.prepare(
      'SELECT id FROM fms_push_subscriptions WHERE expo_push_token = ?'
    ).get(expo_push_token);

    if (existing) {
      db.prepare(`
        UPDATE fms_push_subscriptions
        SET tenant_id = ?, user_id = ?, platform = ?, device_name = ?, app = ?,
            min_severity = ?, last_seen_at = ?
        WHERE id = ?
      `).run(tid, uid, plat, device_name || null, app || 'fms', sev, now, existing.id);
      return res.json({ ok: true, id: existing.id, updated: true });
    }

    const info = db.prepare(`
      INSERT INTO fms_push_subscriptions
        (tenant_id, user_id, expo_push_token, platform, device_name, app, min_severity, created_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(tid, uid, expo_push_token, plat, device_name || null, app || 'fms', sev, now, now);
    return res.json({ ok: true, id: info.lastInsertRowid, created: true });
  } catch (e) {
    console.error('[fms-push] upsert failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// DELETE /v1/fms/devices/push-token — unregister this token.
router.delete('/devices/push-token', (req, res) => {
  const { expo_push_token } = req.body || {};
  if (!expo_push_token) return res.status(400).json({ error: 'expo_push_token required' });
  try {
    const info = db.prepare('DELETE FROM fms_push_subscriptions WHERE expo_push_token = ?').run(expo_push_token);
    return res.json({ ok: true, deleted: info.changes });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /v1/fms/devices/push-subscriptions — list current user's subscriptions.
router.get('/devices/push-subscriptions', (req, res) => {
  const tid = tenantOf(req);
  if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const uid = req.user?.id || req.user?.userId || null;
  const rows = db.prepare(`
    SELECT id, platform, device_name, app, min_severity, created_at, last_seen_at
    FROM fms_push_subscriptions
    WHERE tenant_id = ? AND user_id = ?
    ORDER BY last_seen_at DESC
  `).all(tid, uid);
  res.json(rows);
});

module.exports = router;
