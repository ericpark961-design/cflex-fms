// 상태머신 + dedup_key 합성 — DB 없이 단위테스트 가능한 순수 로직.
// cflex_응대레이어_스펙 §1, §2.

const crypto = require('crypto');

const STATES = ['open', 'ack', 'in_progress', 'resolved', 'closed'];

// 전이: 어디서 어디로 갈 수 있나.
const TRANSITIONS = {
  open:        ['ack', 'in_progress', 'resolved', 'closed'],
  ack:         ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved:    ['closed', 'open'],   // reopen 허용
  closed:      [],                    // 종착
};

const ACTIVE_STATES = new Set(['open', 'ack', 'in_progress']);

const SEVERITY_TO_PRIORITY = { critical: 'P1', warn: 'P3', info: 'P4' };
const PRIORITY_TO_SEVERITY = { P1: 'critical', P2: 'critical', P3: 'warn', P4: 'info' };


function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}


function isActive(state) {
  return ACTIVE_STATES.has(state);
}


function severityToPriority(sev) {
  return SEVERITY_TO_PRIORITY[sev] || 'P3';
}


function priorityToSeverity(p) {
  return PRIORITY_TO_SEVERITY[p] || 'info';
}


/**
 * 알람을 1 인시던트로 묶기 위한 결정론 dedup_key.
 * 같은 (tenant, asset, severity, symptom) 알람이 반복돼도 같은 키 → 같은 활성 인시던트.
 * symptom은 짧은 안정 식별자(예: "Overload" 또는 "Battery low"). 자유 텍스트 전체 X.
 */
function makeDedupKey({ tenantId, asset = {}, severity, symptom = '' }) {
  const norm = (symptom || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  const s = `${tenantId || ''}|${asset.type || ''}|${asset.id || ''}|${severity || ''}|${norm}`;
  return crypto.createHash('sha256').update(s).digest('base64').slice(0, 32);
}


/**
 * state 전이 시 timestamps에 박을 컬럼.
 */
function timestampsFor(state) {
  return ({
    ack:      { ack_at: true },
    resolved: { resolved_at: true },
    closed:   { closed_at: true },
  })[state] || {};
}


module.exports = {
  STATES, TRANSITIONS, ACTIVE_STATES,
  SEVERITY_TO_PRIORITY, PRIORITY_TO_SEVERITY,
  canTransition, isActive,
  severityToPriority, priorityToSeverity,
  makeDedupKey, timestampsFor,
};
