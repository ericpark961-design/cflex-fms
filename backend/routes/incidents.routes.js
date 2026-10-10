// /v1/incidents/* — the alarm workbench API (v5 §3.4).
//
// v5 described these as existing endpoints to reuse. They did not exist: the
// repo had a state-machine library and a Postgres migration for a different
// store, and nothing was mounted. So the base endpoints (/, /:id, /state,
// /timeline, /rca/draft) are here alongside the seven new ones, all against
// the SQLite store the FMS API actually serves.
//
// One shape rule: GET /:id/workbench returns header + triage + evidence +
// timeline + dispatch in a single response. The workbench is one screen opened
// from six places, and six round-trips per open would show as six flashes.
const express = require('express');
const router = express.Router();
const db = require('../config/database');

const incident = require('../services/fms-incident');
const triage = require('../services/fms-triage');
const reeval = require('../services/fms-reeval');
const sm = require('../incident/state_machine');

router.use(express.json({ limit: '1mb' }));

function tenantOf(req) {
  if (!req.user) return null;
  if (req.user.role === 'super_admin' || req.user.role === 'admin') {
    return req.query.tenant_id ? parseInt(req.query.tenant_id, 10) : (req.user.tenantId || null);
  }
  return req.user.tenantId || null;
}
const who = (req) => req.user?.email || req.user?.name || String(req.user?.id || 'unknown');
const canControl = (req) => ['super_admin', 'admin', 'fms_admin'].includes(req.user?.role);

/** Load an incident inside the caller's tenant, or null. */
function load(tid, id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  return db.prepare('SELECT * FROM tickets WHERE id=? AND tenant_id=?').get(n, tid) || null;
}

const parseJson = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };

// ─── GET /v1/incidents ── list ──────────────────────────────────────
router.get('/', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const cbu = (req.query.cbu || '').trim();
  const state = (req.query.state || '').trim();
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);

  const where = ['tenant_id=?']; const params = [tid];
  if (cbu && cbu !== 'all') { where.push('cbu=?'); params.push(cbu); }
  if (state === 'active') where.push("status IN ('open','ack','in_progress')");
  else if (state) { where.push('status=?'); params.push(state); }

  const rows = db.prepare(`SELECT id, ticket_no, status, severity, priority, cbu, site, device_id,
                                  device_label, title, alert_metric, alert_value, alert_threshold,
                                  assignee, triage_source, triage_at, verify_state,
                                  created_at, ack_at, resolved_at, closed_at
                           FROM tickets WHERE ${where.join(' AND ')}
                           ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  res.json({ ok: true, incidents: rows });
});

// ─── GET /v1/incidents/:id ──────────────────────────────────────────
router.get('/:id', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  res.json({ ok: true, incident: { ...inc, triage: parseJson(inc.triage), channels: parseJson(inc.channels, []) } });
});

// ─── GET /v1/incidents/:id/timeline ─────────────────────────────────
router.get('/:id/timeline', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  res.json({ ok: true, timeline: timelineOf(inc.id) });
});

function timelineOf(id) {
  return db.prepare(`SELECT id, author, note, kind, body_json, created_at
                     FROM ticket_notes WHERE ticket_id=? ORDER BY created_at, id`).all(id)
    .map(r => ({ ...r, body: parseJson(r.body_json) , body_json: undefined }));
}

// ─── GET /v1/incidents/:id/workbench ── everything, one call ────────
router.get('/:id/workbench', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });

  const ctx = triage.collectContext(db, inc.id);
  const stored = parseJson(inc.triage);
  // Evidence is recomputed per read so the numbered items match the data as it
  // stands now; the stored triage keeps the ids it cited.
  const evidence = ctx ? triage.buildEvidence(ctx) : [];

  const devNum = parseInt(String(inc.device_id || '').replace(/^ups-/i, ''), 10);
  const series = Number.isFinite(devNum) && inc.alert_metric
    ? db.prepare(`SELECT ts, ${metricColumn(inc.alert_metric)} AS v FROM ups_metrics
                  WHERE device_id=? AND ts BETWEEN ? AND ? ORDER BY ts`)
      .all(devNum, (inc.created_at || Date.now()) - 2 * 3600 * 1000, (inc.created_at || Date.now()) + 2 * 3600 * 1000)
      .filter(r => r.v != null)
    : [];

  const alarms = db.prepare(`SELECT a.id, a.priority, a.metric, a.message, a.value, a.threshold, a.received_at
                             FROM incident_alarm_links l JOIN alerts a ON a.id=l.alarm_id
                             WHERE l.incident_id=? ORDER BY a.received_at`).all(inc.id);

  let dispatch = [];
  try { dispatch = db.prepare('SELECT * FROM fms_dispatch WHERE incident_id=? ORDER BY created_at DESC').all(inc.id); } catch { /* pre-005 */ }

  let feedback = [];
  try { feedback = db.prepare('SELECT hypothesis_id, outcome, user_id, created_at FROM fms_triage_feedback WHERE incident_id=?').all(inc.id); } catch { /* pre-005 */ }

  res.json({
    ok: true,
    incident: {
      ...inc, triage: undefined, channels: parseJson(inc.channels, []),
      can_transition: sm.TRANSITIONS[inc.status || 'open'] || [],
    },
    device: ctx?.device || null,
    thresholds: ctx?.thresholds || null,
    triage: stored,
    triage_stale: !!(stored && inc.triage_at && evidence.length !== (stored.evidence || []).length),
    evidence,
    series: { metric: inc.alert_metric, points: series, threshold: inc.alert_threshold },
    adjacent: ctx?.adjacent || [],
    chain: ctx?.chain || [],
    control_log: ctx?.controlLog || [],
    alarms,
    timeline: timelineOf(inc.id),
    dispatch,
    feedback,
    permissions: { control: canControl(req) },
  });
});

// ups_metrics has one column per metric; alert_metric names are not all columns.
const METRIC_COLS = new Set(['battery_pct', 'load_pct', 'temp_c', 'runtime_min', 'input_v', 'output_v', 'health_score']);
function metricColumn(m) {
  if (METRIC_COLS.has(m)) return m;
  if (/temp/.test(m)) return 'temp_c';
  if (/batt/.test(m)) return 'battery_pct';
  if (/load/.test(m)) return 'load_pct';
  if (/runtime/.test(m)) return 'runtime_min';
  if (/input/.test(m)) return 'input_v';
  return 'health_score';
}

// ─── POST /v1/incidents/:id/state ── guarded transition ─────────────
router.post('/:id/state', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  const to = String(req.body?.state || '').trim();
  if (!sm.STATES.includes(to)) return res.status(400).json({ error: `unknown state: ${to}`, states: sm.STATES });

  const r = incident.transition(db, inc.id, to, { by: who(req), note: req.body?.note || '' });
  if (!r.ok) return res.status(409).json(r);

  // Resolving arms the verification window (v5 §3.3).
  if (to === 'resolved') {
    const t = parseJson(inc.triage);
    if (t?.verify) {
      try { db.prepare('UPDATE tickets SET verify_state=? WHERE id=?').run('pending', inc.id); } catch { /* pre-005 */ }
    }
  }
  res.json({ ok: true, ...r, incident: load(tid, inc.id) });
});

// ─── POST /v1/incidents/:id/triage/rerun ────────────────────────────
router.post('/:id/triage/rerun', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });

  const before = parseJson(inc.triage);
  const r = await triage.triageIncident(db, inc.id);
  if (!r.ok) return res.status(502).json(r);

  // v5 §2: a changed opinion is a timeline event, not a silent overwrite.
  const beforeTop = before?.hypotheses?.[0]?.cause;
  const afterTop = r.triage.hypotheses?.[0]?.cause;
  if (beforeTop && afterTop && beforeTop !== afterTop) {
    incident.addTimeline(db, inc.id, {
      kind: 'triage', author: 'ai',
      note: `AI 소견 변경: ${beforeTop} → ${afterTop}`,
      body: { from: beforeTop, to: afterTop, source: r.source, reason: r.triage.fallback_reason || null },
    });
  } else {
    incident.addTimeline(db, inc.id, {
      kind: 'triage', author: r.source === 'ai' ? 'ai' : 'rules',
      note: `재평가 — ${afterTop || '가설 없음'}`,
      body: { source: r.source, by: who(req) },
    });
  }
  res.json({ ok: true, triage: r.triage, source: r.source, cost_usd: r.cost_usd ?? null });
});

// ─── POST /v1/incidents/:id/triage/feedback ── the ✓/✗ memory ───────
router.post('/:id/triage/feedback', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });

  const hid = String(req.body?.hypothesis_id || '').slice(0, 16);
  const outcome = req.body?.outcome === 'confirmed' ? 'confirmed' : req.body?.outcome === 'rejected' ? 'rejected' : null;
  if (!hid || !outcome) return res.status(400).json({ error: 'hypothesis_id and outcome (confirmed|rejected) required' });

  const t = parseJson(inc.triage);
  const hyp = (t?.hypotheses || []).find(h => h.id === hid);
  if (!hyp) return res.status(404).json({ error: 'hypothesis not in the stored triage' });

  db.prepare(`INSERT INTO fms_triage_feedback (tenant_id, incident_id, hypothesis_id, cause, device_id, metric, outcome, user_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(tid, inc.id, hid, hyp.cause, inc.device_id, inc.alert_metric, outcome, who(req), Date.now());

  incident.addTimeline(db, inc.id, {
    kind: 'triage', author: who(req),
    note: `${outcome === 'confirmed' ? '원인 확정' : '가설 기각'}: ${hyp.cause}`,
    body: { hypothesis_id: hid, outcome },
  });
  res.json({ ok: true, hypothesis_id: hid, outcome });
});

// ─── POST /v1/incidents/:id/action ── run a control action ──────────
router.post('/:id/action', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  if (!canControl(req)) return res.status(403).json({ error: 'control requires an admin role' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });

  const actionKey = String(req.body?.action || '').slice(0, 40);
  if (!actionKey) return res.status(400).json({ error: 'action required' });
  const deviceId = String(inc.device_id || '').replace(/^ups-/i, '');
  if (!deviceId) return res.status(400).json({ error: 'incident has no device' });

  let out;
  try {
    const { performAction } = require('../services/fms-device-control');
    out = await performAction({ tenantId: tid, deviceId, actionKey, params: req.body?.params || {}, user: req.user });
  } catch (e) {
    out = { ok: false, error: e.message };
  }

  // The result is the point: a control action that silently did nothing is the
  // worst outcome, so it lands on the timeline either way.
  incident.addTimeline(db, inc.id, {
    kind: 'action', author: who(req),
    note: `원격 조치 ${actionKey} — ${out?.ok ? '요청됨' : `실패: ${out?.error || '알 수 없음'}`}`,
    body: { action: actionKey, ok: !!out?.ok, error: out?.error || null, result: out?.result ?? null },
  });

  // New evidence (v5 §2): a control result is a re-evaluation trigger.
  if (out?.ok) {
    reeval.queue(db, inc.id, 'action_result');
  }
  res.status(out?.ok ? 200 : 502).json({ ok: !!out?.ok, result: out });
});

// ─── POST /v1/incidents/:id/dispatch ── send an engineer ────────────
router.post('/:id/dispatch', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });

  const t = parseJson(inc.triage);
  const d = req.body || {};
  const row = {
    engineer: String(d.engineer || '').slice(0, 128) || null,
    skill: String(d.skill || t?.dispatch?.skill || '').slice(0, 60) || null,
    urgency: String(d.urgency || t?.dispatch?.urgency || '4h').slice(0, 20),
    eta_min: Number.isFinite(Number(d.eta_min)) ? Number(d.eta_min) : (t?.dispatch?.eta_min ?? null),
    note: String(d.note || '').slice(0, 2000) || null,
  };

  // MOP draft. Same AI path, same gate; a failure produces the triage's own
  // steps as the procedure rather than an empty attachment.
  let mop = String(d.mop || '').slice(0, 20000) || null;
  if (!mop) mop = await draftMop(inc, t, tid);

  const ins = db.prepare(`INSERT INTO fms_dispatch (tenant_id, incident_id, engineer, skill, urgency, eta_min, mop, created_by, created_at)
                          VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(tid, inc.id, row.engineer, row.skill, row.urgency, row.eta_min, mop, who(req), Date.now());
  const did = ins.lastInsertRowid;

  // Send through the configured alarm channels.
  // alarm-notifier.notify() resolves to an array of per-channel results (or
  // undefined when the alert has no tenant) — not an {ok} envelope.
  let sent = { ok: false, channels: [], failed: [] };
  try {
    const notifier = require('../services/alarm-notifier');
    const link = `${process.env.FMS_PUBLIC_URL || 'https://fms.runless.co.uk'}/twin/#/incident/${inc.id}`;
    const results = await notifier.notify({
      id: inc.id, tenant_id: tid, device_id: inc.device_id, priority: inc.priority,
      metric: inc.alert_metric, message: `[디스패치] ${inc.title}\n기술등급 ${row.skill || '—'} · 긴급도 ${row.urgency} · 예상 ${row.eta_min ?? '—'}분\n${link}`,
      value: inc.alert_value, threshold: inc.alert_threshold,
    });
    const list = Array.isArray(results) ? results : [];
    sent = {
      ok: list.some(r => r?.ok),
      channels: list.filter(r => r?.ok).map(r => r.channel),
      failed: list.filter(r => r && !r.ok).map(r => `${r.channel}: ${r.error || 'failed'}`),
      error: list.length ? null : '발송 대상 채널이 없다 (fms_alarm_routes 미설정)',
    };
  } catch (e) { sent = { ok: false, error: e.message, channels: [], failed: [] }; }

  if (sent.ok) {
    db.prepare('UPDATE fms_dispatch SET sent_at=?, channel=? WHERE id=?')
      .run(Date.now(), sent.channels.join(',') || null, did);
  }
  incident.addTimeline(db, inc.id, {
    kind: 'dispatch', author: who(req),
    note: `엔지니어 디스패치 — ${row.skill || '—'} / ${row.urgency}${sent.ok ? ` · 발송 ${sent.channels.join(', ')}` : ` · 발송 실패: ${sent.error || sent.failed.join('; ') || '채널 없음'}`}`,
    body: { dispatch_id: did, ...row, sent },
  });
  // Dispatching moves the incident along if it is still just open/ack.
  if (['open', 'ack'].includes(inc.status)) incident.transition(db, inc.id, 'in_progress', { by: who(req), note: '디스패치로 진행 중' });

  res.json({ ok: true, dispatch_id: did, mop, sent, dispatch: db.prepare('SELECT * FROM fms_dispatch WHERE id=?').get(did) });
});

async function draftMop(inc, t, tid) {
  const fallback = () => {
    const steps = (t?.actions || []).filter(a => a.type === 'onsite').flatMap(a => [`### ${a.title}`, ...(a.steps || []).map(s => `- ${s}`)]);
    return [`# MOP — ${inc.title}`, '', `장치: ${inc.device_label || inc.device_id}`, `사이트: ${inc.site || '—'}`, '',
      '## 조치 절차', ...(steps.length ? steps : ['- 트리아지에 현장 조치가 없다. 현장에서 상태를 확인하고 소견을 기록한다.']),
      '', '## 안전', '- 작업 전 상위 전원 상태를 확인한다.', '- 무정전 교체가 불가하면 작업 창을 먼저 협의한다.',
      '', '_규칙 기반 초안 — AI 미사용_'].join('\n');
  };
  let aiGate; try { aiGate = require('/opt/cflex-shared/ai-toggle'); } catch { aiGate = { isEnabled: () => false }; }
  if (!aiGate.isEnabled() || !t) return fallback();
  try {
    const { callAnthropic } = require('../services/claude-router.service');
    const r = await callAnthropic({
      model: triage.MODEL,
      system: 'You write concise field procedures (MOP) for data-centre UPS work. Markdown only, Korean, no preamble.',
      messages: [{ role: 'user', content: `다음 인시던트의 현장 작업 절차(MOP)를 마크다운으로 써라. 섹션: 목적 / 사전 확인 / 절차 / 안전 / 롤백 / 완료 확인.

<incident>
${inc.title}
장치: ${inc.device_label || inc.device_id} · 사이트: ${inc.site || '—'}
메트릭: ${inc.alert_metric} = ${inc.alert_value ?? '—'} (임계 ${inc.alert_threshold ?? '—'})
</incident>
<triage>
${JSON.stringify({ summary: t.summary, hypotheses: t.hypotheses, actions: t.actions, dispatch: t.dispatch })}
</triage>` }],
      max_tokens: 1400,
    });
    const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    try {
      db.prepare(`INSERT INTO fms_ai_log (tenant_id, incident_id, kind, model, tokens_in, tokens_out, ok, created_at)
                  VALUES (?,?,'mop',?,?,?,1,?)`)
        .run(tid, inc.id, triage.MODEL, r.usage?.input_tokens ?? null, r.usage?.output_tokens ?? null, Date.now());
    } catch { /* pre-005 */ }
    return text || fallback();
  } catch { return fallback(); }
}

// ─── PATCH /v1/incidents/:id/dispatch/:did ── accept/arrive/done ────
router.patch('/:id/dispatch/:did', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  const did = parseInt(req.params.did, 10);
  const row = db.prepare('SELECT * FROM fms_dispatch WHERE id=? AND incident_id=? AND tenant_id=?').get(did, inc.id, tid);
  if (!row) return res.status(404).json({ error: 'dispatch not found' });

  const COL = { accept: 'accepted_at', arrive: 'arrived_at', done: 'done_at' };
  const step = String(req.body?.step || '');
  const col = COL[step];
  if (!col) return res.status(400).json({ error: 'step must be accept | arrive | done' });

  db.prepare(`UPDATE fms_dispatch SET ${col}=?, note=COALESCE(?, note) WHERE id=?`)
    .run(Date.now(), req.body?.note ? String(req.body.note).slice(0, 2000) : null, did);
  incident.addTimeline(db, inc.id, {
    kind: 'dispatch', author: who(req),
    note: `디스패치 ${({ accept: '수락', arrive: '도착', done: '작업 완료' })[step]}${req.body?.note ? ` — ${String(req.body.note).slice(0, 300)}` : ''}`,
    body: { dispatch_id: did, step },
  });
  // An engineer's note is new evidence (v5 §2).
  if (step === 'done' || req.body?.note) {
    reeval.queue(db, inc.id, 'engineer_note');
  }
  res.json({ ok: true, dispatch: db.prepare('SELECT * FROM fms_dispatch WHERE id=?').get(did) });
});

// ─── GET /v1/incidents/:id/verify ── did it actually come back? ─────
router.get('/:id/verify', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });

  const t = parseJson(inc.triage);
  const v = t?.verify;
  if (!v) return res.json({ ok: true, verify: null, state: inc.verify_state || null, reason: '검증 조건이 없다' });

  const devNum = parseInt(String(inc.device_id || '').replace(/^ups-/i, ''), 10);
  const since = (inc.resolved_at || Date.now()) - 60000;
  const rows = Number.isFinite(devNum)
    ? db.prepare(`SELECT ts, ${metricColumn(v.metric)} AS val FROM ups_metrics
                  WHERE device_id=? AND ts >= ? ORDER BY ts`).all(devNum, since).filter(r => r.val != null)
    : [];

  const CMP = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
  const cmp = CMP[v.op] || (() => false);
  const windowEnd = (inc.resolved_at || Date.now()) + (v.window_min || 30) * 60000;
  const met = rows.some(r => cmp(r.val, v.value));
  const expired = Date.now() > windowEnd;

  // No samples is not a pass. An unpolled device cannot prove recovery.
  let state = 'pending';
  if (met) state = 'ok';
  else if (expired) state = 'failed';

  if (state !== (inc.verify_state || 'pending')) {
    try { db.prepare('UPDATE tickets SET verify_state=? WHERE id=?').run(state, inc.id); } catch { /* pre-005 */ }
    incident.addTimeline(db, inc.id, {
      kind: 'verify', author: 'system',
      note: state === 'ok'
        ? `Verify 통과 — ${v.metric} ${v.op} ${v.value} 확인`
        : `Verify 실패 — ${v.window_min || 30}분 내 ${v.metric} ${v.op} ${v.value} 미달 (표본 ${rows.length}건)`,
      body: { verify: v, samples: rows.length, state },
    });
    // v5 §6: a failed verification reopens the incident rather than leaving a
    // resolved row that never recovered.
    if (state === 'failed' && inc.status === 'resolved') {
      incident.transition(db, inc.id, 'open', { by: 'system', note: 'Verify 실패로 자동 재오픈' });
      reeval.queue(db, inc.id, 'state_change');
    }
  }

  res.json({ ok: true, verify: v, state, samples: rows.length, window_ends_at: windowEnd,
    latest: rows.length ? rows[rows.length - 1] : null });
});

// ─── POST /v1/incidents/:id/rca/draft ───────────────────────────────
router.post('/:id/rca/draft', async (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  try {
    const r = await require('../services/fms-rca').generateRcaForTicket(inc.id);
    if (r?.ok) incident.addTimeline(db, inc.id, { kind: 'rca', author: 'ai', note: r.rca.summary, body: r.rca });
    return res.status(r?.ok ? 200 : 502).json(r);
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ─── POST /v1/incidents/:id/comment ── a person on the timeline ─────
router.post('/:id/comment', (req, res) => {
  const tid = tenantOf(req); if (!tid) return res.status(400).json({ error: 'tenant scope required' });
  const inc = load(tid, req.params.id);
  if (!inc) return res.status(404).json({ error: 'incident not found' });
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note required' });
  const id = incident.addTimeline(db, inc.id, { kind: 'comment', author: who(req), note });
  reeval.queue(db, inc.id, 'engineer_note');
  res.json({ ok: true, note_id: id });
});

module.exports = router;
