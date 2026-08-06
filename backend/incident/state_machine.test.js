// node --test backend/incident/state_machine.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransition, isActive,
  severityToPriority, priorityToSeverity,
  makeDedupKey, timestampsFor,
  ACTIVE_STATES, STATES,
} = require('./state_machine');


// ── 상태머신 ─────────────────────────────────────────────────────

test('canTransition — open → ack/in_progress/resolved/closed 허용', () => {
  for (const to of ['ack', 'in_progress', 'resolved', 'closed']) {
    assert.equal(canTransition('open', to), true);
  }
});

test('canTransition — closed는 종착, 어디로도 못 감', () => {
  for (const to of ['open', 'ack', 'in_progress', 'resolved', 'closed']) {
    assert.equal(canTransition('closed', to), false);
  }
});

test('canTransition — resolved → open(reopen) 허용', () => {
  assert.equal(canTransition('resolved', 'open'), true);
});

test('canTransition — ack는 open으로 되돌릴 수 없음(에스컬레이션 추적 위해)', () => {
  assert.equal(canTransition('ack', 'open'), false);
});

test('canTransition — 미지 상태는 false', () => {
  assert.equal(canTransition('garbage', 'open'), false);
});


// ── 활성 분류 ───────────────────────────────────────────────────

test('isActive — open/ack/in_progress만 활성 (dedup 대상)', () => {
  assert.equal(isActive('open'), true);
  assert.equal(isActive('ack'), true);
  assert.equal(isActive('in_progress'), true);
  assert.equal(isActive('resolved'), false);
  assert.equal(isActive('closed'), false);
});


// ── severity ↔ priority 매핑 ───────────────────────────────────

test('severity ↔ priority 매핑 일관성', () => {
  assert.equal(severityToPriority('critical'), 'P1');
  assert.equal(severityToPriority('warn'), 'P3');
  assert.equal(severityToPriority('info'), 'P4');
  assert.equal(priorityToSeverity('P1'), 'critical');
  assert.equal(priorityToSeverity('P3'), 'warn');
  assert.equal(priorityToSeverity('P4'), 'info');
});


// ── dedup_key 결정론 ───────────────────────────────────────────

test('makeDedupKey — 같은 입력 → 같은 키 (결정론)', () => {
  const a = makeDedupKey({
    tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
    severity: 'critical', symptom: 'Overload',
  });
  const b = makeDedupKey({
    tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
    severity: 'critical', symptom: 'Overload',
  });
  assert.equal(a, b);
});

test('makeDedupKey — 다른 자산 → 다른 키', () => {
  const a = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: 'Overload' });
  const b = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-2' },
                            severity: 'critical', symptom: 'Overload' });
  assert.notEqual(a, b);
});

test('makeDedupKey — symptom 정규화 (대소문자·공백 무시)', () => {
  const a = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: 'Overload' });
  const b = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: '  OVERLOAD  ' });
  assert.equal(a, b);
});

test('makeDedupKey — symptom 차이 → 다른 키', () => {
  const a = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: 'Overload' });
  const b = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: 'Battery low' });
  assert.notEqual(a, b);
});

test('makeDedupKey — symptom 60자 초과는 절단 (안정성)', () => {
  const long1 = 'Overload high voltage thermal runaway battery cell 5 fault sensor X drift';
  const long2 = long1 + ' (서로 다른 꼬리만)';
  const a = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: long1 });
  const b = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: long2 });
  assert.equal(a, b);   // 앞 60자가 같으면 같은 키
});

test('makeDedupKey — 길이 32 (UNIQUE INDEX 견딜 만)', () => {
  const k = makeDedupKey({ tenantId: 't1', asset: { type: 'ups', id: 'u-1' },
                            severity: 'critical', symptom: 'X' });
  assert.equal(k.length, 32);
});


// ── timestampsFor ─────────────────────────────────────────────

test('timestampsFor — state별 박는 timestamp 컬럼 정합', () => {
  assert.deepEqual(timestampsFor('ack'), { ack_at: true });
  assert.deepEqual(timestampsFor('resolved'), { resolved_at: true });
  assert.deepEqual(timestampsFor('closed'), { closed_at: true });
  assert.deepEqual(timestampsFor('open'), {});
  assert.deepEqual(timestampsFor('in_progress'), {});
});
