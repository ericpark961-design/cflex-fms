// The one HTTP call every dispatcher makes, injectable.
//
// `alarm-notifier` imported axios at module scope, which made three things
// impossible: testing without a network, routing through a customer's HTTPS
// proxy (spec §2.3 rule D — HAEA requires it for Teams and the portal), and
// trusting a corporate CA. All three are now arguments.
//
// Implemented on Node's own fetch so the package has no runtime dependency.
// A caller that wants axios, retries or a proxy agent passes its own.

/**
 * @param {object} opts
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.proxy]  http://host:port — informational here; a real
 *   proxy needs an agent, which the caller supplies via `opts.agent`
 * @param {object} [opts.agent]  an undici Dispatcher / https.Agent
 */
function httpClient({ timeoutMs = 10_000, proxy = null, agent = null, ca = null } = {}) {
  return async function post(url, body, { headers = {}, method = 'POST', timeout = timeoutMs } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const isForm = typeof body === 'string';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
        body: body == null ? undefined : (isForm ? body : JSON.stringify(body)),
        signal: ac.signal,
        ...(agent ? { dispatcher: agent } : {}),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON — Slack answers 'ok' */ }
      if (!res.ok) {
        // The body is where every one of these APIs puts the actual reason, so
        // it travels with the status rather than being thrown away.
        const reason = (json && (json.error?.message || json.message || json.error)) || text.slice(0, 200) || res.statusText;
        return { ok: false, status: res.status, error: `HTTP ${res.status}: ${reason}`, json, text };
      }
      return { ok: true, status: res.status, json, text };
    } catch (e) {
      const why = e.name === 'AbortError' ? `timeout after ${timeout}ms` : e.message;
      return { ok: false, status: 0, error: why };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { httpClient };
