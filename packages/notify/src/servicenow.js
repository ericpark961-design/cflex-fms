// ServiceNow incident lifecycle: open, update, resolve.
//
// The `servicenow` channel opens an incident and returns its number — enough
// for a fire-and-forget route. An alarm has a lifetime, though (raise → update
// → clear), and the SOW wants the INC to follow it: one ticket per alarm,
// updated while it lasts, resolved when it clears. That needs the sys_id the
// caller stored at creation, which is why these take it as an argument and the
// channel does not.
//
// Same rules as the rest of the package: config in, http injected, no throw.
const { formatMessage } = require('./message');
const { httpClient } = require('./http');

const IMPACT = { P1: '1', P2: '2', P3: '3', P4: '3' };
const URGENCY = { P1: '1', P2: '2', P3: '3', P4: '3' };

// Out-of-box incident states. Instances customise these, so both are config.
const DEFAULT_RESOLVED_STATE = '6';
const DEFAULT_CLOSE_CODE = 'Solved Remotely (Permanently)';

const trim = (u) => String(u || '').replace(/\/+$/, '');

function clientFor(config, deps) {
  const sn = config.servicenow || {};
  if (!sn.instanceUrl || !sn.auth) return { error: 'config missing: servicenow.instanceUrl, servicenow.auth' };
  const http = deps.http || httpClient({ timeoutMs: config.timeoutMs || 10_000 });
  const table = sn.table || 'incident';
  const base = `${trim(sn.instanceUrl)}/api/now/table/${table}`;
  const headers = { Authorization: sn.auth, Accept: 'application/json' };
  return { http, base, headers, sn };
}

const out = (r) => {
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const rec = r.json?.result || {};
  return { ok: true, sys_id: rec.sys_id ?? null, number: rec.number ?? null };
};

/**
 * Open an incident for a notification.
 * @returns {Promise<{ok, sys_id?, number?, error?}>}
 */
async function createIncident(notification, config = {}, deps = {}) {
  const c = clientFor(config, deps);
  if (c.error) return { ok: false, error: c.error };
  const msg = formatMessage(notification, config);
  try {
    return out(await c.http(c.base, {
      short_description: [msg.head, msg.body].filter(Boolean).join(' — ').slice(0, 160),
      description: [msg.plain(), msg.url ? `\nDashboard: ${msg.url}` : ''].join(''),
      impact: IMPACT[msg.priority] || '3',
      urgency: URGENCY[msg.priority] || '3',
      category: c.sn.category || 'Infrastructure',
      ...(c.sn.assignmentGroup ? { assignment_group: c.sn.assignmentGroup } : {}),
      ...(c.sn.callerId ? { caller_id: c.sn.callerId } : {}),
      cmdb_ci: notification.deviceLabel || undefined,
      correlation_id: notification.dedupKey || notification.id || undefined,
      correlation_display: config.productName || 'C-Flex FMS',
    }, { headers: c.headers }));
  } catch (e) {
    return { ok: false, error: `servicenow threw: ${e.message}` };
  }
}

/**
 * Add a work note to an open incident, and move impact/urgency when the
 * priority changed.
 */
async function updateIncident(sysId, { note, priority } = {}, config = {}, deps = {}) {
  const c = clientFor(config, deps);
  if (c.error) return { ok: false, error: c.error };
  if (!sysId) return { ok: false, error: 'no sys_id' };
  const body = { work_notes: String(note || '').slice(0, 4000) };
  if (priority && IMPACT[priority]) Object.assign(body, { impact: IMPACT[priority], urgency: URGENCY[priority] });
  try {
    return out(await c.http(`${c.base}/${encodeURIComponent(sysId)}`, body, { method: 'PATCH', headers: c.headers }));
  } catch (e) {
    return { ok: false, error: `servicenow threw: ${e.message}` };
  }
}

/** Resolve an incident because its alarm cleared. */
async function resolveIncident(sysId, { note } = {}, config = {}, deps = {}) {
  const c = clientFor(config, deps);
  if (c.error) return { ok: false, error: c.error };
  if (!sysId) return { ok: false, error: 'no sys_id' };
  try {
    return out(await c.http(`${c.base}/${encodeURIComponent(sysId)}`, {
      state: String(c.sn.resolvedState || DEFAULT_RESOLVED_STATE),
      close_code: c.sn.closeCode || DEFAULT_CLOSE_CODE,
      close_notes: String(note || 'Alarm cleared').slice(0, 4000),
    }, { method: 'PATCH', headers: c.headers }));
  } catch (e) {
    return { ok: false, error: `servicenow threw: ${e.message}` };
  }
}

module.exports = { createIncident, updateIncident, resolveIncident, IMPACT, URGENCY, DEFAULT_RESOLVED_STATE, DEFAULT_CLOSE_CODE };
