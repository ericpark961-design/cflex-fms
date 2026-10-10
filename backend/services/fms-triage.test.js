// node --test backend/services/fms-triage.test.js
//
// v5 §5.1 asks for 5 schema-validation tests, 5 rule-fallback tests and 3 dedup
// tests. The AI path is exercised with an injected callAnthropic so the suite
// needs no key and no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const T = require('./fms-triage');
const I = require('./fms-incident');

const REPO = path.join(__dirname, '..', '..');

// ── scratch DB with the shape 005 leaves behind ─────────────────────
function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL,
      ticket_no TEXT, site TEXT, device_id TEXT, device_label TEXT, priority TEXT, domain TEXT,
      title TEXT, description TEXT, status TEXT, assignee TEXT, alert_metric TEXT,
      alert_value REAL, alert_threshold REAL, created_at INTEGER, updated_at INTEGER,
      resolved_at INTEGER, triage TEXT, triage_at INTEGER, triage_source TEXT, verify_state TEXT,
      severity TEXT, cbu TEXT, source TEXT, dedup_key TEXT, channels TEXT, ack_at INTEGER,
      ack_by TEXT, closed_at INTEGER);
    CREATE UNIQUE INDEX uq_tickets_dedup_active ON tickets(tenant_id, dedup_key)
      WHERE dedup_key IS NOT NULL AND status IN ('open','ack','in_progress');
    CREATE TABLE ticket_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, author TEXT,
      note TEXT, kind TEXT, body_json TEXT, created_at INTEGER);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, device_id TEXT,
      site TEXT, priority TEXT, metric TEXT, message TEXT, value REAL, threshold REAL,
      received_at INTEGER, ticket_id INTEGER, acked_at INTEGER, acked_by TEXT);
    CREATE TABLE incident_alarm_links (incident_id INTEGER NOT NULL, alarm_id INTEGER NOT NULL,
      alarm_source TEXT NOT NULL DEFAULT 'fms', attached_at INTEGER NOT NULL,
      PRIMARY KEY (incident_id, alarm_source, alarm_id));
    CREATE TABLE ups_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, label TEXT,
      vendor TEXT, model TEXT, location TEXT, room TEXT, rack TEXT, criticality TEXT, cbu TEXT,
      site TEXT, status TEXT, last_polled INTEGER, battery_pct REAL, load_pct REAL, temp_c REAL,
      runtime_min REAL, input_v REAL, output_v REAL);
    CREATE TABLE ups_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER, ts INTEGER,
      battery_pct REAL, load_pct REAL, temp_c REAL, runtime_min REAL, input_v REAL, output_v REAL,
      output_status TEXT, battery_status TEXT, health_score REAL, status TEXT);
    CREATE TABLE ups_thresholds (device_id INTEGER PRIMARY KEY, battery_warn REAL, battery_critical REAL,
      load_warn REAL, load_critical REAL, temp_warn REAL, temp_critical REAL, runtime_warn REAL,
      runtime_critical REAL, updated_at INTEGER);
    CREATE TABLE fms_control_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      device_id TEXT, device_label TEXT, action TEXT, channel TEXT, params TEXT, ok INTEGER,
      result TEXT, error TEXT, user_email TEXT, user_id TEXT, dry_run INTEGER, executed_at INTEGER);
    CREATE TABLE fms_alarm_mutes (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      device_id TEXT, metric TEXT, muted_until INTEGER, muted_by TEXT, muted_via TEXT, created_at INTEGER);
    CREATE TABLE fms_triage_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      incident_id INTEGER, hypothesis_id TEXT, cause TEXT, device_id TEXT, metric TEXT,
      outcome TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE fms_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, cbu TEXT,
      location TEXT, name TEXT, cols INTEGER, rows INTEGER, tile_mm INTEGER, height_mm INTEGER,
      note TEXT, updated_at INTEGER);
    CREATE TABLE fms_racks (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, room_id INTEGER,
      name TEXT, col INTEGER, row INTEGER, w INTEGER, d INTEGER, face TEXT, u_height INTEGER,
      kind TEXT, attrs TEXT, updated_at INTEGER);
    CREATE TABLE fms_ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER,
      incident_id INTEGER, user_id TEXT, kind TEXT NOT NULL, device_id TEXT, alert_id INTEGER,
      model TEXT, question TEXT, answer TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
      latency_ms INTEGER, ok INTEGER NOT NULL DEFAULT 1, error TEXT, created_at INTEGER NOT NULL);
  `);
  const db = {
    prepare: (q) => { const st = raw.prepare(q); return { all: (...p) => st.all(...p), get: (...p) => st.get(...p), run: (...p) => st.run(...p) }; },
    exec: (q) => raw.exec(q),
  };
  db.prepare(`INSERT INTO ups_devices (id, tenant_id, label, vendor, model, room, rack, cbu, site, status,
              last_polled, battery_pct, load_pct, temp_c, runtime_min, input_v)
              VALUES (55,10,'HMA-UPS-01','APC','SRT5KRMXLI','CCR-1','A03','HMA','Montgomery','warn',?,24,62,31,8,118)`)
    .run(Date.now() - 60000);
  db.prepare('INSERT INTO ups_thresholds (device_id, battery_warn, battery_critical, temp_warn, temp_critical, load_warn, load_critical, runtime_warn, runtime_critical) VALUES (55,40,25,30,35,80,90,15,8)').run();
  return db;
}

function seedMetrics(db, n = 12, metric = 'battery_pct', from = 60, to = 24) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const v = from + (to - from) * (i / (n - 1));
    db.prepare(`INSERT INTO ups_metrics (device_id, ts, ${metric}, status) VALUES (55,?,?,'warn')`)
      .run(now - (n - i) * 60000, v);
  }
}

function makeAlert(db, over = {}) {
  const a = { tenant_id: 10, device_id: 'ups-55', site: 'Montgomery', priority: 'P1',
    metric: 'battery_pct', message: 'Battery critically low (24%)', value: 24, threshold: 25,
    received_at: Date.now(), ...over };
  const r = db.prepare(`INSERT INTO alerts (tenant_id, device_id, site, priority, metric, message, value, threshold, received_at)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(a.tenant_id, a.device_id, a.site, a.priority, a.metric, a.message, a.value, a.threshold, a.received_at);
  return { ...a, id: r.lastInsertRowid };
}

const EV = [{ id: 'e1', kind: 'metric', label: 'x' }, { id: 'e2', kind: 'alarm', label: 'y' }];
const goodHyp = { id: 'h1', cause: '배터리 노후', confidence: 0.8, evidence_ids: ['e1'] };

// ══ schema validation (5) ═══════════════════════════════════════════

test('schema 1 — a well-formed reply validates and normalises', () => {
  const v = T.validateTriage({
    summary: '요약', hypotheses: [goodHyp],
    actions: [{ id: 'a1', type: 'remote', title: '자가진단', steps: ['실행'], risk: 'low', control_action: 'self_test' }],
    dispatch: { needed: true, skill: 'UPS L2', urgency: '4h', eta_min: 90, reason: '현장' },
    verify: { metric: 'battery_pct', op: '>=', value: 90, window_min: 30 },
  }, EV);
  assert.ok(v.ok);
  assert.equal(v.triage.version, 1);
  assert.equal(v.triage.hypotheses.length, 1);
  assert.equal(v.triage.actions[0].type, 'remote');
  assert.equal(v.triage.verify.value, 90);
  assert.deepEqual(v.triage.evidence, EV);
});

test('schema 2 — a hypothesis citing no known evidence is dropped, not shown', () => {
  const v = T.validateTriage({
    summary: 's',
    hypotheses: [goodHyp, { id: 'h2', cause: '근거 없는 추측', confidence: 0.9, evidence_ids: ['e99'] }],
  }, EV);
  assert.ok(v.ok);
  assert.equal(v.triage.hypotheses.length, 1, 'only the cited hypothesis survives');
  assert.ok(v.dropped.some(d => d.includes('cited no known evidence')));
});

test('schema 3 — a reply whose every hypothesis is uncited fails validation', () => {
  const v = T.validateTriage({ summary: 's', hypotheses: [{ cause: 'x', confidence: 0.9, evidence_ids: [] }] }, EV);
  assert.equal(v.ok, false);
  assert.ok(v.dropped.some(d => d.includes('no hypothesis survived')));
});

test('schema 4 — bad enums and out-of-range numbers are coerced, not trusted', () => {
  const v = T.validateTriage({
    summary: 's',
    hypotheses: [{ ...goodHyp, confidence: 7 }],
    actions: [{ title: 'x', type: 'teleport', risk: 'catastrophic', steps: 'not an array' }],
    verify: { metric: 'battery_pct', op: 'APPROACHES', value: 90 },
  }, EV);
  assert.ok(v.ok);
  assert.equal(v.triage.hypotheses[0].confidence, 1, 'confidence clamped to 0..1');
  assert.equal(v.triage.actions[0].type, 'monitor', 'unknown action type falls back to monitor');
  assert.equal(v.triage.actions[0].risk, 'low');
  assert.deepEqual(v.triage.actions[0].steps, []);
  assert.equal(v.triage.verify, null, 'unknown operator drops verify rather than guessing');
});

test('schema 5 — garbage input is rejected and caps are enforced', () => {
  assert.equal(T.validateTriage(null, EV).ok, false);
  assert.equal(T.validateTriage('{}', EV).ok, false);
  const many = { summary: 's', hypotheses: Array.from({ length: 9 }, (_, i) => ({ ...goodHyp, id: `h${i}` })) };
  assert.equal(T.validateTriage(many, EV).triage.hypotheses.length, 3, 'at most 3 hypotheses');
});

// ══ rule fallback (5) ═══════════════════════════════════════════════

test('rules 1 — kill-switch off still produces a card, labelled rules', async () => {
  const db = freshDb(); seedMetrics(db);
  const inc = I.ensureIncidentForAlert(db, makeAlert(db));
  const r = await T.triageIncident(db, inc.incidentId, { aiGate: { isEnabled: () => false } });
  assert.ok(r.ok);
  assert.equal(r.source, 'rules');
  assert.equal(r.triage.source, 'rules');
  assert.ok(r.triage.hypotheses.length > 0, 'the card is never empty');
  assert.match(r.triage.fallback_reason, /kill-switch/i);
  const saved = db.prepare('SELECT triage, triage_source FROM tickets WHERE id=?').get(inc.incidentId);
  assert.equal(saved.triage_source, 'rules');
  assert.ok(JSON.parse(saved.triage).hypotheses.length > 0);
});

test('rules 2 — an AI error falls back rather than leaving the card blank', async () => {
  const db = freshDb(); seedMetrics(db);
  const inc = I.ensureIncidentForAlert(db, makeAlert(db));
  const r = await T.triageIncident(db, inc.incidentId, {
    aiGate: { isEnabled: () => true },
    callAnthropic: async () => { throw new Error('503 upstream'); },
  });
  assert.equal(r.source, 'rules');
  assert.match(r.triage.fallback_reason, /503/);
  const log = db.prepare("SELECT ok, error FROM fms_ai_log WHERE kind='triage'").get();
  assert.equal(log.ok, 0, 'the failed call is logged');
});

test('rules 3 — an AI reply that fails validation falls back', async () => {
  const db = freshDb(); seedMetrics(db);
  const inc = I.ensureIncidentForAlert(db, makeAlert(db));
  const r = await T.triageIncident(db, inc.incidentId, {
    aiGate: { isEnabled: () => true },
    // Confident, fluent, and cites nothing that exists.
    callAnthropic: async () => ({ content: [{ type: 'text', text: JSON.stringify({ summary: 'x', hypotheses: [{ cause: '확신', confidence: 0.99, evidence_ids: ['e_nope'] }] }) }], usage: { input_tokens: 10, output_tokens: 5 } }),
  });
  assert.equal(r.source, 'rules');
  assert.match(r.triage.fallback_reason, /검증 실패/);
});

test('rules 4 — each known metric maps to its own rule, unknown ones to default', () => {
  const rules = T.loadRules();
  for (const [metric, expect] of [['battery_pct', 'battery_pct'], ['reachability', 'reachability'],
    ['temp_critical', 'temp_c'], ['load_pct', 'load_pct'], ['input_v', 'input_v'], ['runtime_min', 'runtime_min']]) {
    assert.equal(T.matchRule(rules, metric, '')?.metric, expect, `${metric} → ${expect}`);
  }
  const unknown = T.matchRule(rules, 'temp_xyz', '');
  assert.ok(unknown, 'temp_xyz matches the temp rule by regex or falls to default');
  assert.equal(T.matchRule(rules, 'humidity_pct', 'nothing familiar')?.metric, undefined, 'truly unknown → default has no metric field');
});

test('rules 5 — the budget cap diverts to rules and names the cap', async () => {
  const db = freshDb(); seedMetrics(db);
  const inc = I.ensureIncidentForAlert(db, makeAlert(db));
  db.prepare('INSERT INTO fms_ai_log (tenant_id, incident_id, kind, cost_usd, ok, created_at) VALUES (10,?,?,?,1,?)')
    .run(inc.incidentId, 'triage', T.CAP_INCIDENT_USD + 0.01, Date.now());
  let called = false;
  const r = await T.triageIncident(db, inc.incidentId, {
    aiGate: { isEnabled: () => true },
    callAnthropic: async () => { called = true; return { content: [] }; },
  });
  assert.equal(called, false, 'no API call once the cap is reached');
  assert.equal(r.source, 'rules');
  assert.match(r.triage.fallback_reason, /예산 초과/);
});

// ══ dedup (3) ═══════════════════════════════════════════════════════

test('state machine — ack stamps who and when, and closed is terminal', () => {
  const db = freshDb();
  const inc = I.ensureIncidentForAlert(db, makeAlert(db));
  assert.ok(I.transition(db, inc.incidentId, 'ack', { by: 'eric@ringon' }).ok);
  const row = db.prepare('SELECT status, ack_at, ack_by FROM tickets WHERE id=?').get(inc.incidentId);
  assert.equal(row.status, 'ack');
  assert.equal(row.ack_by, 'eric@ringon');
  assert.ok(row.ack_at > 0);
  assert.ok(I.transition(db, inc.incidentId, 'closed', { by: 'eric', skipHooks: true }).ok);
  assert.equal(I.transition(db, inc.incidentId, 'open').ok, false, 'closed is terminal');
});

test('dedup 1 — a repeating alarm attaches to the open incident', () => {
  const db = freshDb();
  const a1 = I.ensureIncidentForAlert(db, makeAlert(db, { value: 24 }));
  const a2 = I.ensureIncidentForAlert(db, makeAlert(db, { value: 23, message: 'Battery critically low (23%)' }));
  assert.equal(a1.created, true);
  assert.equal(a2.created, false);
  assert.equal(a2.deduped, true);
  assert.equal(a2.incidentId, a1.incidentId, 'one fault, one incident');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM incident_alarm_links WHERE incident_id=?').get(a1.incidentId).c, 2);
  const kinds = db.prepare('SELECT kind FROM ticket_notes WHERE ticket_id=? ORDER BY id').all(a1.incidentId).map(r => r.kind);
  assert.deepEqual(kinds, ['state_change', 'alarm_attach']);
});

test('dedup 2 — a different metric or severity is a different incident', () => {
  const db = freshDb();
  const base = I.ensureIncidentForAlert(db, makeAlert(db));
  const other = I.ensureIncidentForAlert(db, makeAlert(db, { metric: 'temp_c', message: 'Over temperature' }));
  const warn = I.ensureIncidentForAlert(db, makeAlert(db, { priority: 'P3' }));
  assert.notEqual(other.incidentId, base.incidentId);
  assert.notEqual(warn.incidentId, base.incidentId, 'warn and critical are separate incidents');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 3);
});

test('dedup 3 — once closed, the same alarm opens a new incident', () => {
  const db = freshDb();
  const first = I.ensureIncidentForAlert(db, makeAlert(db));
  // skipHooks: resolving fires the RCA draft, which needs the real app db.
  const t = I.transition(db, first.incidentId, 'resolved', { by: 'eric', skipHooks: true });
  assert.ok(t.ok);
  assert.equal(db.prepare('SELECT resolved_at FROM tickets WHERE id=?').get(first.incidentId).resolved_at > 0, true);
  assert.ok(I.transition(db, first.incidentId, 'closed', { by: 'eric', skipHooks: true }).ok);
  assert.equal(db.prepare('SELECT closed_at FROM tickets WHERE id=?').get(first.incidentId).closed_at > 0, true);
  const again = I.ensureIncidentForAlert(db, makeAlert(db));
  assert.equal(again.created, true, 'a recurrence after close is a new incident');
  assert.notEqual(again.incidentId, first.incidentId);
  assert.equal(again.dedupKey, first.dedupKey, 'same key, allowed because the old one is closed');
  // And the guard refuses an impossible transition instead of silently writing.
  const bad = I.transition(db, first.incidentId, 'ack');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /전이 불가/);
});

// ══ the AI happy path, with evidence bound in code ═══════════════════

test('ai — a valid reply is stored with source=ai and real evidence ids', async () => {
  const db = freshDb(); seedMetrics(db);
  db.prepare("INSERT INTO fms_control_log (tenant_id, device_id, action, ok, executed_at) VALUES (10,'ups-55','self_test',1,?)").run(Date.now() - 300000);
  const inc = I.ensureIncidentForAlert(db, makeAlert(db));
  let seenPrompt = '';
  const r = await T.triageIncident(db, inc.incidentId, {
    aiGate: { isEnabled: () => true },
    RATES: { [T.MODEL]: { in: 0.8, out: 4 } },
    callAnthropic: async ({ messages }) => {
      seenPrompt = messages[0].content;
      return { content: [{ type: 'text', text: '```json\n' + JSON.stringify({
        summary: '배터리 용량 저하', hypotheses: [{ id: 'h1', cause: '배터리 노후', confidence: 0.8, evidence_ids: ['e1'] }],
        actions: [{ id: 'a1', type: 'remote', title: '자가진단', steps: ['실행'], risk: 'low', control_action: 'self_test' }],
        dispatch: { needed: true, skill: 'UPS L2', urgency: '4h', eta_min: 90, reason: '교체 필요' },
        verify: { metric: 'battery_pct', op: '>=', value: 90, window_min: 30 },
      }) + '\n```' }], usage: { input_tokens: 1200, output_tokens: 300 } };
    },
  });
  assert.ok(r.ok);
  assert.equal(r.source, 'ai');
  assert.equal(r.triage.hypotheses[0].evidence_ids[0], 'e1');
  assert.ok(r.triage.evidence.length >= 2, 'evidence is built in code, not by the model');
  assert.ok(r.cost_usd > 0, 'cost recorded');
  // Code fences are tolerated, and the prompt fences fleet data.
  assert.match(seenPrompt, /<incident>/);
  assert.match(seenPrompt, /<evidence>/);
  assert.ok(!/snmp_community|password/i.test(seenPrompt), 'no credentials in the prompt');
  const log = db.prepare("SELECT tokens_in, tokens_out, cost_usd, ok FROM fms_ai_log WHERE kind='triage'").get();
  assert.equal(log.tokens_in, 1200);
  assert.equal(log.ok, 1);
});

test('evidence — a stale device is never described as healthy', () => {
  const db = freshDb();
  db.prepare('UPDATE ups_devices SET last_polled=? WHERE id=55').run(Date.now() - 6 * 3600 * 1000);
  const inc = I.ensureIncidentForAlert(db, makeAlert(db, { metric: 'reachability', message: 'UPS unreachable: no response', priority: 'P2', value: null, threshold: null }));
  const ctx = T.collectContext(db, inc.incidentId);
  const ev = T.buildEvidence(ctx);
  assert.ok(ev.some(e => /마지막 폴링/.test(e.label)), 'poll age is evidence');
  const t = T.rulesTriage(ctx, ev, 'test');
  assert.ok(t.hypotheses.length > 0);
  assert.ok(t.hypotheses.every(h => h.evidence_ids.length > 0), 'rule hypotheses are bound to collected evidence too');
});

test('rules.json stays loadable and contract-shaped', () => {
  const r = JSON.parse(fs.readFileSync(path.join(REPO, 'backend/triage/rules.json'), 'utf8'));
  assert.ok(r.rules.length >= 6);
  assert.ok(r.default);
  for (const rule of r.rules.concat([r.default])) {
    assert.ok(rule.summary, 'every rule has a summary');
    assert.ok(rule.hypotheses.every(h => Array.isArray(h.evidence_kinds) && h.evidence_kinds.length), 'hypotheses declare which evidence they need');
    assert.ok(rule.actions.every(a => ['remote', 'onsite', 'monitor'].includes(a.type)), 'action types are in the contract');
  }
});
