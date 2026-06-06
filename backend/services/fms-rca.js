// services/fms-rca.js — AI root-cause analysis for P1 alarm tickets.
// Uses Claude Haiku 4.5 (fast, cheap). Gated by /opt/cflex-shared/ai-toggle.
const db = require('../config/database');
const { callAnthropic, RATES } = require('./claude-router.service');

let aiGate;
try { aiGate = require('/opt/cflex-shared/ai-toggle'); } catch { aiGate = { isEnabled: () => false }; }

const MODEL = process.env.FMS_RCA_MODEL || 'claude-haiku-4-5-20251001';

function collectContext(ticketId) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!ticket) return null;
  const numericId = parseInt(String(ticket.device_id || '').replace(/^ups-/, ''), 10);
  const device = numericId
    ? db.prepare('SELECT id, label, vendor, model, location, room, rack, criticality, ip FROM ups_devices WHERE id=?').get(numericId)
    : null;
  // Last 1h of metrics
  const metrics = numericId
    ? db.prepare(`SELECT ts, battery_pct, load_pct, temp_c, runtime_min, input_v, output_v, health_score
                  FROM ups_metrics WHERE device_id=? AND ts > ? ORDER BY ts ASC`)
        .all(numericId, Date.now() - 60 * 60 * 1000)
    : [];
  // Last 24h alarms on this device
  const recentAlerts = db.prepare(`SELECT priority, metric, message, value, threshold, received_at
                                   FROM alerts WHERE tenant_id=? AND device_id=? AND received_at > ?
                                   ORDER BY received_at DESC LIMIT 20`)
    .all(ticket.tenant_id, ticket.device_id, Date.now() - 24 * 3600 * 1000);
  return { ticket, device, metrics, recentAlerts };
}

function buildPrompt(ctx) {
  const { ticket, device, metrics, recentAlerts } = ctx;
  const m = metrics.slice(-12); // last ~12 points
  const metricSummary = m.length
    ? m.map(p => `${new Date(p.ts).toISOString().slice(11, 19)}  batt=${p.battery_pct ?? '—'}%  load=${p.load_pct ?? '—'}%  temp=${p.temp_c ?? '—'}°C  rt=${p.runtime_min ?? '—'}min  in=${p.input_v ?? '—'}V  out=${p.output_v ?? '—'}V`).join('\n')
    : '(no recent telemetry)';
  const alertHistory = recentAlerts.length
    ? recentAlerts.map(a => `${new Date(a.received_at).toISOString().slice(0, 19)}Z  [${a.priority}] ${a.metric}=${a.value}  thr=${a.threshold}  ${a.message}`).join('\n')
    : '(no prior alarms in 24h)';

  return `You are an FMS (Facility Monitoring System) reliability engineer. Analyze this UPS alarm and produce a concise root-cause analysis.

ALARM TICKET
  ticket_no:  ${ticket.ticket_no}
  priority:   ${ticket.priority}
  title:      ${ticket.title}
  metric:     ${ticket.alert_metric}
  value:      ${ticket.alert_value}
  threshold:  ${ticket.alert_threshold}

DEVICE
  label:      ${device?.label || ticket.device_label || ticket.device_id}
  vendor:     ${device?.vendor || '—'}    model: ${device?.model || '—'}
  location:   ${device?.location || '—'} / ${device?.room || '—'} / ${device?.rack || '—'}
  criticality:${device?.criticality || 'routine'}

RECENT TELEMETRY (last hour, oldest→newest)
${metricSummary}

ALARM HISTORY (last 24h, this device)
${alertHistory}

Respond with strictly valid JSON in this shape (no markdown fences):
{
  "summary": "1-2 sentence plain-language root cause hypothesis (Korean).",
  "actions": ["step 1 action (Korean)", "step 2", "step 3"],
  "confidence": 0.0 to 1.0,
  "category": "battery_aging|overload|thermal|grid|firmware|sensor_fault|unknown"
}

Rules:
- Korean output for summary and actions (the audience is Korean operators).
- Actions: 3-5 imperative, specific steps. Include verification step.
- Be concrete: cite numbers from the data when possible.
- If telemetry is insufficient, say so in summary and set confidence ≤ 0.4.`;
}

async function generateRcaForTicket(ticketId) {
  const ctx = collectContext(ticketId);
  if (!ctx) return { ok: false, error: 'ticket not found' };
  const t = ctx.ticket;

  // Don't regenerate if already present and recent (< 24h) unless explicit refresh
  // (caller passes force=true to bypass — for now, always regenerate on call)

  if (!aiGate.isEnabled()) {
    db.prepare('UPDATE tickets SET rca_error=?, rca_generated_at=? WHERE id=?')
      .run('AI kill-switch is OFF', Date.now(), ticketId);
    return { ok: false, error: 'AI kill-switch is OFF', skipped: true };
  }

  const prompt = buildPrompt(ctx);
  let parsed = null, raw = '', usage = null;
  try {
    const r = await callAnthropic({
      model: MODEL,
      system: 'You are a careful, data-driven FMS reliability engineer. Always respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
      temperature: 0.3,
    });
    raw = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    // Strip code fences if model added them despite instructions
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(clean);
    usage = r.usage;
  } catch (e) {
    const msg = e.message || String(e);
    db.prepare('UPDATE tickets SET rca_error=?, rca_generated_at=? WHERE id=?')
      .run(msg.slice(0, 500), Date.now(), ticketId);
    return { ok: false, error: msg, raw };
  }

  // Cost calc (per million tokens — RATES holds price/M)
  let costUsd = 0;
  const rate = RATES[MODEL];
  if (rate && usage) {
    costUsd = (usage.input_tokens || 0) / 1e6 * rate.in + (usage.output_tokens || 0) / 1e6 * rate.out;
  }

  const summary = String(parsed.summary || '').slice(0, 800);
  const actions = JSON.stringify(Array.isArray(parsed.actions) ? parsed.actions.slice(0, 8) : []);
  const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null;

  db.prepare(`UPDATE tickets
              SET rca_summary=?, rca_actions=?, rca_confidence=?, rca_model=?, rca_cost_usd=?,
                  rca_generated_at=?, rca_error=NULL
              WHERE id=?`)
    .run(summary, actions, confidence, MODEL, costUsd, Date.now(), ticketId);

  return {
    ok: true,
    rca: {
      summary, actions: JSON.parse(actions), confidence,
      category: parsed.category || 'unknown',
      model: MODEL, cost_usd: costUsd,
      generated_at: Date.now(),
    },
  };
}

module.exports = { generateRcaForTicket, collectContext };
