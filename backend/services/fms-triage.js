// AI triage for one incident — v5 §2, §3.2, §3.3.
//
// An alarm is not a row in a table; it is the start of a loop. This service is
// the first step of that loop: it collects what is knowable about the incident,
// asks Claude for hypotheses with the evidence each one rests on, validates the
// answer against the fixed contract, and stores it on the incident so the
// workbench reads one row.
//
// Three rules shape the code:
//  1. The card is never empty. Kill-switch off, budget spent, API error, or a
//     reply that fails validation all fall through to rulesTriage().
//  2. No claim without evidence. A hypothesis whose evidence_ids do not resolve
//     to collected evidence is dropped, not displayed with a confidence number.
//  3. Reuse the existing AI path. callAnthropic + /opt/cflex-shared/ai-toggle,
//     as fms-rca.js does. No new SDK, no new key.
//
// db is passed in rather than required, so the tests run against a scratch
// SQLite file (same convention as fms-topology.js).
const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, '..', 'triage', 'rules.json');

// Budget caps (v5 §2). Breaching either falls back to rules and says so.
const CAP_INCIDENT_USD = 0.50;
const CAP_TENANT_USD = 20.00;
const DAY_MS = 24 * 3600 * 1000;

const MODEL = process.env.FMS_TRIAGE_MODEL || 'claude-haiku-4-5-20251001';
const CONTEXT_WINDOW_MS = 2 * 3600 * 1000;   // ±2h of metrics (v5 §1.3)
const ADJACENT_WINDOW_MS = 10 * 60 * 1000;   // ±10min for neighbouring alarms

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
const str = (v, n = 400) => (v == null ? null : String(v).slice(0, n));

// ── context ─────────────────────────────────────────────────────────

/**
 * Everything the triage prompt is allowed to see. Nothing here is a credential:
 * ups_devices.snmp_community and friends are never selected.
 */
function collectContext(db, incidentId) {
  const inc = db.prepare(`SELECT id, tenant_id, ticket_no, site, device_id, device_label, priority,
                                 severity, cbu, title, description, status, alert_metric, alert_value,
                                 alert_threshold, created_at, dedup_key
                          FROM tickets WHERE id=?`).get(incidentId);
  if (!inc) return null;

  const at = inc.created_at || Date.now();
  const metric = inc.alert_metric || null;
  // alerts.device_id is 'ups-<n>'; ups_devices.id is <n>.
  const devNum = parseInt(String(inc.device_id || '').replace(/^ups-/i, ''), 10);
  const device = Number.isFinite(devNum)
    ? db.prepare(`SELECT id, label, vendor, model, location, room, rack, criticality, status,
                         last_polled, battery_pct, load_pct, temp_c, runtime_min, input_v, output_v
                  FROM ups_devices WHERE id=?`).get(devNum)
    : null;

  const thresholds = Number.isFinite(devNum)
    ? db.prepare('SELECT * FROM ups_thresholds WHERE device_id=?').get(devNum)
    : null;

  // ±2h of metrics for the alarming metric, summarised rather than dumped: the
  // prompt gets shape (min/max/first/last/trend), the workbench chart gets rows.
  let metrics = [];
  if (Number.isFinite(devNum)) {
    metrics = db.prepare(`SELECT ts, battery_pct, load_pct, temp_c, runtime_min, input_v, output_v, status
                          FROM ups_metrics WHERE device_id=? AND ts BETWEEN ? AND ?
                          ORDER BY ts`).all(devNum, at - CONTEXT_WINDOW_MS, at + CONTEXT_WINDOW_MS);
  }

  // Other alarms within ±10 min — the signal that separates "this device" from
  // "this room" or "this circuit".
  const adjacent = db.prepare(`SELECT id, device_id, priority, metric, message, value, threshold, received_at
                               FROM alerts
                               WHERE tenant_id=? AND received_at BETWEEN ? AND ?
                                 AND (device_id IS NOT ? OR metric IS NOT ?)
                               ORDER BY received_at LIMIT 20`)
    .all(inc.tenant_id, at - ADJACENT_WINDOW_MS, at + ADJACENT_WINDOW_MS, inc.device_id, metric);

  // Power chain, when the v3 ledger knows this device.
  let chain = [];
  try {
    const topo = require('./fms-topology');
    if (Number.isFinite(devNum) && typeof topo.powerChainForDevice === 'function') {
      chain = topo.powerChainForDevice(db, inc.tenant_id, devNum)?.chain || [];
    }
  } catch { /* ledger not deployed — chain stays empty, evidence simply omits it */ }

  const controlLog = db.prepare(`SELECT action, ok, error, user_email, executed_at
                                 FROM fms_control_log WHERE tenant_id=? AND device_id=?
                                 ORDER BY executed_at DESC LIMIT 5`)
    .all(inc.tenant_id, inc.device_id);

  const mutes = db.prepare(`SELECT metric, muted_until, muted_by FROM fms_alarm_mutes
                            WHERE tenant_id=? AND device_id=? AND muted_until > ?`)
    .all(inc.tenant_id, inc.device_id, Date.now());

  // Memory (v5 §2): what a human previously confirmed for this device+metric.
  let priors = [];
  try {
    priors = db.prepare(`SELECT cause, COUNT(*) n FROM fms_triage_feedback
                         WHERE tenant_id=? AND outcome='confirmed'
                           AND (device_id=? OR metric=?)
                         GROUP BY cause ORDER BY n DESC LIMIT 3`)
      .all(inc.tenant_id, inc.device_id, metric);
  } catch { /* table absent before 005 */ }

  return { incident: inc, device, thresholds, metrics, adjacent, chain, controlLog, mutes, priors, at, metric };
}

/**
 * Turn the context into the evidence list the hypotheses must cite. Built in
 * code, not by the model, so an id either refers to something real or does not
 * exist. Shapes follow v5 §3.2.
 */
function buildEvidence(ctx) {
  const ev = [];
  const add = (kind, label, ref) => { ev.push({ id: `e${ev.length + 1}`, kind, label, ref: ref || null }); return ev[ev.length - 1].id; };
  const m = ctx.metric;

  // The alarming metric's own trajectory.
  const series = ctx.metrics.map(r => ({ ts: r.ts, v: num(r[m]) })).filter(r => r.v != null);
  if (series.length >= 2) {
    const first = series[0], last = series[series.length - 1];
    const lo = series.reduce((a, b) => (b.v < a.v ? b : a));
    const hi = series.reduce((a, b) => (b.v > a.v ? b : a));
    add('metric', `${m} ${first.v} → ${last.v} (${series.length}점, 최저 ${lo.v} / 최고 ${hi.v})`,
      { metric: m, from: first.ts, to: last.ts });
  } else if (ctx.incident.alert_value != null) {
    add('metric', `${m} ${ctx.incident.alert_value} (임계 ${ctx.incident.alert_threshold ?? '—'}) · 추세 데이터 없음`,
      { metric: m, from: ctx.at, to: ctx.at });
  }

  // Did anything else break at the same moment?
  const sameRoom = ctx.adjacent.filter(a => a.received_at >= ctx.at - ADJACENT_WINDOW_MS);
  if (sameRoom.length) {
    add('alarm', `±10분 내 다른 알람 ${sameRoom.length}건: ${sameRoom.slice(0, 3).map(a => `${a.device_id} ${a.metric}`).join(', ')}`,
      { alarm_ids: sameRoom.map(a => a.id) });
  }

  if (ctx.chain.length) {
    add('chain', `전원 체인: ${ctx.chain.map(c => c.name).join(' → ')}`, { chain: ctx.chain.map(c => c.name) });
  }

  if (ctx.controlLog.length) {
    const c = ctx.controlLog[0];
    add('log', `최근 원격 조치: ${c.action} ${c.ok ? '성공' : '실패'} (${c.error || '—'})`, { action: c.action, at: c.executed_at });
  }

  if (ctx.mutes.length) {
    add('log', `점검모드: ${ctx.mutes.map(x => x.metric || '전체').join(', ')}`, { mutes: ctx.mutes.length });
  }

  if (ctx.priors.length) {
    add('history', `과거 확정 원인: ${ctx.priors.map(p => `${p.cause} (${p.n}회)`).join(' · ')}`,
      { causes: ctx.priors.map(p => p.cause) });
  }

  if (ctx.device?.last_polled) {
    const ageMin = Math.round((Date.now() - ctx.device.last_polled) / 60000);
    add('metric', `마지막 폴링 ${ageMin}분 전 (상태 ${ctx.device.status || '—'})`, { last_polled: ctx.device.last_polled });
  }

  return ev;
}

// ── validation (the frontend contract) ──────────────────────────────

const ACTION_TYPES = new Set(['remote', 'onsite', 'monitor']);
const RISKS = new Set(['low', 'med', 'high']);
const OPS = new Set(['>=', '<=', '>', '<', '==', '!=']);

/**
 * Validate and normalise a triage object against v5 §3.2. Returns
 * { ok, triage, dropped[] } — `dropped` names what was discarded and why, so a
 * model that invents evidence shows up in the log instead of on the screen.
 */
function validateTriage(obj, evidence) {
  const dropped = [];
  if (!obj || typeof obj !== 'object') return { ok: false, dropped: ['not an object'] };

  const evIds = new Set((evidence || []).map(e => e.id));

  const hypotheses = [];
  for (const h of Array.isArray(obj.hypotheses) ? obj.hypotheses : []) {
    const ids = (Array.isArray(h?.evidence_ids) ? h.evidence_ids : []).filter(id => evIds.has(id));
    if (!h?.cause) { dropped.push('hypothesis without cause'); continue; }
    // v5 §2: no claim without evidence. A confidence number on an uncited
    // hypothesis is exactly what this rule exists to stop.
    if (!ids.length) { dropped.push(`hypothesis "${String(h.cause).slice(0, 40)}" cited no known evidence`); continue; }
    hypotheses.push({
      id: str(h.id, 16) || `h${hypotheses.length + 1}`,
      cause: str(h.cause, 300),
      confidence: clamp01(h.confidence),
      evidence_ids: ids.slice(0, 6),
    });
    if (hypotheses.length >= 3) break;
  }
  if (!hypotheses.length) return { ok: false, dropped: dropped.concat('no hypothesis survived validation') };

  const actions = [];
  for (const a of Array.isArray(obj.actions) ? obj.actions : []) {
    if (!a?.title) { dropped.push('action without title'); continue; }
    actions.push({
      id: str(a.id, 16) || `a${actions.length + 1}`,
      type: ACTION_TYPES.has(a.type) ? a.type : 'monitor',
      title: str(a.title, 200),
      steps: (Array.isArray(a.steps) ? a.steps : []).slice(0, 8).map(s => str(s, 300)).filter(Boolean),
      risk: RISKS.has(a.risk) ? a.risk : 'low',
      control_action: str(a.control_action, 40),
    });
    if (actions.length >= 6) break;
  }

  const d = obj.dispatch && typeof obj.dispatch === 'object' ? obj.dispatch : {};
  const dispatch = {
    needed: !!d.needed,
    skill: str(d.skill, 60),
    urgency: str(d.urgency, 20),
    eta_min: num(d.eta_min),
    reason: str(d.reason, 300),
  };

  let verify = null;
  if (obj.verify && typeof obj.verify === 'object' && obj.verify.metric && OPS.has(obj.verify.op)) {
    verify = {
      metric: str(obj.verify.metric, 40),
      op: obj.verify.op,
      value: num(obj.verify.value),
      window_min: num(obj.verify.window_min) || 30,
    };
    if (verify.value == null) { verify = null; dropped.push('verify had no numeric value'); }
  }

  return {
    ok: true,
    dropped,
    triage: {
      version: 1,
      source: obj.source === 'rules' ? 'rules' : 'ai',
      model: str(obj.model, 60),
      generated_at: num(obj.generated_at) || Date.now(),
      summary: str(obj.summary, 500) || '',
      hypotheses, actions, dispatch,
      evidence: evidence || [],
      verify,
    },
  };
}

// ── rule fallback ───────────────────────────────────────────────────

function loadRules() {
  // Re-read per call so Eric can edit rules.json without a restart (v5 §3.3).
  try { return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')); } catch { return { rules: [], default: null }; }
}

function matchRule(rules, metric, message) {
  const m = String(metric || '').toLowerCase();
  const text = `${m} ${String(message || '').toLowerCase()}`;
  for (const r of rules.rules || []) {
    if (r.metric && m === String(r.metric).toLowerCase()) return r;
  }
  for (const r of rules.rules || []) {
    if (r.match && new RegExp(r.match, 'i').test(text)) return r;
  }
  return rules.default || null;
}

/**
 * Deterministic triage. Hypotheses are bound to real evidence by kind, so the
 * "no claim without evidence" rule holds here too: a rule hypothesis whose
 * evidence kinds were not collected is dropped exactly like a model's.
 */
function rulesTriage(ctx, evidence, reason) {
  const rules = loadRules();
  const rule = matchRule(rules, ctx.metric, ctx.incident?.message || ctx.incident?.title);
  if (!rule) return null;

  const byKind = new Map();
  for (const e of evidence) { if (!byKind.has(e.kind)) byKind.set(e.kind, []); byKind.get(e.kind).push(e.id); }

  const hypotheses = (rule.hypotheses || []).map(h => ({
    ...h,
    evidence_ids: (h.evidence_kinds || []).flatMap(k => byKind.get(k) || []).slice(0, 4),
  }));

  const out = validateTriage({
    source: 'rules',
    model: null,
    summary: rule.summary,
    hypotheses,
    actions: rule.actions,
    dispatch: rule.dispatch,
    verify: rule.verify,
    generated_at: Date.now(),
  }, evidence);

  if (!out.ok) return null;
  out.triage.source = 'rules';
  out.triage.fallback_reason = reason || null;
  return out.triage;
}

// ── budget ──────────────────────────────────────────────────────────

function spentUsd(db, { tenantId, incidentId }) {
  const since = Date.now() - DAY_MS;
  const q = (sql, ...p) => { try { return db.prepare(sql).get(...p)?.s || 0; } catch { return 0; } };
  return {
    incident: incidentId ? q('SELECT SUM(cost_usd) s FROM fms_ai_log WHERE incident_id=? AND created_at > ?', incidentId, since) : 0,
    tenant: q('SELECT SUM(cost_usd) s FROM fms_ai_log WHERE tenant_id=? AND created_at > ?', tenantId, since),
  };
}

function budgetBlock(db, ctx) {
  const s = spentUsd(db, { tenantId: ctx.incident.tenant_id, incidentId: ctx.incident.id });
  if (s.incident >= CAP_INCIDENT_USD) return `인시던트 일 예산 초과 ($${s.incident.toFixed(2)} / $${CAP_INCIDENT_USD})`;
  if (s.tenant >= CAP_TENANT_USD) return `테넌트 일 예산 초과 ($${s.tenant.toFixed(2)} / $${CAP_TENANT_USD})`;
  return null;
}

// ── prompt ──────────────────────────────────────────────────────────

function buildPrompt(ctx, evidence) {
  const d = ctx.device || {};
  const th = ctx.thresholds || {};
  const inc = ctx.incident;
  const series = ctx.metrics.slice(-24).map(r => `${new Date(r.ts).toISOString().slice(11, 16)} ${ctx.metric}=${r[ctx.metric] ?? '—'}`).join(' | ');

  // Fleet data is fenced so instructions inside it cannot be read as commands.
  return `<incident>
id: ${inc.id}   ticket: ${inc.ticket_no || '—'}   priority: ${inc.priority}   status: ${inc.status}
title: ${inc.title || '—'}
message: ${inc.description || '—'}
metric: ${ctx.metric || '—'}   value: ${inc.alert_value ?? '—'}   threshold: ${inc.alert_threshold ?? '—'}
occurred: ${new Date(ctx.at).toISOString()}
</incident>

<device>
label: ${d.label || inc.device_label || '—'}   vendor: ${d.vendor || '—'}   model: ${d.model || '—'}
site: ${inc.site || '—'}   room: ${d.room || '—'}   rack: ${d.rack || '—'}   criticality: ${d.criticality || '—'}
now: battery=${d.battery_pct ?? '—'}% load=${d.load_pct ?? '—'}% temp=${d.temp_c ?? '—'}C runtime=${d.runtime_min ?? '—'}min input_v=${d.input_v ?? '—'}
thresholds: battery warn/crit=${th.battery_warn ?? '—'}/${th.battery_critical ?? '—'} load=${th.load_warn ?? '—'}/${th.load_critical ?? '—'} temp=${th.temp_warn ?? '—'}/${th.temp_critical ?? '—'} runtime=${th.runtime_warn ?? '—'}/${th.runtime_critical ?? '—'}
</device>

<series window="±2h">${series || '(no metrics in window)'}</series>

<evidence>
${evidence.map(e => `${e.id} [${e.kind}] ${e.label}`).join('\n') || '(none)'}
</evidence>

Diagnose this UPS/facility incident. Reply with JSON only, exactly this shape:

{"summary":"one line in Korean",
 "hypotheses":[{"id":"h1","cause":"Korean cause","confidence":0.0,"evidence_ids":["e1"]}],
 "actions":[{"id":"a1","type":"remote|onsite|monitor","title":"Korean title","steps":["Korean step"],"risk":"low|med|high","control_action":"self_test|poll_now|null"}],
 "dispatch":{"needed":true,"skill":"UPS L2","urgency":"now|4h|next-day","eta_min":90,"reason":"Korean reason"},
 "verify":{"metric":"battery_pct","op":">=","value":90,"window_min":30}}

Hard rules:
- Every hypothesis MUST cite evidence_ids drawn ONLY from the <evidence> ids above. A hypothesis you cannot tie to listed evidence must be omitted entirely — do not invent an id, and do not state a confidence without evidence.
- At most 3 hypotheses, ordered most to least likely, confidences summing to roughly 1.
- "nodata"/stale metrics are NOT evidence of health. If the device has not been polled recently, say so and treat reachability as the primary question.
- verify must be an objectively checkable return-to-normal condition for the alarming metric.
- Korean for all human-readable text.`;
}

// ── main ────────────────────────────────────────────────────────────

function logAi(db, row) {
  try {
    db.prepare(`INSERT INTO fms_ai_log (tenant_id, incident_id, user_id, kind, device_id, alert_id, model,
                                        question, answer, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.tenant_id, row.incident_id ?? null, row.user_id ?? null, row.kind, row.device_id ?? null,
        row.alert_id ?? null, row.model ?? null, str(row.question, 8000), str(row.answer, 8000),
        row.tokens_in ?? null, row.tokens_out ?? null, row.cost_usd ?? null, row.latency_ms ?? null,
        row.ok ? 1 : 0, str(row.error, 500), Date.now());
  } catch (e) { console.warn('[fms-triage] ai log:', e.message); }
}

function save(db, incidentId, triage) {
  db.prepare('UPDATE tickets SET triage=?, triage_at=?, triage_source=? WHERE id=?')
    .run(JSON.stringify(triage), triage.generated_at, triage.source, incidentId);
}

/**
 * Triage one incident. Always resolves with a triage object — AI when possible,
 * rules otherwise — or { ok:false } only when the incident itself is missing.
 *
 * @param deps.callAnthropic  injected for tests; defaults to claude-router.service
 * @param deps.aiGate         injected for tests; defaults to /opt/cflex-shared/ai-toggle
 */
async function triageIncident(db, incidentId, deps = {}) {
  const ctx = collectContext(db, incidentId);
  if (!ctx) return { ok: false, error: 'incident not found' };

  const evidence = buildEvidence(ctx);
  const fallback = (reason) => {
    const t = rulesTriage(ctx, evidence, reason);
    if (!t) return { ok: false, error: 'no rule matched and no AI result' };
    save(db, incidentId, t);
    return { ok: true, triage: t, source: 'rules', reason };
  };

  let aiGate = deps.aiGate;
  if (!aiGate) { try { aiGate = require('/opt/cflex-shared/ai-toggle'); } catch { aiGate = { isEnabled: () => false }; } }
  if (!aiGate.isEnabled()) return fallback('AI kill-switch OFF');

  const blocked = budgetBlock(db, ctx);
  if (blocked) return fallback(blocked);

  let callAnthropic = deps.callAnthropic, RATES = deps.RATES;
  if (!callAnthropic) {
    try { const r = require('./claude-router.service'); callAnthropic = r.callAnthropic; RATES = r.RATES; }
    catch { return fallback('claude-router.service unavailable'); }
  }

  const prompt = buildPrompt(ctx, evidence);
  const t0 = Date.now();
  let raw = '', parsed = null, usage = null;
  try {
    const r = await callAnthropic({
      model: MODEL,
      system: 'You are a careful facilities reliability engineer. Reply with valid JSON only, no prose, no code fences.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
    });
    raw = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    usage = r.usage;
  } catch (e) {
    logAi(db, { tenant_id: ctx.incident.tenant_id, incident_id: incidentId, kind: 'triage',
      device_id: ctx.incident.device_id, model: MODEL, question: prompt, answer: raw,
      latency_ms: Date.now() - t0, ok: 0, error: e.message });
    return fallback(`AI 호출 실패: ${e.message}`);
  }

  const rate = (RATES || {})[MODEL];
  const costUsd = rate && usage
    ? (usage.input_tokens || 0) / 1e6 * rate.in + (usage.output_tokens || 0) / 1e6 * rate.out
    : null;

  const v = validateTriage({ ...parsed, source: 'ai', model: MODEL, generated_at: Date.now() }, evidence);
  logAi(db, { tenant_id: ctx.incident.tenant_id, incident_id: incidentId, kind: 'triage',
    device_id: ctx.incident.device_id, model: MODEL, question: prompt, answer: raw,
    tokens_in: usage?.input_tokens, tokens_out: usage?.output_tokens, cost_usd: costUsd,
    latency_ms: Date.now() - t0, ok: v.ok ? 1 : 0, error: v.ok ? null : v.dropped.join('; ') });

  if (!v.ok) return fallback(`AI 응답 검증 실패: ${v.dropped.join('; ')}`);

  save(db, incidentId, v.triage);
  return { ok: true, triage: v.triage, source: 'ai', dropped: v.dropped, cost_usd: costUsd, latency_ms: Date.now() - t0 };
}

module.exports = {
  triageIncident, collectContext, buildEvidence, buildPrompt,
  validateTriage, rulesTriage, loadRules, matchRule, spentUsd,
  CAP_INCIDENT_USD, CAP_TENANT_USD, MODEL,
};
