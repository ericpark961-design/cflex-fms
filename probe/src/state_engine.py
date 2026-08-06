"""상태 엔진 — Phase 0 정제.

지시(사용자):
  1. unreachable / 데이터없음을 critical과 분리.
     - consecutive_fails / poll_error로 판정.
     - nodata는 회색(중립), 빨강 아님.
  2. 카운트 정합 — 최상위 critical = CBU critical 동일 정의.
     online + warn + critical + unreachable + nodata = total. aggregate_counts 한 함수만.
  3. health_score 가 status 매핑 단일 출처.
     정상/경고/위험은 점수 구간(OK_MIN/WARN_MIN). 데이터없음·unreachable은 점수 없음(별도).
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Iterable
import time


THRESHOLDS = {
    "load_critical": 100, "load_warn": 90,
    "capacity_critical": 30, "capacity_warn": 50,
    "temp_warn_c": 45, "runtime_warn_sec": 300,
}

PENALTY = {
    "output_off": 100, "hardware_fault": 100, "awaiting_power": 80,
    "on_battery": 60, "battery_low": 70, "overload": 70, "charge_critical": 60,
    "bypass": 30, "smart_boost_trim": 20, "self_test": 10,
    "replace_battery": 25, "charge_warn": 25, "load_warn": 20,
    "temp_warn": 15, "runtime_warn": 25,
}

# score → status 단일 매핑
SCORE_BANDS = {"ok_min": 80, "warn_min": 50}

# 연속 실패 임계
UNREACHABLE_AFTER_FAILS = 3


class OutputStatus:
    UNKNOWN = 1; ON_LINE = 2; ON_BATTERY = 3; ON_SMART_BOOST = 4
    TIMED_SLEEPING = 5; SOFTWARE_BYPASS = 6; OFF = 7; REBOOTING = 8
    SWITCHED_BYPASS = 9; HARDWARE_FAULT_BYPASS = 10
    SLEEPING_UNTIL_POWER_RETURN = 11; ON_SMART_TRIM = 12
    ECO_MODE = 13; HOT_STANDBY = 14; ON_BATTERY_TEST = 15
    EMERGENCY_STATIC_BYPASS = 16


class BatteryStatus:
    UNKNOWN = 1; NORMAL = 2; LOW = 3


REPLACE_NEEDED = 2

OUTPUT_LABEL = {
    1: "Unknown", 2: "Online", 3: "On Battery", 4: "Smart Boost", 5: "Timed Sleeping",
    6: "Software Bypass", 7: "Off", 8: "Rebooting", 9: "Switched Bypass",
    10: "Hardware Fault Bypass", 11: "Sleeping", 12: "Smart Trim", 13: "ECO Mode",
    14: "Hot Standby", 15: "Battery Test", 16: "Emergency Static Bypass",
}

# status → (severity, color, alarmable)
# unreachable·nodata는 critical과 명확히 분리, 회색.
STATUS_META = {
    "ok":          ("ok",       "green", False),
    "warn":        ("warn",     "amber", True),
    "critical":    ("critical", "red",   True),
    "unreachable": ("unknown",  "grey",  True),    # 알람 대상이지만 색은 회색
    "nodata":      ("unknown",  "grey",  False),
}


@dataclass
class StateResult:
    status: str
    severity: str
    color: str
    reasons: list[str]
    health_score: int | None
    alarmable: bool


def score_to_status(score: int | None) -> str | None:
    """health_score → status. 단일 진실 매핑."""
    if score is None:
        return None
    if score >= SCORE_BANDS["ok_min"]:
        return "ok"
    if score >= SCORE_BANDS["warn_min"]:
        return "warn"
    return "critical"


def derive_status(
    reading: dict[str, Any] | None,
    *,
    thresholds: dict | None = None,
    now_ts: float | None = None,
) -> StateResult:
    """장비 한 대 reading → 상태/근거/점수.

    reading 필드:
      has_ever_polled: bool — false면 nodata.
      reachable: bool — false면 consecutive_fails로 nodata/unreachable 판정.
      consecutive_fails: int — UNREACHABLE_AFTER_FAILS 이상이면 unreachable.
      poll_error / error: str — unreachable 사유.
      output_status, battery_status, battery_replace, output_load_pct,
      battery_capacity, battery_temp_c, runtime_remaining_sec
    """
    th = {**THRESHOLDS, **(thresholds or {})}

    # 1) 미연동 — nodata (회색)
    if reading is None or reading.get("has_ever_polled") is False:
        return _finalize("nodata", ["연동 전 — 폴링 데이터 없음"], None)

    # 2) 연속 폴링 실패 — N회 이상이면 unreachable (회색·알람)
    fails = int(reading.get("consecutive_fails") or 0)
    err = reading.get("poll_error") or reading.get("error")
    if reading.get("reachable") is False:
        if fails >= UNREACHABLE_AFTER_FAILS:
            reason = (f"SNMP: {err} ({fails}회 연속)" if err
                      else f"Unreachable ({fails}회 연속)")
            return _finalize("unreachable", [reason], None)
        # 단발 실패 — nodata (마지막 캐시 신뢰, 회색)
        why = (f"폴링 실패 {fails}/{UNREACHABLE_AFTER_FAILS}회 ({err})" if err
               else f"폴링 실패 {fails}/{UNREACHABLE_AFTER_FAILS}회")
        return _finalize("nodata", [why], None)

    # 3) 정상 평가 — 점수 100에서 위반마다 차감.
    reasons: list[str] = []
    score = 100

    def penalize(why: str, p: int) -> None:
        nonlocal score
        reasons.append(why)
        score -= p

    os = reading.get("output_status")
    os_label = OUTPUT_LABEL.get(os, f"Status {os}") if os is not None else "Unknown"
    load = reading.get("output_load_pct")
    cap = reading.get("battery_capacity")
    temp = reading.get("battery_temp_c")
    rt = reading.get("runtime_remaining_sec")
    bs = reading.get("battery_status")
    br = reading.get("battery_replace")

    # critical penalties
    if os == OutputStatus.OFF: penalize("Output OFF", PENALTY["output_off"])
    if os == OutputStatus.HARDWARE_FAULT_BYPASS:
        penalize("Hardware fault bypass", PENALTY["hardware_fault"])
    if os == OutputStatus.SLEEPING_UNTIL_POWER_RETURN:
        penalize("Awaiting power return", PENALTY["awaiting_power"])
    if os == OutputStatus.ON_BATTERY: penalize("On battery", PENALTY["on_battery"])
    if bs == BatteryStatus.LOW: penalize("Battery low", PENALTY["battery_low"])
    if load is not None and load > th["load_critical"]:
        penalize(f"Overload {load}%", PENALTY["overload"])
    if cap is not None and cap < th["capacity_critical"]:
        penalize(f"Charge {cap}%", PENALTY["charge_critical"])

    # warn penalties
    if os in (OutputStatus.SOFTWARE_BYPASS, OutputStatus.SWITCHED_BYPASS,
              OutputStatus.EMERGENCY_STATIC_BYPASS):
        penalize(os_label, PENALTY["bypass"])
    if os in (OutputStatus.ON_SMART_BOOST, OutputStatus.ON_SMART_TRIM):
        penalize(os_label, PENALTY["smart_boost_trim"])
    if os == OutputStatus.ON_BATTERY_TEST:
        penalize("Self-test running", PENALTY["self_test"])
    if br == REPLACE_NEEDED:
        penalize("Replace battery", PENALTY["replace_battery"])
    if cap is not None and th["capacity_critical"] <= cap < th["capacity_warn"]:
        penalize(f"Charge {cap}%", PENALTY["charge_warn"])
    if load is not None and th["load_warn"] < load <= th["load_critical"]:
        penalize(f"High load {load}%", PENALTY["load_warn"])
    if temp is not None and temp > th["temp_warn_c"]:
        penalize(f"Battery {temp}°C", PENALTY["temp_warn"])
    if rt is not None and rt < th["runtime_warn_sec"]:
        penalize(f"Runtime {int(rt / 60)} min", PENALTY["runtime_warn"])

    health_score = max(0, min(100, int(round(score))))
    status = score_to_status(health_score)            # 단일 출처
    if status == "ok":
        reasons.append(os_label or "Online")
    return _finalize(status, reasons, health_score)


def _finalize(status: str, reasons: list[str], health_score: int | None) -> StateResult:
    sev, color, alarmable = STATUS_META[status]
    return StateResult(
        status=status, severity=sev, color=color,
        reasons=reasons, health_score=health_score, alarmable=alarmable,
    )


def aggregate_counts(items: Iterable[dict]) -> dict[str, int]:
    """카운트 정합 — 최상위 = CBU 동일 정의.

    합 = total 보장. 미정의 status는 nodata로 흡수 (절대 critical 부풀리지 않음).
    """
    c = {"ok": 0, "warn": 0, "critical": 0, "unreachable": 0, "nodata": 0, "total": 0}
    for it in (items or []):
        s = (it or {}).get("status")
        if s in c and s != "total":
            c[s] += 1
        else:
            c["nodata"] += 1
        c["total"] += 1
    total = c["ok"] + c["warn"] + c["critical"] + c["unreachable"] + c["nodata"]
    if total != c["total"]:
        raise AssertionError(f"aggregate_counts mismatch: sum={total} total={c['total']}")
    return c
