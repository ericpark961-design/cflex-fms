// services/fms-derive-status.js — Phase 0 정제.
//
// 사용자 지시:
// 1. unreachable / 데이터없음은 critical과 분리 — consecutive_fails·poll_error로 판정.
//    nodata는 회색(중립). 빨강 아님.
// 2. 카운트 정합 — 최상위 critical = CBU critical 동일 정의.
//    online + unreachable + nodata + warn + critical = total. 보장.
// 3. healthScore가 상태 매핑의 단일 출처.
//    정상/경고/위험은 healthScore 구간에서. 데이터없음·unreachable은 점수 없음(별도).
//
// 출력 contract:
//   { status, severity, color, reasons[], healthScore, alarmable }
//   severity: 'critical' | 'warn' | 'ok' | 'unknown'  (UI 정렬용)
//   color:    'red' | 'amber' | 'green' | 'grey'      (UI 색)

const THRESHOLDS = {
  loadCritical: 100,
  loadWarning: 90,
  capacityCritical: 30,
  capacityWarning: 50,
  tempWarningC: 45,
  runtimeWarningSec: 300,
};

const PENALTY = {
  outputOff: 100, hardwareFault: 100, awaitingPower: 80,
  onBattery: 60, batteryLow: 70, overload: 70, chargeCritical: 60,
  bypass: 30, smartBoostTrim: 20, selfTest: 10,
  replaceBattery: 25, chargeWarn: 25, loadWarn: 20,
  tempWarn: 15, runtimeWarn: 25,
};

// healthScore → status 단일 매핑 (지시서 §3)
const SCORE_BANDS = {
  okMin: 80,        // 80~100 → ok
  warnMin: 50,      // 50~79  → warn
                    // 0~49   → critical
};

// unreachable 판정 — 폴링 시도 N회 연속 실패 시
const UNREACHABLE_AFTER_FAILS = 3;

const OutputStatus = {
  unknown: 1, onLine: 2, onBattery: 3, onSmartBoost: 4, timedSleeping: 5,
  softwareBypass: 6, off: 7, rebooting: 8, switchedBypass: 9,
  hardwareFailureBypass: 10, sleepingUntilPowerReturn: 11, onSmartTrim: 12,
  ecoMode: 13, hotStandby: 14, onBatteryTest: 15, emergencyStaticBypass: 16,
};
const BatteryStatus = { unknown: 1, normal: 2, low: 3 };
const ReplaceIndicator = { no: 1, needsReplacing: 2 };
const OUTPUT_STATUS_LABEL = {
  1: 'Unknown', 2: 'Online', 3: 'On Battery', 4: 'Smart Boost', 5: 'Timed Sleeping',
  6: 'Software Bypass', 7: 'Off', 8: 'Rebooting', 9: 'Switched Bypass',
  10: 'Hardware Fault Bypass', 11: 'Sleeping', 12: 'Smart Trim', 13: 'ECO Mode',
  14: 'Hot Standby', 15: 'Battery Test', 16: 'Emergency Static Bypass',
};

// status → {severity, color, alarmable}.
// severity는 정렬·집계용. color는 UI 색. unreachable·nodata는 critical과 분리.
const STATUS_META = {
  ok:          { severity: 'ok',       color: 'green', alarmable: false },
  warn:        { severity: 'warn',     color: 'amber', alarmable: true  },
  critical:    { severity: 'critical', color: 'red',   alarmable: true  },
  unreachable: { severity: 'unknown',  color: 'grey',  alarmable: true  },  // 운영 대응 필요지만 색은 회색
  nodata:      { severity: 'unknown',  color: 'grey',  alarmable: false },  // 회색·알람 없음
};


function scoreToStatus(score) {
  if (score == null) return null;
  if (score >= SCORE_BANDS.okMin) return 'ok';
  if (score >= SCORE_BANDS.warnMin) return 'warn';
  return 'critical';
}


/**
 * Reading shape:
 *   { hasEverPolled, reachable, error,
 *     consecutiveFails,                          // 연속 폴링 실패 횟수
 *     outputStatus, batteryStatus, batteryReplace,
 *     outputLoadPct, batteryCapacity, batteryTempC, runtimeRemainingSec }
 */
function deriveStatus(r) {
  // 1) 미연동·폴링 없음 → nodata (회색, 알람 없음)
  if (r == null || r.hasEverPolled === false) {
    return finalize('nodata', ['연동 전 — 폴링 데이터 없음'], null);
  }

  // 2) 연속 폴링 실패 N회 → unreachable (회색, 알람 발생).
  //    단발 실패는 unreachable 아님 (캐시된 마지막 상태 유지하고 싶지만 ts stale로 별도 처리).
  const fails = Number(r.consecutiveFails || 0);
  if (r.reachable === false && fails >= UNREACHABLE_AFTER_FAILS) {
    const reason = r.error ? `SNMP: ${r.error} (${fails}회 연속)` :
                              `Unreachable (${fails}회 연속)`;
    return finalize('unreachable', [reason], null);
  }
  // 3) 단발 실패(1~2회) → nodata로 처리. 캐시 신뢰. UI는 stale 표시 권장.
  if (r.reachable === false) {
    const why = r.error ? `폴링 실패 ${fails}/${UNREACHABLE_AFTER_FAILS}회 (${r.error})`
                         : `폴링 실패 ${fails}/${UNREACHABLE_AFTER_FAILS}회`;
    return finalize('nodata', [why], null);
  }

  // 4) 정상 평가 — 점수 100에서 위반마다 차감. status는 점수에서 파생(단일 출처).
  const reasons = [];
  let score = 100;
  const penalize = (why, p) => { reasons.push(why); score -= p; };

  const os = r.outputStatus;
  const osLabel = os != null ? (OUTPUT_STATUS_LABEL[os] || `Status ${os}`) : 'Unknown';

  // critical penalties
  if (os === OutputStatus.off) penalize('Output OFF', PENALTY.outputOff);
  if (os === OutputStatus.hardwareFailureBypass) penalize('Hardware fault bypass', PENALTY.hardwareFault);
  if (os === OutputStatus.sleepingUntilPowerReturn) penalize('Awaiting power return', PENALTY.awaitingPower);
  if (os === OutputStatus.onBattery) penalize('On battery', PENALTY.onBattery);
  if (r.batteryStatus === BatteryStatus.low) penalize('Battery low', PENALTY.batteryLow);
  if (r.outputLoadPct != null && r.outputLoadPct > THRESHOLDS.loadCritical)
    penalize(`Overload ${r.outputLoadPct}%`, PENALTY.overload);
  if (r.batteryCapacity != null && r.batteryCapacity < THRESHOLDS.capacityCritical)
    penalize(`Charge ${r.batteryCapacity}%`, PENALTY.chargeCritical);

  // warn penalties
  if (os === OutputStatus.softwareBypass || os === OutputStatus.switchedBypass || os === OutputStatus.emergencyStaticBypass)
    penalize(osLabel, PENALTY.bypass);
  if (os === OutputStatus.onSmartBoost || os === OutputStatus.onSmartTrim)
    penalize(osLabel, PENALTY.smartBoostTrim);
  if (os === OutputStatus.onBatteryTest) penalize('Self-test running', PENALTY.selfTest);
  if (r.batteryReplace === ReplaceIndicator.needsReplacing) penalize('Replace battery', PENALTY.replaceBattery);
  if (r.batteryCapacity != null && r.batteryCapacity < THRESHOLDS.capacityWarning && r.batteryCapacity >= THRESHOLDS.capacityCritical)
    penalize(`Charge ${r.batteryCapacity}%`, PENALTY.chargeWarn);
  if (r.outputLoadPct != null && r.outputLoadPct > THRESHOLDS.loadWarning && r.outputLoadPct <= THRESHOLDS.loadCritical)
    penalize(`High load ${r.outputLoadPct}%`, PENALTY.loadWarn);
  if (r.batteryTempC != null && r.batteryTempC > THRESHOLDS.tempWarningC)
    penalize(`Battery ${r.batteryTempC}°C`, PENALTY.tempWarn);
  if (r.runtimeRemainingSec != null && r.runtimeRemainingSec < THRESHOLDS.runtimeWarningSec)
    penalize(`Runtime ${Math.round(r.runtimeRemainingSec / 60)} min`, PENALTY.runtimeWarn);

  const healthScore = Math.max(0, Math.min(100, Math.round(score)));
  const status = scoreToStatus(healthScore);   // 단일 출처
  if (status === 'ok') reasons.push(osLabel || 'Online');
  return finalize(status, reasons, healthScore);
}


function finalize(status, reasons, healthScore) {
  const meta = STATUS_META[status];
  return {
    status,
    severity: meta.severity,
    color: meta.color,
    reasons,
    healthScore,
    alarmable: meta.alarmable,
  };
}


/**
 * 카운트 집계 — 사용자 지시 #2 정합성.
 * 최상위 dashboard와 CBU별 dashboard 모두 이 함수만 호출.
 *
 * 입력: [{ status, ... }] 리스트.
 * 출력: { ok, warn, critical, unreachable, nodata, total } — 합 = total 보장.
 */
function aggregateCounts(items) {
  const c = { ok: 0, warn: 0, critical: 0, unreachable: 0, nodata: 0, total: 0 };
  for (const it of items || []) {
    const s = it && it.status;
    if (s in c) c[s] += 1;
    else c.nodata += 1;          // 미정의 상태는 회색으로 흡수 (절대 critical 아님)
    c.total += 1;
  }
  // 검증: 합 = total. 위반하면 호출부 입력 오류.
  const sum = c.ok + c.warn + c.critical + c.unreachable + c.nodata;
  if (sum !== c.total) {
    throw new Error(`aggregateCounts mismatch: sum=${sum} total=${c.total}`);
  }
  return c;
}


module.exports = {
  deriveStatus, aggregateCounts,
  scoreToStatus,
  THRESHOLDS, PENALTY, SCORE_BANDS, UNREACHABLE_AFTER_FAILS,
  OutputStatus, BatteryStatus, ReplaceIndicator, OUTPUT_STATUS_LABEL,
  STATUS_META,
};
