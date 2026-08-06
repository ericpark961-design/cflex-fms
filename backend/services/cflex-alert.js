// services/cflex-alert.js — outbound SMS alerts via cflex-sms gateway on ucm VM.
//
// Task spec: CLAUDE_CODE_FMS_ALERT_TASK.md
//   - POST https://ucm.runless.co.uk/alert
//   - Header X-Alert-Token: <shared token from CFLEX_ALERT_TOKEN env>
//   - Body   { message, to? }
//   - 15s timeout, exponential backoff up to 3 retries on 5xx / network
//   - Dedupe by (site + category) with 10-minute cooldown
//   - Fire-and-forget from caller: never throws
const axios = require('axios');

const ALERT_URL   = process.env.CFLEX_ALERT_URL   || 'https://ucm.runless.co.uk/alert';
const ALERT_TOKEN = process.env.CFLEX_ALERT_TOKEN || '';
const COOLDOWN_MS = parseInt(process.env.CFLEX_ALERT_COOLDOWN_MS || '600000', 10); // 10 min

const SEV_HUMAN = { P1: 'CRITICAL', P2: 'HIGH', P3: 'MEDIUM', P4: 'LOW' };

// In-memory dedupe: key → lastSentAt (epoch ms). Cleared on process restart.
const _lastSent = new Map();
function _prune() {
  const cutoff = Date.now() - COOLDOWN_MS * 4;
  for (const [k, t] of _lastSent) if (t < cutoff) _lastSent.delete(k);
}

function _mask(token) {
  if (!token) return '(unset)';
  return token.length <= 8 ? '****' : token.slice(0, 4) + '…' + token.slice(-4);
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// POST with exponential backoff — retry on 5xx / network only. 4xx never retried.
async function _postWithRetry(payload) {
  const attempts = 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await axios.post(ALERT_URL, payload, {
        headers: { 'Content-Type': 'application/json', 'X-Alert-Token': ALERT_TOKEN },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, sid: r.data?.sid };
      if (r.status >= 400 && r.status < 500) {
        return { ok: false, status: r.status, error: r.data?.error || `http_${r.status}` };
      }
      lastErr = new Error(`http_${r.status}: ${JSON.stringify(r.data)?.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await _sleep(500 * Math.pow(2, i)); // 500ms → 1s → 2s
  }
  return { ok: false, status: 0, error: lastErr?.message || 'unknown' };
}

/**
 * Build the canonical message format:
 *   "[<SEVERITY>] <site> - <category> - <detail>"
 * @param {object} a - alert-shaped payload (priority, site, category, detail)
 */
function formatAlertMessage({ priority, site, category, detail }) {
  const sev = SEV_HUMAN[priority] || priority || 'INFO';
  const tail = [site, category, detail].filter(Boolean).join(' - ');
  return (tail ? `[${sev}] ${tail}` : `[${sev}]`).slice(0, 320);
}

/**
 * Send an FMS alert SMS via the cflex-sms gateway. Non-throwing.
 *
 * @param {string} message  - full body (caller should have formatted it, or use formatAlertMessage)
 * @param {object} opts
 * @param {string} [opts.to]         - E.164 recipient (gateway may default if omitted)
 * @param {string} [opts.dedupeKey]  - deduplication key (e.g. "Irvine-DC1|UPS"). Skipped inside cooldown.
 * @returns {Promise<{sent: boolean, reason?: string, sid?: string}>}
 */
async function sendFmsAlert(message, opts = {}) {
  const { to, dedupeKey } = opts;

  if (!ALERT_TOKEN) {
    console.warn('[cflex-alert] CFLEX_ALERT_TOKEN not set — alert not sent');
    return { sent: false, reason: 'no_token' };
  }
  if (!message || typeof message !== 'string') {
    return { sent: false, reason: 'no_message' };
  }

  if (dedupeKey) {
    _prune();
    const last = _lastSent.get(dedupeKey) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
      console.log('[cflex-alert] skipped', dedupeKey, '— cooldown');
      return { sent: false, reason: 'cooldown' };
    }
  }

  const payload = { message };
  if (to) payload.to = to;

  const r = await _postWithRetry(payload);
  if (r.ok) {
    if (dedupeKey) _lastSent.set(dedupeKey, Date.now());
    console.log('[cflex-alert] sent', dedupeKey || '(no-key)', 'sid=' + (r.sid || 'n/a'),
                'token=' + _mask(ALERT_TOKEN));
    return { sent: true, sid: r.sid };
  }
  console.error('[cflex-alert] fail', dedupeKey || '(no-key)',
                'status=' + r.status, 'err=' + r.error, 'token=' + _mask(ALERT_TOKEN));
  return { sent: false, reason: r.error };
}

module.exports = { sendFmsAlert, formatAlertMessage, _lastSent };
