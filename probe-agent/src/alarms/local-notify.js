// alarms/local-notify.js — HAEA-internal notification (spec 01 §3 local
// notify; contract §3.4 `local_notified`).
//
// The Probe tells HAEA itself — its SMTP relay, a Teams webhook through its
// proxy, its ServiceNow — and reports what it told them in the event's
// `local_notified`, which the Portal uses to avoid sending the same thing
// twice. So `local_notified` must say what was *delivered*, not what was
// configured: a relay that refused the message is `email:false`, and the
// Portal is then free to send its own.
//
// Per alarm:
//   raise   e-mail + Teams + ServiceNow incident (alarm_id → INC stored)
//   update  ServiceNow work note on the stored INC; no e-mail
//   clear   e-mail + Teams when `notify_clear`; ServiceNow incident resolved
// A maintenance-suppressed event sends nothing — except that an INC already
// open is still resolved on clear, so tickets do not outlive their alarms.
//
// Delivery is `packages/notify`; this file is policy only.
const fs = require('fs');
const notify = require('../../../packages/notify/src');
const { jsonStore } = require('./store');

const RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
const atLeast = (sev, min) => (RANK[sev] || 9) <= (RANK[min] || RANK.P2);

const POLICY = {
  local_email: true, local_teams: true, local_itsm: true,
  email_min: 'P2', teams_min: 'P2', itsm_min: 'P2',
  notify_clear: true,
};

/** A secret is either inline or, preferably, in a file of its own (systemd credential, 0600). */
function secret(obj, key) {
  if (!obj) return undefined;
  if (obj[`${key}File`]) return fs.readFileSync(obj[`${key}File`], 'utf8').replace(/\r?\n$/, '');
  return obj[key];
}

/** The notify package's http slot, over the Probe's transport for https (proxy, CA), fetch otherwise. */
function httpVia({ request, proxy, noProxy, ca, timeoutMs = 10_000 }) {
  const plain = notify.httpClient({ timeoutMs });
  return async (url, body, { headers = {}, method = 'POST', timeout = timeoutMs } = {}) => {
    if (!request || !/^https:/i.test(url)) return plain(url, body, { headers, method, timeout });
    const buf = body == null ? null : Buffer.from(JSON.stringify(body));
    try {
      const r = await request({
        method, url, body: buf, timeoutMs: timeout, proxy, noProxy,
        // Never the Portal's client certificate: that identity is for the Portal.
        tls: { ca },
        headers: { 'Content-Type': 'application/json', ...(buf ? { 'Content-Length': String(buf.length) } : {}), ...headers },
      });
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, json: r.json, text: r.body };
      const reason = (r.json && (r.json.error?.message || r.json.message || r.json.error)) || String(r.body || '').slice(0, 200);
      return { ok: false, status: r.status, error: `HTTP ${r.status}: ${reason}`, json: r.json, text: r.body };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  };
}

/**
 * @param {object} o
 * @param {object} o.config     notify.json (see README §로컬 알림)
 * @param {object} [o.store]    alarm_id → {number, sys_id, …}; default file at config.itsmStorePath, else memory
 * @param {object} [o.deps]     {http, smtpSend} — injected for tests
 * @param {Function} [o.request] transport.request, for https through the proxy
 * @param {object} [o.log]
 */
function createLocalNotifier({ config = {}, store, deps = {}, request, proxy, noProxy, ca, log = console } = {}) {
  const policy = { ...POLICY, ...(config.policy || {}) };
  const itsm = store || jsonStore(config.itsmStorePath || null);
  const http = deps.http || httpVia({ request, proxy, noProxy, ca, timeoutMs: config.timeoutMs });
  const stats = { email_ok: 0, email_fail: 0, teams_ok: 0, teams_fail: 0, itsm_ok: 0, itsm_fail: 0, suppressed: 0 };

  const base = {
    productName: config.productName || 'C-Flex FMS',
    siteName: config.siteName || null,
    dashboardUrl: config.dashboardUrl || null,
    timeoutMs: config.timeoutMs || 10_000,
  };

  let smtpSend = deps.smtpSend || null;
  if (!smtpSend && config.email?.smtp?.host) {
    const s = config.email.smtp;
    smtpSend = notify.smtpSender({
      host: s.host, port: s.port, secure: !!s.secure, starttls: s.starttls, heloName: s.heloName,
      rejectUnauthorized: s.rejectUnauthorized, ca: s.caFile ? fs.readFileSync(s.caFile, 'utf8') : undefined,
      auth: s.auth?.user ? { user: s.auth.user, pass: secret(s.auth, 'pass') } : undefined,
      timeoutMs: s.timeoutMs || base.timeoutMs,
    });
  }

  function snConfig() {
    const sn = config.servicenow;
    if (!sn?.instanceUrl) return null;
    const auth = sn.user
      ? 'Basic ' + Buffer.from(`${sn.user}:${secret(sn, 'pass') || ''}`).toString('base64')
      : secret(sn, 'auth');
    return { ...base, servicenow: { ...sn, auth } };
  }

  const recipients = () => [].concat(config.email?.to || []).filter(Boolean);
  const channels = {
    email: () => policy.local_email && !!smtpSend && recipients().length > 0,
    teams: () => policy.local_teams && !!config.teams?.webhook,
    itsm: () => policy.local_itsm && !!config.servicenow?.instanceUrl,
  };
  const enabled = () => config.enabled !== false && (channels.email() || channels.teams() || channels.itsm());

  /** contract event + engine alarm → the package's Notification. */
  function notification(ev, alarm, clear) {
    return {
      priority: ev.severity,
      title: clear ? `Cleared: ${alarm?.title || ev.code}` : ev.title,
      where: [base.siteName, ev.site_id].filter(Boolean).join(' · ') || null,
      deviceId: ev.device_id || undefined,
      // The subject line is "[P1] <label> — <where>"; a clear has to be told
      // apart from a raise there, not only in the body.
      deviceLabel: clear ? `CLEARED ${alarm?.label || ev.code}` : (alarm?.label || undefined),
      metric: ev.code,
      value: ev.detail?.value,
      threshold: ev.detail?.threshold,
      id: ev.alarm_id,
      dedupKey: ev.alarm_id,
      at: Date.parse(ev.ts),
    };
  }

  async function sendEmail(n, min) {
    const routes = recipients().map(to => ({ channel: 'email', target: to, minPriority: min }));
    const r = await notify.send(n, routes, { ...base, email: { transport: 'smtp', from: config.email.from } }, { smtpSend, http });
    const ok = r.sent > 0 && r.failed === 0;
    stats[ok ? 'email_ok' : 'email_fail']++;
    if (r.failed) log.warn(`[notify] e-mail: ${r.results.filter(x => !x.ok).map(x => x.error).join('; ').slice(0, 300)}`);
    return ok;
  }

  async function sendTeams(n, min) {
    const r = await notify.send(n, [{ channel: 'teams', target: config.teams.webhook, minPriority: min }], base, { http });
    const ok = r.sent === 1;
    stats[ok ? 'teams_ok' : 'teams_fail']++;
    if (r.failed) log.warn(`[notify] teams: ${r.results[0]?.error}`);
    return ok;
  }

  async function itsmFor(ev, alarm, kind) {
    const cfg = snConfig();
    const rec = itsm.get(ev.alarm_id);
    if (kind === 'raise') {
      if (rec?.number) return rec.number;
      const r = await notify.servicenow.create(notification(ev, alarm, false), cfg, { http });
      if (!r.ok) { stats.itsm_fail++; log.warn(`[notify] servicenow create: ${r.error}`); return null; }
      stats.itsm_ok++;
      itsm.set(ev.alarm_id, { number: r.number, sys_id: r.sys_id, code: ev.code, device_id: ev.device_id, opened: ev.ts });
      return r.number;
    }
    if (!rec?.sys_id) return null;
    const r = kind === 'clear'
      ? await notify.servicenow.resolve(rec.sys_id, { note: `${base.productName}: ${ev.title} (${ev.ts})` }, cfg, { http })
      : await notify.servicenow.update(rec.sys_id, { note: `${base.productName}: ${ev.title} (${ev.ts})`, priority: ev.severity }, cfg, { http });
    if (!r.ok) { stats.itsm_fail++; log.warn(`[notify] servicenow ${kind}: ${r.error}`); }
    else {
      stats.itsm_ok++;
      itsm.patch(ev.alarm_id, kind === 'clear' ? { resolved: ev.ts } : { updated: ev.ts });
    }
    return rec.number;
  }

  /**
   * Notify for one engine item and return the contract's `local_notified`,
   * or null when local notification is not configured at all (the field is
   * then left out, and the Portal treats the alarm as not yet notified).
   *
   * @param {{event, suppressed, alarm, notifyAs?}} item
   */
  async function handle(item) {
    if (!enabled()) return null;
    const ev = item.event;
    const kind = item.notifyAs || { alarm_raise: 'raise', alarm_update: 'update', alarm_clear: 'clear' }[ev.kind];
    const res = { email: false, teams: false, itsm: null };
    if (!kind) return res;
    if (item.suppressed) {
      stats.suppressed++;
      // A ticket opened before the window still closes with its alarm.
      if (kind === 'clear' && channels.itsm()) res.itsm = await itsmFor(ev, item.alarm, 'clear');
      return res;
    }
    const clear = kind === 'clear';
    const n = notification(ev, item.alarm, clear);
    const jobs = [];
    if ((kind === 'raise' || (clear && policy.notify_clear)) && channels.email() && atLeast(ev.severity, policy.email_min)) {
      jobs.push(sendEmail(n, policy.email_min).then(ok => { res.email = ok; }));
    }
    if ((kind === 'raise' || (clear && policy.notify_clear)) && channels.teams() && atLeast(ev.severity, policy.teams_min)) {
      jobs.push(sendTeams(n, policy.teams_min).then(ok => { res.teams = ok; }));
    }
    if (channels.itsm() && (kind !== 'raise' || atLeast(ev.severity, policy.itsm_min))) {
      jobs.push(itsmFor(ev, item.alarm, kind).then(num => { res.itsm = num || null; }));
    }
    await Promise.all(jobs);
    return res;
  }

  /**
   * The SOW acceptance test ticket: open an INC, add a work note, resolve it.
   * Nothing is stored against an alarm. Returns what happened at each step.
   */
  async function testTicket({ resolve = true } = {}) {
    const cfg = snConfig();
    if (!cfg) return { ok: false, error: 'servicenow.instanceUrl not configured' };
    const n = {
      priority: 'P4',
      title: `${base.productName} ServiceNow 연동 테스트 티켓 / integration test ticket`,
      where: base.siteName,
      detail: 'Created by cflex-test-ticket to confirm ITSM eBonding. No action required; it resolves itself.',
      id: `test-${new Date().toISOString()}`,
      at: Date.now(),
    };
    const c = await notify.servicenow.create(n, cfg, { http });
    if (!c.ok) return { ok: false, step: 'create', error: c.error };
    const out = { ok: true, number: c.number, sys_id: c.sys_id, updated: false, resolved: false };
    const u = await notify.servicenow.update(c.sys_id, { note: 'C-Flex FMS test: update step' }, cfg, { http });
    out.updated = u.ok;
    if (!u.ok) return { ...out, ok: false, step: 'update', error: u.error };
    if (resolve) {
      const r = await notify.servicenow.resolve(c.sys_id, { note: 'C-Flex FMS test: resolved automatically' }, cfg, { http });
      out.resolved = r.ok;
      if (!r.ok) return { ...out, ok: false, step: 'resolve', error: r.error };
    }
    return out;
  }

  return { handle, testTicket, enabled, stats: () => ({ ...stats }), itsm, policy };
}

/** notify.json, refusing a file others can read when it holds secrets inline. */
function loadNotifyConfig(file, log = console) {
  if (!file) return null;
  const st = fs.statSync(file);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if ((st.mode & 0o077) && /"(pass|auth)"\s*:/.test(fs.readFileSync(file, 'utf8'))) {
    log.warn(`[notify] ${file} holds credentials and is readable beyond its owner — chmod 600`);
  }
  return cfg;
}

module.exports = { createLocalNotifier, loadNotifyConfig, httpVia, POLICY };
