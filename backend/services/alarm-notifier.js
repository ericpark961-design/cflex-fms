// services/alarm-notifier.js — dispatch FMS alarms to Teams / LINE / SMS / Email.
// Fire-and-forget. Per-tenant routing rules in `fms_alarm_routes`.
const axios = require('axios');
const db = require('../config/database');

const SC_URL = process.env.SC_INTERNAL_URL || 'http://localhost:3200';
const UC_URL = process.env.RUNLESS_UC_URL || 'http://localhost:3100';
const UC_INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';

const SEV_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

function shouldSend(rule, alertPriority) {
  return SEV_RANK[alertPriority] <= SEV_RANK[rule.min_priority || 'P2'];
}

function formatMessage(alert, asset) {
  const head = `[${alert.priority}] ${asset?.label || alert.device_id}`;
  const where = [asset?.location, asset?.room, asset?.rack].filter(Boolean).join(' · ');
  const body = alert.message;
  const detail = [
    alert.metric ? `· metric: ${alert.metric}` : '',
    alert.value != null ? `· value: ${alert.value}` : '',
    alert.threshold != null ? `· threshold: ${alert.threshold}` : '',
  ].filter(Boolean).join(' ');
  return { head, where, body, detail };
}

async function dispatchLine({ target, msg }) {
  try {
    const text = `🚨 ${msg.head}\n${msg.where}\n${msg.body}${msg.detail ? '\n' + msg.detail : ''}`;
    const r = await axios.post(`${SC_URL}/webhook/line/send`, {
      to: target, body: text, senderEmail: 'fms-alarm@ringonservice.net',
    }, { timeout: 10000 });
    return { ok: true, channel: 'line', id: r.data?.result?.sentMessages?.[0]?.id };
  } catch (e) {
    return { ok: false, channel: 'line', error: e.message };
  }
}

async function dispatchSms({ target, msg }) {
  try {
    const text = `${msg.head} ${msg.where} ${msg.body}${msg.detail ? ' ' + msg.detail : ''}`.slice(0, 320);
    const r = await axios.post(`${SC_URL}/webhook/sms/send`, {
      to: target, body: text, senderEmail: 'fms-alarm@ringonservice.net',
    }, { timeout: 10000 });
    return { ok: true, channel: 'sms', id: r.data?.result?.sid, dryRun: r.data?.result?.dryRun };
  } catch (e) {
    return { ok: false, channel: 'sms', error: e.message };
  }
}

async function dispatchTeams({ target, msg }) {
  if (!UC_INTERNAL_KEY) return { ok: false, channel: 'teams', error: 'INTERNAL_API_KEY not set' };
  try {
    const [teamId, channelId] = String(target).split('/');
    if (!teamId || !channelId) return { ok: false, channel: 'teams', error: 'target must be teamId/channelId' };
    const text = `🚨 **${msg.head}**\n_${msg.where}_\n${msg.body}${msg.detail ? '\n\n' + msg.detail : ''}`;
    const r = await axios.post(`${UC_URL}/v1/teams/post-message`,
      { teamId, channelId, body: text },
      { headers: { 'X-Internal-API-Key': UC_INTERNAL_KEY }, timeout: 12000 });
    return { ok: true, channel: 'teams', id: r.data?.messageId };
  } catch (e) {
    return { ok: false, channel: 'teams', error: e.message };
  }
}

async function dispatchEmail({ target, msg }) {
  if (!RESEND_KEY) return { ok: false, channel: 'email', error: 'RESEND_API_KEY not set' };
  try {
    const subject = msg.head + (msg.where ? ' — ' + msg.where : '');
    const text = [msg.head, msg.where, msg.body, msg.detail].filter(Boolean).join('\n\n');
    const html = `<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; padding: 24px;">
      <div style="font-size: 11px; letter-spacing: 0.6px; color: #da1e28; font-weight: 700; text-transform: uppercase;">🚨 RingOn FMS Alarm</div>
      <h2 style="margin: 8px 0 4px; font-size: 20px;">${msg.head}</h2>
      <div style="color: #525252; font-size: 13px; margin-bottom: 16px;">${msg.where || ''}</div>
      <div style="background: #fff1f1; border-left: 3px solid #da1e28; padding: 12px 14px; font-size: 14px; color: #161616;">${msg.body}</div>
      ${msg.detail ? `<div style="font-size: 12px; color: #8d8d8d; margin-top: 12px;">${msg.detail}</div>` : ''}
      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #8d8d8d;">
        Sent by C-Flex FMS · <a href="https://cflex.runless.co.uk/fms" style="color: #0f62fe;">View in dashboard</a>
      </div></div>`;
    const r = await axios.post('https://api.resend.com/emails', {
      from: 'RingOn FMS <fms-alarm@ringonservice.net>',
      to: target, subject, text, html,
    }, { headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
    return { ok: true, channel: 'email', id: r.data?.id };
  } catch (e) {
    return { ok: false, channel: 'email', error: e.response?.data?.message || e.message };
  }
}

const dispatchers = { line: dispatchLine, sms: dispatchSms, teams: dispatchTeams, email: dispatchEmail };

async function notify(alert) {
  try {
    if (!alert || !alert.tenant_id) return;
    const rules = db.prepare(
      'SELECT channel, min_priority, target FROM fms_alarm_routes WHERE tenant_id = ? AND enabled = 1'
    ).all(alert.tenant_id);
    if (!rules.length) return;

    const numericId = parseInt(String(alert.device_id).replace(/^ups-/, ''), 10);
    const asset = numericId
      ? db.prepare('SELECT label, location, room, rack FROM ups_devices WHERE id = ?').get(numericId)
      : null;

    const msg = formatMessage(alert, asset);
    const results = [];
    for (const rule of rules) {
      if (!shouldSend(rule, alert.priority)) continue;
      const fn = dispatchers[rule.channel];
      if (!fn) continue;
      const r = await fn({ target: rule.target, msg });
      results.push(r);
      try {
        db.prepare(
          'INSERT INTO fms_alarm_dispatch_log (alert_id, channel, target, ok, error, sent_at) VALUES (?,?,?,?,?,?)'
        ).run(alert.id || 0, r.channel, rule.target, r.ok ? 1 : 0, r.error || null, Date.now());
      } catch (_) {}
      console.log('[alarm-notifier]', alert.id, rule.channel, '→', r.ok ? 'OK' : ('FAIL ' + r.error));
    }
    return results;
  } catch (e) {
    console.error('[alarm-notifier] error:', e.message);
  }
}

module.exports = { notify };
