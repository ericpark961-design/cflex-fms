// The nine channels, as they are actually implemented in production.
//
// Each dispatcher declares what config it `requires`, so `plan()` can report
// "routed but cannot run" before anything is sent — which is the failure people
// otherwise spend an afternoon on.
//
// Every one returns `{ok, id?, error?, dryRun?}` and throws nothing.

/** Adaptive Card for Teams, Slack blocks and the email HTML all want a colour. */
const PRIORITY_COLOUR = { P1: 'da1e28', P2: 'ff832b', P3: 'f1c21b', P4: '0f62fe' };
const PRIORITY_EMOJI = { P1: '🚨', P2: '⚠️', P3: '🔶', P4: 'ℹ️' };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── LINE ──────────────────────────────────────────────────────────
// Goes through Sentinel Connect, a RingOn-internal service — NOT the LINE API
// directly. An air-gapped customer network cannot reach it.
const line = {
  requires: ['sentinelConnect.url'],
  async send({ route, msg, config, http }) {
    const text = `${PRIORITY_EMOJI[msg.priority] || ''} ${msg.head}\n${msg.where}\n${msg.body}${msg.detail ? '\n' + msg.detail : ''}`;
    const r = await http(`${trim(config.sentinelConnect.url)}/webhook/line/send`, {
      to: route.target, body: text, senderEmail: config.sentinelConnect.senderEmail || config.fromAddress,
    }, { headers: authHeader(config.sentinelConnect) });
    return r.ok
      ? { ok: true, id: r.json?.result?.sentMessages?.[0]?.id ?? null }
      : { ok: false, error: r.error };
  },
};

// ── SMS ───────────────────────────────────────────────────────────
// Also Sentinel Connect. `dryRun` comes back when the gateway is in DRY_RUN —
// a send that did not happen must not report as delivered.
const sms = {
  requires: ['sentinelConnect.url'],
  async send({ route, msg, config, http }) {
    const r = await http(`${trim(config.sentinelConnect.url)}/webhook/sms/send`, {
      to: route.target, body: msg.oneLine(320),
      senderEmail: config.sentinelConnect.senderEmail || config.fromAddress,
    }, { headers: authHeader(config.sentinelConnect) });
    if (!r.ok) return { ok: false, error: r.error };
    const dryRun = !!r.json?.result?.dryRun;
    return { ok: true, id: r.json?.result?.sid ?? null, ...(dryRun ? { dryRun: true } : {}) };
  },
};

// ── Teams ─────────────────────────────────────────────────────────
// Two modes, as in production: an Incoming Webhook / Power Automate URL takes
// an Adaptive Card directly and needs no AAD app; anything else is treated as
// teamId/channelId and goes through runless-uc (Graph API, bot credentials).
//
// HAEA reaches Teams through its own HTTPS proxy, so the agent comes from
// config like every other transport detail.
const WEBHOOK_HOST = /^https:\/\/(?:[a-z0-9-]+\.webhook\.office\.com|outlook\.office\.com\/webhook|prod-[a-z0-9-]+\.[a-z]+\.logic\.azure\.com)/i;
const teams = {
  requires: [],
  async send({ route, msg, config, http }) {
    const target = String(route.target || '');
    if (WEBHOOK_HOST.test(target)) {
      const card = adaptiveCard(msg);
      const r = await http(target, card);
      // Power Automate answers 202 with an empty body; a webhook answers '1'.
      return r.ok ? { ok: true, id: null, mode: 'webhook' } : { ok: false, error: r.error, mode: 'webhook' };
    }
    if (!config.runlessUc?.url) {
      return { ok: false, error: 'target is not a Teams webhook URL and runlessUc.url is not configured' };
    }
    const [teamId, channelId] = target.split('/');
    if (!teamId || !channelId) return { ok: false, error: 'graph mode needs target "teamId/channelId"' };
    const r = await http(`${trim(config.runlessUc.url)}/internal/teams/send`, {
      teamId, channelId, text: [msg.head, msg.where, msg.body, msg.detail].filter(Boolean).join('\n'),
    }, { headers: authHeader(config.runlessUc) });
    return r.ok ? { ok: true, id: r.json?.id ?? null, mode: 'graph' } : { ok: false, error: r.error, mode: 'graph' };
  },
};

function adaptiveCard(msg) {
  const facts = [];
  if (msg.where) facts.push({ title: 'Location', value: msg.where });
  if (msg.detail) facts.push({ title: 'Detail', value: msg.detail });
  facts.push({ title: 'Time', value: msg.at.toISOString() });
  const body = [
    { type: 'TextBlock', text: `${PRIORITY_EMOJI[msg.priority] || ''} ${msg.productName} — ${msg.priority}`,
      weight: 'Bolder', size: 'Small', color: msg.priority === 'P1' ? 'Attention' : 'Warning' },
    { type: 'TextBlock', text: msg.head, weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: msg.body, wrap: true },
    { type: 'FactSet', facts },
  ];
  const actions = msg.url ? [{ type: 'Action.OpenUrl', title: 'Open dashboard', url: msg.url }] : [];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard', version: '1.4', body, ...(actions.length ? { actions } : {}),
      },
    }],
  };
}

// ── Email ─────────────────────────────────────────────────────────
// TWO transports. Resend is an internet API and is what the hosted service
// uses. HAEA has no internet and requires its own SMTP relay (spec §2.3 rule
// D, §3.5), so smtp is a first-class option — and the sender is INJECTED so
// this package needs no mail dependency and no SMTP implementation of its own.
const email = {
  requires: [],
  async send({ route, msg, config, http, deps }) {
    const transport = config.email?.transport || (config.email?.resendKey ? 'resend' : 'smtp');
    const subject = msg.head + (msg.where ? ' — ' + msg.where : '');
    const text = msg.plain();
    const html = emailHtml(msg);
    const from = config.email?.from || `${config.fromName} <${config.fromAddress || 'fms-noreply@localhost'}>`;

    if (transport === 'smtp') {
      const sendMail = deps?.smtpSend || config.email?.send;
      if (typeof sendMail !== 'function') {
        return { ok: false, error: 'email.transport=smtp requires an injected sender (deps.smtpSend or config.email.send)' };
      }
      try {
        const r = await sendMail({ to: route.target, from, subject, text, html });
        return { ok: true, id: r?.messageId ?? null, transport: 'smtp' };
      } catch (e) {
        return { ok: false, error: e.message, transport: 'smtp' };
      }
    }

    if (!config.email?.resendKey) return { ok: false, error: 'email.resendKey not set', transport: 'resend' };
    const r = await http('https://api.resend.com/emails',
      { from, to: route.target, subject, text, html },
      { headers: { Authorization: 'Bearer ' + config.email.resendKey } });
    return r.ok ? { ok: true, id: r.json?.id ?? null, transport: 'resend' }
                : { ok: false, error: r.error, transport: 'resend' };
  },
};

function emailHtml(msg) {
  const colour = '#' + (PRIORITY_COLOUR[msg.priority] || '0f62fe');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;padding:24px">
  <div style="font-size:11px;letter-spacing:.6px;color:${colour};font-weight:700;text-transform:uppercase">${esc(msg.productName)} · ${esc(msg.priority)}</div>
  <h2 style="margin:8px 0 4px;font-size:20px">${esc(msg.head)}</h2>
  <div style="color:#525252;font-size:13px;margin-bottom:16px">${esc(msg.where)}</div>
  <div style="background:#f4f4f4;border-left:3px solid ${colour};padding:12px 14px;font-size:14px;color:#161616">${esc(msg.body)}</div>
  ${msg.detail ? `<div style="font-size:12px;color:#8d8d8d;margin-top:12px">${esc(msg.detail)}</div>` : ''}
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:11px;color:#8d8d8d">
    ${esc(msg.at.toISOString())}${msg.url ? ` · <a href="${esc(msg.url)}" style="color:#0f62fe">View in dashboard</a>` : ''}
  </div></div>`;
}

// ── Slack ─────────────────────────────────────────────────────────
const slack = {
  requires: [],
  async send({ route, msg, http }) {
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(String(route.target))) {
      return { ok: false, error: 'target must be a Slack Incoming Webhook URL' };
    }
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `${PRIORITY_EMOJI[msg.priority] || ''} ${msg.head}`.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: msg.body || '_no message_' } },
    ];
    const fields = [];
    if (msg.where) fields.push({ type: 'mrkdwn', text: `*Location*\n${msg.where}` });
    if (msg.detail) fields.push({ type: 'mrkdwn', text: `*Detail*\n${msg.detail}` });
    if (fields.length) blocks.push({ type: 'section', fields });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${msg.productName} · ${msg.at.toISOString()}` }] });
    if (msg.url) {
      blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, url: msg.url }] });
    }
    const r = await http(route.target, { text: msg.oneLine(300), blocks });
    return r.ok ? { ok: true, id: null } : { ok: false, error: r.error };
  },
};

// ── Discord ───────────────────────────────────────────────────────
const discord = {
  requires: [],
  async send({ route, msg, http }) {
    if (!/^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\//.test(String(route.target))) {
      return { ok: false, error: 'target must be a Discord webhook URL' };
    }
    const r = await http(route.target, {
      username: msg.productName,
      embeds: [{
        title: msg.head.slice(0, 256),
        description: msg.body?.slice(0, 2048) || undefined,
        color: parseInt(PRIORITY_COLOUR[msg.priority] || '0f62fe', 16),
        fields: [
          msg.where ? { name: 'Location', value: msg.where.slice(0, 1024) } : null,
          msg.detail ? { name: 'Detail', value: msg.detail.slice(0, 1024) } : null,
        ].filter(Boolean),
        url: msg.url || undefined,
        timestamp: msg.at.toISOString(),
      }],
    });
    return r.ok ? { ok: true, id: null } : { ok: false, error: r.error };
  },
};

// ── PagerDuty (Events API v2) ─────────────────────────────────────
const pagerduty = {
  requires: [],
  async send({ route, msg, notification, http }) {
    const r = await http('https://events.pagerduty.com/v2/enqueue', {
      routing_key: route.target,
      event_action: 'trigger',
      // Same key for the same cause means PagerDuty groups repeats instead of
      // paging twice.
      dedup_key: notification.dedupKey || notification.id || undefined,
      payload: {
        summary: [msg.head, msg.body].filter(Boolean).join(' — ').slice(0, 1024),
        severity: msg.priority === 'P1' ? 'critical' : msg.priority === 'P2' ? 'error' : msg.priority === 'P3' ? 'warning' : 'info',
        source: notification.deviceLabel || notification.deviceId || msg.where || 'cflex-fms',
        component: notification.metric || undefined,
        group: msg.where || undefined,
        timestamp: msg.at.toISOString(),
        custom_details: { detail: msg.detail || undefined, value: notification.value, threshold: notification.threshold },
      },
      ...(msg.url ? { links: [{ href: msg.url, text: 'Open dashboard' }] } : {}),
    });
    return r.ok ? { ok: true, id: r.json?.dedup_key ?? null } : { ok: false, error: r.error };
  },
};

// ── ServiceNow (Table API) ────────────────────────────────────────
// SOW acceptance includes "ITSM eBonding test ticket completed", so this is a
// deliverable rather than a nicety. Priority maps to Impact/Urgency, which is
// what ServiceNow actually sorts on.
const SNOW_IMPACT = { P1: '1', P2: '2', P3: '3', P4: '3' };
const SNOW_URGENCY = { P1: '1', P2: '2', P3: '3', P4: '3' };
const servicenow = {
  requires: ['servicenow.instanceUrl', 'servicenow.auth'],
  async send({ route, msg, notification, config, http }) {
    const table = route.target || config.servicenow.table || 'incident';
    const url = `${trim(config.servicenow.instanceUrl)}/api/now/table/${table}`;
    const r = await http(url, {
      short_description: [msg.head, msg.body].filter(Boolean).join(' — ').slice(0, 160),
      description: [msg.plain(), msg.url ? `\nDashboard: ${msg.url}` : ''].join(''),
      impact: SNOW_IMPACT[msg.priority] || '3',
      urgency: SNOW_URGENCY[msg.priority] || '3',
      category: config.servicenow.category || 'Infrastructure',
      cmdb_ci: notification.deviceLabel || undefined,
      // Carrying our id lets a repeat update the same INC instead of opening
      // another one. The caller stores the returned sys_id against the alarm.
      correlation_id: notification.dedupKey || notification.id || undefined,
      u_source: config.productName,
    }, { headers: { Authorization: config.servicenow.auth } });
    if (!r.ok) return { ok: false, error: r.error };
    const rec = r.json?.result;
    return { ok: true, id: rec?.sys_id ?? null, number: rec?.number ?? null };
  },
};

// ── Generic webhook ───────────────────────────────────────────────
// The escape hatch: a stable JSON envelope a customer can point at anything.
const webhook = {
  requires: [],
  async send({ route, msg, notification, config, http }) {
    const r = await http(route.target, {
      source: config.productName,
      priority: msg.priority,
      title: msg.head,
      message: msg.body,
      where: msg.where || null,
      detail: msg.detail || null,
      device: { id: notification.deviceId ?? null, label: notification.deviceLabel ?? null },
      metric: notification.metric ?? null,
      value: notification.value ?? null,
      threshold: notification.threshold ?? null,
      url: msg.url,
      at: msg.at.toISOString(),
      id: notification.id ?? null,
    }, { headers: config.webhook?.headers || {} });
    return r.ok ? { ok: true, id: null } : { ok: false, error: r.error };
  },
};

const trim = (u) => String(u || '').replace(/\/+$/, '');
const authHeader = (svc) => (svc?.apiKey ? { 'X-Internal-Key': svc.apiKey } : {});

const dispatchers = { line, sms, teams, email, slack, discord, pagerduty, servicenow, webhook };
const CHANNELS = Object.keys(dispatchers);

module.exports = { dispatchers, CHANNELS, PRIORITY_COLOUR, PRIORITY_EMOJI, adaptiveCard, emailHtml };
