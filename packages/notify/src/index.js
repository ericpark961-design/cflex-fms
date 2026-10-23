// @cflex/notify — alarm delivery, as a library.
//
// WHY THIS EXISTS. The nine channel integrations work and have been in
// production, but they lived inside `backend/services/alarm-notifier.js`,
// which reads three database tables, imports the FMS schema's `alert` shape,
// and takes its endpoints from `process.env` at module load. None of that can
// be handed to another codebase, dropped into a container image, or tested
// without a database.
//
// So the delivery is here and the policy is not. This module:
//
//   · takes a `Notification` (not an FMS alert row) and a `Route`
//   · takes every endpoint, key and timeout as CONFIG, never from the
//     environment — the caller owns where secrets come from
//   · takes its HTTP client by INJECTION, so a proxy agent, a retry policy or
//     a test double all go in the same slot
//   · returns a result per attempt and throws nothing
//
// It does not know about tenants, mute windows, dedup history or dispatch
// logs. Those are the caller's, because they need a database and they differ
// between the managed portal and an on-premises install.
//
// ── On-premises (HAEA) notes, because two channels do not work there ──
//
//   SMS and LINE route through Sentinel Connect, a RingOn-internal service.
//   An air-gapped customer network cannot reach it, and the spec puts SMS on
//   the portal side for exactly that reason. Configure them only where the
//   service is reachable; `plan()` reports a channel that cannot run.
//
//   Email has TWO transports. Resend is an internet API; HAEA requires its own
//   SMTP relay. `email.transport: 'smtp' | 'resend'` picks one, and smtp takes
//   an injected sender so this module needs no mail dependency.
const { CHANNELS, dispatchers } = require('./channels');
const { formatMessage, SEV_RANK, severityAtLeast } = require('./message');
const { httpClient } = require('./http');

/**
 * @typedef {object} Notification
 * @property {'P1'|'P2'|'P3'|'P4'} priority
 * @property {string} title          what happened, one line
 * @property {string} [where]        site · room · rack
 * @property {string} [detail]       metric / value / threshold, already formatted
 * @property {string} [id]           caller's id for this event, echoed back
 * @property {string} [deviceId]
 * @property {string} [deviceLabel]
 * @property {string} [metric]
 * @property {number|string} [value]
 * @property {number|string} [threshold]
 * @property {string} [url]          deep link the message should offer
 * @property {Date|number} [at]
 */

/**
 * @typedef {object} Route
 * @property {string} channel        one of CHANNELS
 * @property {string} target         webhook URL, address, phone, routing key…
 * @property {'P1'|'P2'|'P3'|'P4'} [minPriority]  default 'P2'
 * @property {boolean} [enabled]     default true
 * @property {string} [label]        for logs
 */

const DEFAULTS = {
  timeoutMs: 10_000,
  // Where a message should point a human. Hard-coded to the hosted dashboard
  // in the original, which is wrong for an on-premises install.
  dashboardUrl: null,
  productName: 'C-Flex FMS',
  fromName: 'RingOn FMS',
};

/**
 * Which routes would run for this notification, and which cannot.
 *
 * Separate from send() so an installer can report what is configured without
 * delivering anything — `cflex-install verify` needs exactly this.
 *
 * @returns {{willSend: Route[], skipped: {route: Route, why: string}[]}}
 */
function plan(notification, routes = [], config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const willSend = [];
  const skipped = [];
  for (const r of routes) {
    if (r.enabled === false) { skipped.push({ route: r, why: 'disabled' }); continue; }
    if (!CHANNELS.includes(r.channel)) { skipped.push({ route: r, why: `unknown channel "${r.channel}"` }); continue; }
    if (!r.target) { skipped.push({ route: r, why: 'no target' }); continue; }
    if (!severityAtLeast(notification.priority, r.minPriority)) {
      skipped.push({ route: r, why: `priority ${notification.priority} below ${r.minPriority || 'P2'}` });
      continue;
    }
    const need = dispatchers[r.channel].requires || [];
    const missing = need.filter(k => !pick(cfg, k));
    if (missing.length) {
      // A channel that is routed but cannot run is the failure people spend
      // an afternoon on. Say so before anything is sent.
      skipped.push({ route: r, why: `config missing: ${missing.join(', ')}` });
      continue;
    }
    willSend.push(r);
  }
  return { willSend, skipped };
}

const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/**
 * Deliver to every route that applies.
 *
 * Never throws. Every route gets a result: `{ok, channel, target, id?, error?,
 * ms, dryRun?}`. Routes run in parallel — one slow webhook must not delay the
 * others, which is what a serial loop did.
 *
 * @param {Notification} notification
 * @param {Route[]} routes
 * @param {object} config
 * @param {object} [deps] {http, now, smtpSend}
 */
async function send(notification, routes = [], config = {}, deps = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const http = deps.http || httpClient({ timeoutMs: cfg.timeoutMs, proxy: cfg.proxy, ca: cfg.ca });
  const now = deps.now || (() => Date.now());
  const msg = formatMessage(notification, cfg);
  const { willSend, skipped } = plan(notification, routes, cfg);

  const results = await Promise.all(willSend.map(async (route) => {
    const t0 = now();
    try {
      const r = await dispatchers[route.channel].send({
        route, msg, notification, config: cfg, http, deps,
      });
      return { channel: route.channel, target: route.target, ms: now() - t0, ...r };
    } catch (e) {
      // A dispatcher that throws is a bug in the dispatcher, not a delivery
      // failure — but it must not take the other channels with it.
      return { ok: false, channel: route.channel, target: route.target, ms: now() - t0, error: `dispatcher threw: ${e.message}` };
    }
  }));

  return {
    notification: { id: notification.id ?? null, priority: notification.priority },
    sent: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
    skipped: skipped.map(s => ({ channel: s.route.channel, target: s.route.target, why: s.why })),
  };
}

/**
 * Send one channel a test message, for `cflex-install verify --send-test`.
 *
 * `deliver: false` checks configuration and reachability intent without
 * actually sending, which is what an installer wants by default.
 */
async function test(channel, target, config = {}, { deliver = false, ...deps } = {}) {
  const route = { channel, target, minPriority: 'P4' };
  const notification = {
    priority: 'P4',
    title: `${(config.productName || DEFAULTS.productName)} 연결 테스트 / connectivity test`,
    where: config.siteName || null,
    detail: 'This message confirms the channel is configured and reachable. No action required.',
    at: Date.now(),
  };
  const { willSend, skipped } = plan(notification, [route], config);
  if (!willSend.length) {
    return { ok: false, channel, checked: true, delivered: false, error: skipped[0]?.why || 'not sendable' };
  }
  if (!deliver) return { ok: true, channel, checked: true, delivered: false };
  const out = await send(notification, [route], config, deps);
  return { ...out.results[0], checked: true, delivered: true };
}

module.exports = {
  send, plan, test,
  formatMessage, severityAtLeast,
  CHANNELS, SEV_RANK, DEFAULTS,
  httpClient,
};
