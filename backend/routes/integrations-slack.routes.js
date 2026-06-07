// Slack interactivity webhook — receives button clicks from alarm cards.
//
// Setup (one-time, in Slack App config):
//   1. api.slack.com/apps → Your App → Interactivity & Shortcuts
//   2. Request URL: https://cflex.runless.co.uk/v1/integrations/slack/interactivity
//   3. Save the Signing Secret → set SLACK_SIGNING_SECRET in cflex-api env
//
// Button action_ids (from alarm-notifier.js dispatchSlack):
//   - cflex_ack       → ack the alarm (sets alerts.acked_at, acked_by)
//   - cflex_mute_1h   → mute device/metric for 60 min (inserts fms_alarm_mutes)
//   - cflex_open      → URL button, never reaches this endpoint (Slack opens directly)

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const router  = express.Router();
const db      = require('../config/database');
const logger  = require('../utils/logger');

// One-time table create for mute records
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS fms_alarm_mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    device_id TEXT,
    metric TEXT,
    muted_until INTEGER NOT NULL,
    muted_by TEXT,
    muted_via TEXT,
    created_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_mutes_active
              ON fms_alarm_mutes(device_id, metric, muted_until)`).run();
} catch (e) { logger?.warn?.('[slack] fms_alarm_mutes create:', e.message); }

// Raw-body capture for HMAC verification — Slack signs the exact wire bytes.
// Must run BEFORE express.urlencoded() parses the body.
const captureRawBody = express.raw({ type: '*/*', limit: '256kb' });

function verifySlackSignature(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return { ok: false, reason: 'SLACK_SIGNING_SECRET not set' };
  const ts  = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return { ok: false, reason: 'missing signature headers' };
  // Reject replays older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) {
    return { ok: false, reason: 'timestamp out of window' };
  }
  const body = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  const base = `v0:${ts}:${body}`;
  const mac  = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  try {
    const a = Buffer.from(mac);
    const b = Buffer.from(sig);
    if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  } catch {
    return { ok: false, reason: 'signature decode error' };
  }
  return { ok: true, body };
}

// POST /v1/integrations/slack/interactivity
router.post('/interactivity', captureRawBody, async (req, res) => {
  const v = verifySlackSignature(req);
  if (!v.ok) {
    logger?.warn?.(`[slack] signature reject: ${v.reason}`);
    return res.status(401).send(v.reason);
  }

  // Slack sends application/x-www-form-urlencoded with a single `payload` field
  const params = new URLSearchParams(v.body);
  let payload;
  try { payload = JSON.parse(params.get('payload') || '{}'); }
  catch (e) { return res.status(400).send('invalid payload JSON'); }

  if (payload.type !== 'block_actions') {
    return res.status(200).send(''); // ignore other types
  }

  const action     = (payload.actions || [])[0] || {};
  const userName   = payload.user?.name || payload.user?.username || 'slack:unknown';
  const userId     = payload.user?.id   || '';
  const responseUrl = payload.response_url;

  let value = {};
  try { value = JSON.parse(action.value || '{}'); } catch {}

  const replyText = (text) => {
    res.status(200).send('');
    if (responseUrl) {
      axios.post(responseUrl, { replace_original: false, response_type: 'ephemeral', text })
        .catch(e => logger?.warn?.('[slack] response_url:', e.message));
    }
  };

  try {
    if (action.action_id === 'cflex_ack') {
      const alertId = parseInt(value.alertId, 10);
      if (!alertId) return replyText(':warning: missing alertId');
      const row = db.prepare('SELECT id, acked_at FROM alerts WHERE id=?').get(alertId);
      if (!row) return replyText(`:grey_question: alert ${alertId} not found`);
      if (row.acked_at) return replyText(`:information_source: alert ${alertId} already acknowledged`);
      db.prepare('UPDATE alerts SET acked_at=?, acked_by=? WHERE id=?')
        .run(Date.now(), `slack:${userName}`, alertId);
      logger?.info?.(`[slack] ack alert=${alertId} by=${userName}(${userId})`);
      return replyText(`:white_check_mark: alert ${alertId} acknowledged by ${userName}`);
    }

    if (action.action_id === 'cflex_mute_1h') {
      const { deviceId, metric, minutes } = value;
      if (!deviceId) return replyText(':warning: missing deviceId');
      const mins  = parseInt(minutes, 10) || 60;
      const until = Date.now() + mins * 60 * 1000;
      const alert = db.prepare('SELECT tenant_id FROM alerts WHERE id=?').get(parseInt(value.alertId, 10) || 0) || {};
      db.prepare(`INSERT INTO fms_alarm_mutes
                  (tenant_id, device_id, metric, muted_until, muted_by, muted_via, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(alert.tenant_id || null, deviceId, metric || null, until,
             `slack:${userName}`, 'slack', Date.now());
      logger?.info?.(`[slack] mute device=${deviceId} metric=${metric || '*'} mins=${mins} by=${userName}`);
      const untilStr = new Date(until).toISOString().slice(11, 16);
      return replyText(`:no_bell: muted ${deviceId}${metric ? '/' + metric : ''} for ${mins}m (until ${untilStr} UTC)`);
    }

    return replyText(`:grey_question: unknown action: ${action.action_id}`);
  } catch (e) {
    logger?.error?.('[slack] action handler:', e);
    return replyText(`:rotating_light: error: ${e.message}`);
  }
});

// Health check — confirms env is wired
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    signing_secret_set: !!process.env.SLACK_SIGNING_SECRET,
    endpoint: 'POST /v1/integrations/slack/interactivity',
  });
});

module.exports = router;
