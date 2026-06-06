// routes/fms-ack.routes.js
// Mount under SAME base as fms.routes.js (/v1/fms):
//   app.use('/v1/fms', require('./routes/fms.routes'));
//   app.use('/v1/fms', require('./routes/fms-push.routes'));
//   app.use('/v1/fms', require('./routes/fms-ack.routes'));   // ← add this
const express = require('express');
const router = express.Router();
const db = require('../config/database');

router.use(express.json({ limit: '16kb' }));

function tenantOf(req) {
  if (!req.user) return null;
  if (req.user.role === 'super_admin' || req.user.role === 'admin') {
    return req.body?.tenant_id ? parseInt(req.body.tenant_id, 10) : (req.user.tenantId || null);
  }
  return req.user.tenantId || null;
}

function actorOf(req) {
  return req.user?.email || req.user?.name || `user:${req.user?.id ?? '?'}`;
}

// POST /v1/fms/alerts/:id/ack
router.post('/alerts/:id/ack', (req, res) => {
  const tid = tenantOf(req);
  if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid alert id' });
  const now = Date.now();
  const actor = actorOf(req);
  try {
    const info = db.prepare(
      'UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND tenant_id = ?'
    ).run(now, actor, id, tid);
    if (!info.changes) return res.status(404).json({ error: 'alert not found' });
    return res.json({ ok: true, id, acked_at: now, acked_by: actor });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /v1/fms/alerts/:id/unack
router.post('/alerts/:id/unack', (req, res) => {
  const tid = tenantOf(req);
  if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid alert id' });
  try {
    const info = db.prepare(
      'UPDATE alerts SET acked_at = NULL, acked_by = NULL WHERE id = ? AND tenant_id = ?'
    ).run(id, tid);
    if (!info.changes) return res.status(404).json({ error: 'alert not found' });
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
