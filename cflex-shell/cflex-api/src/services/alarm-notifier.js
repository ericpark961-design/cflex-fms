// services/alarm-notifier.js — dispatch FMS alarms to Teams / LINE / SMS / Email.
// Fire-and-forget. Per-tenant routing rules in `fms_alarm_routes`.
const axios = require('axios');
const db = require('../config/database');
const expoPush = require('./expo-push-notifier');

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

async function dispatchTeams({ target, msg, alert }) {
  // Dual mode: if target is an Incoming Webhook or Power Automate workflow URL,
  // POST an Adaptive Card directly (no AAD app required). Otherwise treat target
  // as teamId/channelId and go through runless-uc (Graph API, needs Bot creds).
  const t = String(target || '');
  const isWebhook = /^https:\/\/(?:[a-z0-9-]+\.webhook\.office\.com|outlook\.office\.com\/webhook|prod-[a-z0-9-]+\.[a-z]+\.logic\.azure\.com)/i.test(t);

  if (isWebhook) {
    try {
      const sev = (alert && alert.priority) || 'P3';
      const colorMap = { P1: 'attention', P2: 'warning', P3: 'accent', P4: 'good' };
      const accent = colorMap[sev] || 'default';
      const dashUrl = 'https://cflex.runless.co.uk/fms';
      const body = [
        { type: 'TextBlock', size: 'Medium', weight: 'Bolder', color: accent, text: `🚨 ${msg.head}` },
      ];
      if (msg.where) body.push({ type: 'TextBlock', isSubtle: true, spacing: 'None', text: msg.where, wrap: true });
      body.push({ type: 'TextBlock', text: msg.body, wrap: true, spacing: 'Small' });
      if (msg.detail) body.push({ type: 'TextBlock', isSubtle: true, size: 'Small', text: msg.detail, wrap: true, spacing: 'Small' });
      const card = {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            msteams: { width: 'Full' },
            body,
            actions: [{ type: 'Action.OpenUrl', title: 'Open in C-Flex', url: dashUrl }],
          },
        }],
      };
      const r = await axios.post(t, card, { timeout: 12000, headers: { 'Content-Type': 'application/json' } });
      return { ok: r.status >= 200 && r.status < 300, channel: 'teams', mode: 'webhook' };
    } catch (e) {
      return { ok: false, channel: 'teams', mode: 'webhook', error: (e.response && e.response.data) || e.message };
    }
  }

  // Fallback to runless-uc Graph API path
  if (!UC_INTERNAL_KEY) return { ok: false, channel: 'teams', error: 'INTERNAL_API_KEY not set' };
  try {
    const [teamId, channelId] = t.split('/');
    if (!teamId || !channelId) return { ok: false, channel: 'teams', error: 'target must be webhook URL or teamId/channelId' };
    const text = `🚨 **${msg.head}**\n_${msg.where}_\n${msg.body}${msg.detail ? '\n\n' + msg.detail : ''}`;
    const r = await axios.post(`${UC_URL}/v1/teams/post-message`,
      { teamId, channelId, body: text },
      { headers: { 'X-Internal-API-Key': UC_INTERNAL_KEY }, timeout: 12000 });
    return { ok: true, channel: 'teams', mode: 'graph', id: r.data?.messageId };
  } catch (e) {
    return { ok: false, channel: 'teams', mode: 'graph', error: e.message };
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

async function dispatchSlack({ target, msg, alert }) {
  // target = full Slack Incoming Webhook URL
  if (!/^https:\/\/hooks\.slack\.com\/services\//.test(String(target))) {
    return { ok: false, channel: 'slack', error: 'invalid webhook URL' };
  }
  try {
    const emojiMap = { P1: ':rotating_light:', P2: ':warning:', P3: ':information_source:', P4: ':white_check_mark:' };
    const colorMap = { P1: '#da1e28', P2: '#f1c21b', P3: '#0f62fe', P4: '#24a148' };
    const prio = (alert && alert.priority) || 'P3';
    const emoji = emojiMap[prio] || ':bell:';
    const color = colorMap[prio] || '#525252';
    const dashUrl = 'https://cflex.runless.co.uk/fms';
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '*' + emoji + ' ' + msg.head + '*' } },
    ];
    if (msg.where) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ':round_pushpin: ' + msg.where }] });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '> ' + msg.body } });
    if (msg.detail) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: msg.detail }] });
    const alertId  = alert?.id || 0;
    const deviceId = alert?.device_id || '';
    const metric   = alert?.metric || '';
    const ackUrl   = dashUrl + '?alarm=' + alertId;
    blocks.push({ type: 'actions', block_id: 'cflex_alarm_' + alertId, elements: [
      { type: 'button', action_id: 'cflex_ack',
        text: { type: 'plain_text', text: '✅ Acknowledge' },
        value: JSON.stringify({ alertId, deviceId }), style: 'primary' },
      { type: 'button', action_id: 'cflex_mute_1h',
        text: { type: 'plain_text', text: '🔕 Mute 1h' },
        value: JSON.stringify({ alertId, deviceId, metric, minutes: 60 }) },
      { type: 'button', action_id: 'cflex_open',
        text: { type: 'plain_text', text: 'Open in C-Flex' }, url: ackUrl },
    ] });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'C-Flex FMS - <' + dashUrl + '|cflex.runless.co.uk>' }] });

    const r = await axios.post(target, {
      text: emoji + ' ' + msg.head + ' - ' + msg.body,
      blocks,
      attachments: [{ color, blocks: [] }],
    }, { timeout: 10000 });
    return { ok: r.status >= 200 && r.status < 300, channel: 'slack' };
  } catch (e) {
    return { ok: false, channel: 'slack', error: (e.response && e.response.data) || e.message };
  }
}

async function dispatchDiscord({ target, msg, alert }) {
  if (!/^https:\/\/discord(?:app)?\.com\/api\/webhooks\//i.test(String(target))) {
    return { ok: false, channel: 'discord', error: 'invalid webhook URL' };
  }
  try {
    const sev = (alert && alert.priority) || 'P3';
    const colorMap = { P1: 0xda1e28, P2: 0xf1c21b, P3: 0x0f62fe, P4: 0x24a148 };
    const emojiMap = { P1: '🚨', P2: '⚠️', P3: 'ℹ️', P4: '✅' };
    const payload = {
      username: 'C-Flex FMS',
      embeds: [{
        title: `${emojiMap[sev] || '🔔'} ${msg.head}`,
        description: msg.body,
        color: colorMap[sev] || 0x525252,
        fields: [
          msg.where ? { name: 'Location', value: msg.where, inline: true } : null,
          msg.detail ? { name: 'Detail', value: msg.detail, inline: false } : null,
        ].filter(Boolean),
        footer: { text: 'C-Flex FMS · cflex.runless.co.uk' },
        timestamp: new Date().toISOString(),
      }],
    };
    const r = await axios.post(target, payload, { timeout: 10000 });
    return { ok: r.status >= 200 && r.status < 300, channel: 'discord' };
  } catch (e) {
    return { ok: false, channel: 'discord', error: (e.response && e.response.data) || e.message };
  }
}

async function dispatchPagerDuty({ target, msg, alert }) {
  // target = PagerDuty Events API v2 routing key (integration key, 32 chars)
  // https://developer.pagerduty.com/docs/events-api-v2/
  const routingKey = String(target || '').trim();
  if (routingKey.length < 16 || routingKey.length > 64) {
    return { ok: false, channel: 'pagerduty', error: 'invalid routing key' };
  }
  try {
    const sev = (alert && alert.priority) || 'P3';
    const pdSev = { P1: 'critical', P2: 'warning', P3: 'info', P4: 'info' }[sev] || 'warning';
    const dedup = `cflex-${alert?.tenant_id || 0}-${alert?.device_id || 'x'}-${alert?.metric || 'x'}`;
    const r = await axios.post('https://events.pagerduty.com/v2/enqueue', {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: dedup,
      payload: {
        summary: msg.head + (msg.where ? ' — ' + msg.where : ''),
        source: 'C-Flex FMS',
        severity: pdSev,
        component: alert?.metric || 'ups',
        group: msg.where || '',
        class: alert?.priority || 'P3',
        custom_details: { body: msg.body, detail: msg.detail, alertId: alert?.id, deviceId: alert?.device_id },
      },
      client: 'C-Flex FMS',
      client_url: 'https://cflex.runless.co.uk/fms',
    }, { timeout: 12000 });
    return { ok: r.status === 202, channel: 'pagerduty', dedup_key: r.data?.dedup_key };
  } catch (e) {
    return { ok: false, channel: 'pagerduty', error: (e.response && e.response.data) || e.message };
  }
}

async function dispatchServiceNow({ target, msg, alert }) {
  // target format: https://<instance>.service-now.com/api/now/table/incident|<basic_b64>
  // The basic auth is appended after a pipe so a single column can carry the URL and creds.
  // (Phase 2: move creds to fms_control_config or per-route secret store.)
  const [url, basicB64] = String(target || '').split('|');
  if (!/^https:\/\/.+\.service-now\.com\/api\/now\/table\/incident/i.test(url || '')) {
    return { ok: false, channel: 'servicenow', error: 'invalid SNOW URL' };
  }
  if (!basicB64) {
    return { ok: false, channel: 'servicenow', error: 'missing basic_b64 after | delimiter' };
  }
  try {
    const sev = (alert && alert.priority) || 'P3';
    const impact   = { P1: 1, P2: 2, P3: 3, P4: 4 }[sev] || 3;
    const urgency  = impact;
    const body = {
      short_description: msg.head + (msg.where ? ' — ' + msg.where : ''),
      description: [msg.body, msg.detail].filter(Boolean).join('\n\n'),
      impact: String(impact),
      urgency: String(urgency),
      caller_id: 'cflex-fms',
      category: 'hardware',
      subcategory: 'ups',
      cmdb_ci: alert?.device_id || '',
      u_alert_id: alert?.id || '',
      u_source: 'C-Flex FMS',
    };
    const r = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                 'Authorization': 'Basic ' + basicB64 },
      timeout: 15000,
    });
    return { ok: r.status >= 200 && r.status < 300, channel: 'servicenow',
             sys_id: r.data?.result?.sys_id, number: r.data?.result?.number };
  } catch (e) {
    return { ok: false, channel: 'servicenow', error: (e.response && e.response.data) || e.message };
  }
}

async function dispatchWebhook({ target, msg, alert }) {
  // Generic JSON webhook for Zapier, IFTTT, n8n, Make, custom endpoints.
  if (!/^https:\/\//.test(String(target))) {
    return { ok: false, channel: 'webhook', error: 'invalid URL' };
  }
  try {
    const payload = {
      source: 'cflex-fms',
      sent_at: new Date().toISOString(),
      alert: {
        id: alert?.id, tenant_id: alert?.tenant_id, device_id: alert?.device_id,
        priority: alert?.priority, metric: alert?.metric, message: alert?.message,
        value: alert?.value, threshold: alert?.threshold,
      },
      formatted: {
        title: msg.head, location: msg.where, body: msg.body, detail: msg.detail,
      },
      dashboard_url: 'https://cflex.runless.co.uk/fms',
    };
    const r = await axios.post(target, payload, { timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'cflex-fms/1.0' } });
    return { ok: r.status >= 200 && r.status < 300, channel: 'webhook', status: r.status };
  } catch (e) {
    return { ok: false, channel: 'webhook', error: (e.response && e.response.data) || e.message };
  }
}

const dispatchers = { line: dispatchLine, sms: dispatchSms, teams: dispatchTeams, email: dispatchEmail, slack: dispatchSlack, discord: dispatchDiscord, pagerduty: dispatchPagerDuty, servicenow: dispatchServiceNow, webhook: dispatchWebhook };

function isMuted(alert) {
  try {
    const now = Date.now();
    const m = db.prepare(`
      SELECT 1 FROM fms_alarm_mutes
      WHERE (tenant_id=? OR tenant_id IS NULL)
        AND device_id=?
        AND (metric IS NULL OR metric=?)
        AND muted_until > ?
      LIMIT 1
    `).get(alert.tenant_id, alert.device_id, alert.metric || '', now);
    return !!m;
  } catch (_) { return false; }
}

async function notify(alert) {
  try {
    if (!alert || !alert.tenant_id) return;
    if (isMuted(alert)) {
      console.log('[alarm-notifier]', alert.id, 'muted — skipping dispatch');
      return [{ ok: true, channel: 'muted', skipped: true }];
    }
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
      const r = await fn({ target: rule.target, msg, alert });
      results.push(r);
      try {
        db.prepare(
          'INSERT INTO fms_alarm_dispatch_log (alert_id, channel, target, ok, error, sent_at) VALUES (?,?,?,?,?,?)'
        ).run(alert.id || 0, r.channel, rule.target, r.ok ? 1 : 0, r.error || null, Date.now());
      } catch (_) {}
      console.log('[alarm-notifier]', alert.id, rule.channel, '→', r.ok ? 'OK' : ('FAIL ' + r.error));
    }
    try { await expoPush.dispatch(alert, asset); } catch (e) { console.error("[alarm-notifier] expo-push:", e.message); }
    return results;
  } catch (e) {
    console.error('[alarm-notifier] error:', e.message);
  }
}

module.exports = { notify, dispatchers, formatMessage };
