// adapters/twilio-sms.js — Twilio SMS / MMS bridge for Sentinel Connect.
// Webhook receives application/x-www-form-urlencoded from Twilio.
// On send, uses Twilio REST API. Supports DRY_RUN until A2P 10DLC approval.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN || '';
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const DRY_RUN     = process.env.TWILIO_DRY_RUN === '1' || !ACCOUNT_SID;

const MEDIA_DIR = process.env.SC_MEDIA_DIR || '/opt/cflex-v2/sentinel-connect/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const { ingestMessage, ingestOutbound } = require('../services/ingest');
const { db } = require('../db');

// ── Twilio signature verification (HMAC-SHA1) ─────────────────────
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function verifyTwilioSignature(req, res, next) {
  if (DRY_RUN) return next();   // Skip in dry-run
  const sig = req.header('X-Twilio-Signature');
  if (!sig) return res.status(403).send('missing signature');
  // URL = full URL including query string
  const url = `https://${req.header('host')}${req.originalUrl}`;
  // Concatenate sorted POST params
  const params = req.body || {};
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join('');
  const data = url + sorted;
  const expected = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
  if (expected !== sig) {
    console.error('[sms] bad signature');
    return res.status(403).send('bad signature');
  }
  next();
}

// ── Conversation upsert ───────────────────────────────────────────
function upsertConversation(dealerId, e164) {
  const customerExternalId = 'sms:' + e164;
  let conv = db.prepare(
    'SELECT * FROM sc_conversations WHERE dealer_id = ? AND customer_external_id = ?'
  ).get(dealerId, customerExternalId);
  if (!conv) {
    const r = db.prepare(`
      INSERT INTO sc_conversations
      (dealer_id, customer_external_id, customer_display_name, primary_channel,
       consent_status, last_message_at, created_at, auto_reply_enabled)
      VALUES (?,?,?,?,?,?,?,1)
    `).run(dealerId, customerExternalId, e164, 'sms', 'pending', Date.now(), Date.now());
    conv = db.prepare('SELECT * FROM sc_conversations WHERE id = ?').get(r.lastInsertRowid);
  }
  return conv;
}

// ── Download MMS media to MEDIA_DIR ───────────────────────────────
async function downloadMms(messageSid, mediaUrl, idx) {
  try {
    const resp = await axios.get(mediaUrl, {
      auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5,
    });
    const ct = resp.headers['content-type'] || 'application/octet-stream';
    const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('png') ? 'png'
              : ct.includes('gif') ? 'gif' : ct.includes('mp4') ? 'mp4'
              : ct.split('/')[1] || 'bin';
    const filename = `sms-${messageSid}-${idx}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), resp.data);
    return `/media/${filename}`;
  } catch (e) {
    console.error('[sms/download]', messageSid, e.message);
    return null;
  }
}

// ── POST /webhook/sms ── inbound from Twilio
// Twilio webhook (urlencoded) keys: From, To, Body, MessageSid, NumMedia, MediaUrl0..N
router.post('/', express.urlencoded({ extended: false }), verifyTwilioSignature, async (req, res) => {
  try {
    const from = req.body.From;
    const to   = req.body.To;
    const body = req.body.Body || '';
    const sid  = req.body.MessageSid;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    // Look up dealer by `To` number (route to correct tenant via sc_channels.identifier)
    const ch = db.prepare(
      'SELECT * FROM sc_channels WHERE channel = ? AND identifier = ? AND status = ? LIMIT 1'
    ).get('sms', to, 'active');
    const dealerId = ch?.dealer_id || 1; // default to RingOn

    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const url = await downloadMms(sid, req.body[`MediaUrl${i}`], i);
      if (url) mediaUrls.push(url);
    }

    const conv = upsertConversation(dealerId, from);
    ingestMessage({
      conversationId: conv.id,
      externalId: sid,
      channel: 'sms',
      direction: 'inbound',
      senderExternalId: 'sms:' + from,
      senderDisplayName: from,
      body,
      mediaUrls,
      rawPayload: req.body,
      ts: Date.now(),
    });

    // Empty TwiML response (we don't reply synchronously — AI auto-reply handles it)
    res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (e) {
    console.error('[sms/webhook]', e.message);
    res.status(500).set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

// ── sendSMS ── outbound via Twilio REST or DRY_RUN log
async function sendSMS({ to, body, mediaUrls = [] }) {
  const phone = to.startsWith('sms:') ? to.slice(4) : to;
  if (DRY_RUN) {
    console.log('[sms/DRY_RUN]', { to: phone, body: body.slice(0, 80), mediaUrls });
    return { sid: 'DRYRUN-' + Date.now(), status: 'queued', dryRun: true };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams();
  const MSG_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
  if (MSG_SID) { params.append('MessagingServiceSid', MSG_SID); } else { params.append('From', FROM_NUMBER); }
  params.append('To', phone);
  params.append('Body', body);
  for (const m of mediaUrls) params.append('MediaUrl', m);

  const resp = await axios.post(url, params, {
    auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
    timeout: 20000,
  });
  return resp.data;
}

// ── POST /webhook/sms/send ── internal API for dealer dashboard
router.post('/send', express.json(), async (req, res) => {
  try {
    const { to, body, mediaUrls } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to + body required' });
    const result = await sendSMS({ to, body, mediaUrls });
    // Record outbound row
    try {
      ingestOutbound({
        dealerId: 1,
        customerExternalId: to.startsWith('sms:') ? to : ('sms:' + to),
        channel: 'sms',
        body,
        externalId: result?.sid || null,
        senderEmail: req.body?.senderEmail || 'system',
        mediaUrls,
      });
    } catch (e2) { console.error('[sms/send] ingest failed', e2.message); }
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

module.exports = router;
module.exports.sendSMS = sendSMS;
module.exports.DRY_RUN = DRY_RUN;
