// Phase 0 정제 — node:test 단위테스트.
// 실행: node --test backend/services/fms-derive-status.test.js
//
// 검증:
//   ① unreachable/nodata 분리 (consecutiveFails로 판정, 둘 다 회색).
//   ② healthScore가 status 매핑 단일 출처.
//   ③ aggregateCounts 정합 (합 = total).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveStatus, aggregateCounts, scoreToStatus,
  SCORE_BANDS, UNREACHABLE_AFTER_FAILS,
  OutputStatus, BatteryStatus, ReplaceIndicator,
} = require('./fms-derive-status');


// ── ① unreachable / nodata 분리 ──────────────────────────────────────

test('nodata — 폴링 없음 → 회색, 알람 없음, 점수 null', () => {
  const r = deriveStatus({ hasEverPolled: false });
  assert.equal(r.status, 'nodata');
  assert.equal(r.color, 'grey');
  assert.equal(r.severity, 'unknown');
  assert.equal(r.alarmable, false);
  assert.equal(r.healthScore, null);
});

test('nodata — null도 nodata (회색)', () => {
  const r = deriveStatus(null);
  assert.equal(r.color, 'grey');
  assert.equal(r.alarmable, false);
});

test('nodata — 단발 폴링 실패(consecutiveFails<3)는 nodata (회색, 알람X)', () => {
  for (const fails of [1, 2]) {
    const r = deriveStatus({
      hasEverPolled: true, reachable: false,
      consecutiveFails: fails, error: 'timeout',
    });
    assert.equal(r.status, 'nodata', `fails=${fails}`);
    assert.equal(r.color, 'grey');
    assert.equal(r.alarmable, false);
  }
});

test('unreachable — 연속 폴링 실패 3회 이상 → 회색, 알람 발생', () => {
  const r = deriveStatus({
    hasEverPolled: true, reachable: false,
    consecutiveFails: 3, error: 'timeout',
  });
  assert.equal(r.status, 'unreachable');
  assert.equal(r.color, 'grey');        // 빨강 아님 — 사용자 명시 요구
  assert.equal(r.severity, 'unknown');  // critical과 분리
  assert.equal(r.alarmable, true);
  assert.equal(r.healthScore, null);
});

test('critical과 unreachable은 색·severity가 명확히 분리', () => {
  const crit = deriveStatus({
    hasEverPolled: true, reachable: true,
    outputStatus: OutputStatus.off,
  });
  const unr = deriveStatus({
    hasEverPolled: true, reachable: false, consecutiveFails: 5,
  });
  assert.equal(crit.severity, 'critical');
  assert.equal(crit.color, 'red');
  assert.equal(unr.severity, 'unknown');
  assert.equal(unr.color, 'grey');
});


// ── ② healthScore가 status 매핑 단일 출처 ──────────────────────────────

test('scoreToStatus 경계값 — okMin/warnMin이 단일 진실', () => {
  assert.equal(scoreToStatus(100), 'ok');
  assert.equal(scoreToStatus(SCORE_BANDS.okMin), 'ok');
  assert.equal(scoreToStatus(SCORE_BANDS.okMin - 1), 'warn');
  assert.equal(scoreToStatus(SCORE_BANDS.warnMin), 'warn');
  assert.equal(scoreToStatus(SCORE_BANDS.warnMin - 1), 'critical');
  assert.equal(scoreToStatus(0), 'critical');
  assert.equal(scoreToStatus(null), null);
});

test('정상 → score=100 → status=ok', () => {
  const r = deriveStatus({
    hasEverPolled: true, reachable: true,
    outputStatus: OutputStatus.onLine,
    batteryStatus: BatteryStatus.normal,
    outputLoadPct: 30, batteryCapacity: 90,
  });
  assert.equal(r.healthScore, 100);
  assert.equal(r.status, 'ok');
  assert.equal(r.color, 'green');
});

test('warn 점수 구간 (50~79) → status=warn', () => {
  // 부하 95% → -20 → 80. 임계 정확히 ok 경계.
  const r = deriveStatus({
    hasEverPolled: true, reachable: true,
    outputStatus: OutputStatus.onLine,
    outputLoadPct: 95,
  });
  // 80은 ok 경계, 79부터 warn. 추가 위반 필요.
  // 충전 45% → -25 → 합 -45 → 55 → warn.
  const r2 = deriveStatus({
    hasEverPolled: true, reachable: true,
    outputStatus: OutputStatus.onLine,
    outputLoadPct: 95, batteryCapacity: 45,
  });
  assert.equal(r2.status, 'warn');
  assert.equal(r2.color, 'amber');
  assert.ok(r2.healthScore >= 50 && r2.healthScore < 80);
});

test('critical 점수 구간 (<50) → status=critical (단일 출처)', () => {
  // On battery -60 → 40 → critical.
  const r = deriveStatus({
    hasEverPolled: true, reachable: true,
    outputStatus: OutputStatus.onBattery,
  });
  assert.equal(r.status, 'critical');
  assert.equal(r.color, 'red');
  assert.ok(r.healthScore < 50);
});

test('healthScore 클램프 0 (다중 critical 위반)', () => {
  const r = deriveStatus({
    hasEverPolled: true, reachable: true,
    outputStatus: OutputStatus.off,
    batteryStatus: BatteryStatus.low,
    outputLoadPct: 105,
  });
  assert.equal(r.healthScore, 0);
  assert.equal(r.status, 'critical');
});


// ── ③ aggregateCounts 정합 ────────────────────────────────────────

test('aggregateCounts — 빈 입력', () => {
  const c = aggregateCounts([]);
  assert.deepEqual(c, { ok: 0, warn: 0, critical: 0, unreachable: 0, nodata: 0, total: 0 });
});

test('aggregateCounts — 합 = total 보장', () => {
  const items = [
    { status: 'ok' }, { status: 'ok' }, { status: 'ok' },
    { status: 'warn' }, { status: 'warn' },
    { status: 'critical' },
    { status: 'unreachable' }, { status: 'unreachable' },
    { status: 'nodata' },
  ];
  const c = aggregateCounts(items);
  assert.equal(c.ok, 3);
  assert.equal(c.warn, 2);
  assert.equal(c.critical, 1);
  assert.equal(c.unreachable, 2);
  assert.equal(c.nodata, 1);
  assert.equal(c.total, 9);
  assert.equal(c.ok + c.warn + c.critical + c.unreachable + c.nodata, c.total);
});

test('aggregateCounts — 미정의 status는 nodata로 흡수 (절대 critical 아님)', () => {
  const c = aggregateCounts([
    { status: 'ok' },
    { status: 'unknown_garbage' },
    { status: undefined },
  ]);
  assert.equal(c.ok, 1);
  assert.equal(c.nodata, 2);
  assert.equal(c.critical, 0);   // 미지정은 절대 위험으로 부풀리지 않음
  assert.equal(c.total, 3);
});

test('aggregateCounts — 최상위 critical = CBU critical 동일 정의', () => {
  // 5개 CBU, 각 critical 1대. 합산 == 최상위 critical 5.
  const cbus = [
    aggregateCounts([{ status: 'critical' }, { status: 'ok' }]),
    aggregateCounts([{ status: 'critical' }, { status: 'warn' }]),
    aggregateCounts([{ status: 'critical' }, { status: 'unreachable' }]),
    aggregateCounts([{ status: 'critical' }, { status: 'nodata' }]),
    aggregateCounts([{ status: 'critical' }, { status: 'ok' }]),
  ];
  const topCritical = cbus.reduce((s, c) => s + c.critical, 0);
  assert.equal(topCritical, 5);
});


// ── ④ 알람 정합 ──────────────────────────────────────────────────

test('알람 정합 — ok/nodata는 alarmable=false', () => {
  for (const r of [
    deriveStatus({
      hasEverPolled: true, reachable: true,
      outputStatus: OutputStatus.onLine,
    }),
    deriveStatus({ hasEverPolled: false }),
    deriveStatus({ hasEverPolled: true, reachable: false, consecutiveFails: 1 }),
  ]) {
    assert.equal(r.alarmable, false, `status=${r.status} should not alarm`);
  }
});

test('알람 정합 — warn/critical/unreachable은 alarmable=true', () => {
  for (const r of [
    deriveStatus({
      hasEverPolled: true, reachable: true,
      outputStatus: OutputStatus.onLine, outputLoadPct: 95, batteryCapacity: 45,
    }),
    deriveStatus({ hasEverPolled: true, reachable: true, outputStatus: OutputStatus.onBattery }),
    deriveStatus({ hasEverPolled: true, reachable: false, consecutiveFails: 5 }),
  ]) {
    assert.equal(r.alarmable, true, `status=${r.status} must alarm`);
  }
});
