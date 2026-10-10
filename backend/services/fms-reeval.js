// Re-evaluation queue — v5 §2, §3.3.
//
// "증거가 바뀌면 다시 생각한다" is the point of the loop, but taken literally it
// is also a way to spend money fast: a flapping device, a chatty engineer, or a
// burst of control results would each fire a model call. So every trigger goes
// through here, where a 60-second debounce coalesces a burst into one call and a
// per-incident hourly cap stops a pathological incident from looping.
//
// In-process state: the API is a single node process per host, and losing the
// queue on restart is harmless — the next trigger re-queues.
const triage = require('./fms-triage');

const DEBOUNCE_MS = 60 * 1000;
const MAX_PER_HOUR = 6;
const HOUR_MS = 3600 * 1000;

const TRIGGERS = new Set(['metrics', 'adjacent_alarm', 'action_result', 'engineer_note', 'state_change']);

// incidentId -> { timer, reasons:Set, stamps:number[] }
const pending = new Map();

function history(id) {
  const e = pending.get(id);
  return e ? e.stamps : [];
}

/** How many re-evaluations ran for this incident in the last hour. */
function recentCount(id) {
  const cutoff = Date.now() - HOUR_MS;
  const stamps = history(id).filter(t => t > cutoff);
  const e = pending.get(id);
  if (e) e.stamps = stamps;
  return stamps.length;
}

/**
 * Queue a re-evaluation. Returns what it decided, so a caller (and the tests)
 * can see a drop rather than guessing why nothing happened.
 * @returns {{queued:boolean, reason?:string, in_ms?:number}}
 */
function queue(db, incidentId, trigger, opts = {}) {
  if (!TRIGGERS.has(trigger)) return { queued: false, reason: `unknown trigger: ${trigger}` };
  const id = Number(incidentId);
  if (!Number.isFinite(id)) return { queued: false, reason: 'bad incident id' };

  if (recentCount(id) >= MAX_PER_HOUR) {
    return { queued: false, reason: `시간당 재평가 상한 ${MAX_PER_HOUR}회 도달` };
  }

  let e = pending.get(id);
  if (!e) { e = { timer: null, reasons: new Set(), stamps: [] }; pending.set(id, e); }
  e.reasons.add(trigger);

  // A burst collapses into the single call at the end of the window: the timer
  // is deliberately NOT reset by later triggers, or a steady stream of events
  // would postpone the re-evaluation forever.
  if (e.timer) return { queued: true, reason: 'coalesced', in_ms: DEBOUNCE_MS };

  const delay = opts.immediate ? 0 : DEBOUNCE_MS;
  e.timer = setTimeout(() => {
    const reasons = Array.from(e.reasons);
    e.timer = null; e.reasons.clear();
    e.stamps.push(Date.now());
    Promise.resolve(triage.triageIncident(db, id, opts.deps || {}))
      .then(r => console.log('[fms-reeval]', id, reasons.join('+'), r?.ok ? r.source : ('ERR ' + r?.error)))
      .catch(err => console.error('[fms-reeval]', id, err.message));
  }, delay);
  if (e.timer.unref) e.timer.unref();   // never hold the process open
  return { queued: true, in_ms: delay };
}

/** Test/shutdown helper: drop every pending timer. */
function reset() {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear();
}

module.exports = { queue, reset, recentCount, DEBOUNCE_MS, MAX_PER_HOUR, TRIGGERS };
