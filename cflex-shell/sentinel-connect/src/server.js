// Sentinel Connect — main server
// Multi-channel (WhatsApp / SMS / LINE / Teams / iMessage) compliance archive
// for auto dealer regulated communications (Dodd-Frank, FTC Safeguards, TCPA, state 2-party).
require("dotenv").config({ path: "/opt/cflex-v2/sentinel-connect/.env", override: true });

const express = require('express');
const { db } = require('./db');

const PORT = parseInt(process.env.SC_PORT || '3200', 10);

// ─── Express app ─────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true })); // Twilio webhook is form-encoded

app.get('/health', (req, res) => {
  const counts = {
    dealers:       db.prepare('SELECT COUNT(*) c FROM sc_dealers').get().c,
    channels:      db.prepare('SELECT COUNT(*) c FROM sc_channels').get().c,
    conversations: db.prepare('SELECT COUNT(*) c FROM sc_conversations').get().c,
    messages:      db.prepare('SELECT COUNT(*) c FROM sc_messages').get().c,
  };
  res.json({ ok: true, service: 'sentinel-connect', version: '0.1.0', port: PORT, counts });
});

// ─── Channel adapters mount ──────────────────────────
const fs = require('fs');
const pathMod = require('path');
const MEDIA_DIR = process.env.SC_MEDIA_DIR || '/opt/cflex-v2/sentinel-connect/data/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1d' }));

app.use('/webhook/whatsapp', require('./adapters/whatsapp'));
app.use('/webhook/sms',      require('./adapters/twilio-sms'));
app.use('/webhook/kakao',    require('./adapters/kakao'));
app.use('/webhook/line',     require('./adapters/line'));

// ─── Console / read API (for cflex-api or NOC dashboard) ──
app.use('/api/dealers',       require('./routes/dealers'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/messages',      require('./routes/messages'));
app.use('/api/consents',      require('./routes/consents'));

// Stub for adapters not yet built — return 501
app.all('*', (req, res) => res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.path }));

// ─── Boot ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[sentinel-connect] listening on :${PORT}, db=set`);
});

module.exports = { app };
