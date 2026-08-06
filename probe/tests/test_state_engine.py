"""state_engine 단위테스트 — Phase 0 정제.

검증:
  ① unreachable / nodata 분리 (consecutive_fails 판정, 둘 다 회색).
  ② health_score → status 단일 출처.
  ③ aggregate_counts 정합 (합 = total).
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import pytest
from state_engine import (
    derive_status, aggregate_counts, score_to_status,
    SCORE_BANDS, UNREACHABLE_AFTER_FAILS,
    OutputStatus, BatteryStatus, REPLACE_NEEDED,
)


# ── ① unreachable / nodata 분리 ──────────────────────────────────────

def test_nodata_when_never_polled():
    r = derive_status({"has_ever_polled": False})
    assert r.status == "nodata"
    assert r.color == "grey"
    assert r.severity == "unknown"
    assert r.alarmable is False
    assert r.health_score is None


def test_nodata_when_reading_none():
    r = derive_status(None)
    assert r.color == "grey"
    assert r.alarmable is False


def test_nodata_when_single_poll_fail():
    """단발(1~2회) 폴링 실패는 nodata — 회색·알람 없음."""
    for fails in (1, 2):
        r = derive_status({
            "has_ever_polled": True, "reachable": False,
            "consecutive_fails": fails, "poll_error": "timeout",
        })
        assert r.status == "nodata"
        assert r.color == "grey"
        assert r.alarmable is False


def test_unreachable_after_3_consecutive_fails():
    r = derive_status({
        "has_ever_polled": True, "reachable": False,
        "consecutive_fails": 3, "poll_error": "timeout",
    })
    assert r.status == "unreachable"
    assert r.color == "grey"            # 빨강 아님
    assert r.severity == "unknown"      # critical과 분리
    assert r.alarmable is True
    assert r.health_score is None


def test_critical_vs_unreachable_clearly_separated():
    crit = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.OFF,
    })
    unr = derive_status({
        "has_ever_polled": True, "reachable": False, "consecutive_fails": 5,
    })
    assert crit.severity == "critical"
    assert crit.color == "red"
    assert unr.severity == "unknown"
    assert unr.color == "grey"


# ── ② health_score → status 단일 출처 ──────────────────────────────

def test_score_to_status_boundaries():
    assert score_to_status(100) == "ok"
    assert score_to_status(SCORE_BANDS["ok_min"]) == "ok"
    assert score_to_status(SCORE_BANDS["ok_min"] - 1) == "warn"
    assert score_to_status(SCORE_BANDS["warn_min"]) == "warn"
    assert score_to_status(SCORE_BANDS["warn_min"] - 1) == "critical"
    assert score_to_status(0) == "critical"
    assert score_to_status(None) is None


def test_ok_full_normal_score_100():
    r = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.ON_LINE,
        "battery_status": BatteryStatus.NORMAL,
        "output_load_pct": 50, "battery_capacity": 80,
    })
    assert r.health_score == 100
    assert r.status == "ok"
    assert r.color == "green"


def test_warn_band_50_to_79():
    # load 95% (-20) + capacity 45% (-25) → 55. warn 구간.
    r = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.ON_LINE,
        "output_load_pct": 95, "battery_capacity": 45,
    })
    assert r.status == "warn"
    assert r.color == "amber"
    assert 50 <= r.health_score < 80


def test_critical_band_below_50():
    # On battery (-60) → 40. critical.
    r = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.ON_BATTERY,
    })
    assert r.status == "critical"
    assert r.color == "red"
    assert r.health_score < 50


def test_score_clamped_to_zero_on_multi_critical():
    r = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.OFF,
        "battery_status": BatteryStatus.LOW,
        "output_load_pct": 105,
    })
    assert r.health_score == 0
    assert r.status == "critical"


def test_replace_battery_warn_via_score():
    r = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.ON_LINE,
        "battery_replace": REPLACE_NEEDED,
    })
    # -25 → 75 → warn 구간.
    assert r.health_score == 75
    assert r.status == "warn"


def test_threshold_override_per_profile():
    """devices.yaml profile이 임계 override — 빡센 임계는 더 낮은 부하에서 warn 발동."""
    # 기본 임계로는 91% 부하 → -20 → 80 → ok 경계. capacity_warn=80 override로 충전 60%를 warn으로.
    r = derive_status({
        "has_ever_polled": True, "reachable": True,
        "output_status": OutputStatus.ON_LINE,
        "battery_capacity": 60,
    }, thresholds={"capacity_warn": 80})
    # 충전 60% < capacity_warn 80 → charge_warn -25 → score 75 → warn.
    assert r.status == "warn"


# ── ③ aggregate_counts 정합 ───────────────────────────────────────

def test_aggregate_counts_empty():
    c = aggregate_counts([])
    assert c == {"ok": 0, "warn": 0, "critical": 0,
                 "unreachable": 0, "nodata": 0, "total": 0}


def test_aggregate_counts_sum_equals_total():
    items = [
        {"status": "ok"}, {"status": "ok"}, {"status": "ok"},
        {"status": "warn"}, {"status": "warn"},
        {"status": "critical"},
        {"status": "unreachable"}, {"status": "unreachable"},
        {"status": "nodata"},
    ]
    c = aggregate_counts(items)
    assert c["ok"] == 3
    assert c["warn"] == 2
    assert c["critical"] == 1
    assert c["unreachable"] == 2
    assert c["nodata"] == 1
    assert c["total"] == 9
    assert c["ok"] + c["warn"] + c["critical"] + c["unreachable"] + c["nodata"] == c["total"]


def test_aggregate_counts_unknown_status_absorbed_to_nodata():
    """미정의 status는 nodata로 흡수 — 절대 critical 부풀리지 않음."""
    c = aggregate_counts([
        {"status": "ok"},
        {"status": "garbage_value"},
        {"status": None},
        {},
    ])
    assert c["ok"] == 1
    assert c["nodata"] == 3
    assert c["critical"] == 0
    assert c["total"] == 4


def test_aggregate_counts_top_equals_sum_of_cbus():
    """최상위 critical 카운트 == 모든 CBU critical 합."""
    cbus = [
        aggregate_counts([{"status": "critical"}, {"status": "ok"}]),
        aggregate_counts([{"status": "critical"}, {"status": "warn"}]),
        aggregate_counts([{"status": "critical"}, {"status": "unreachable"}]),
        aggregate_counts([{"status": "critical"}, {"status": "nodata"}]),
        aggregate_counts([{"status": "critical"}, {"status": "ok"}]),
    ]
    top_critical = sum(c["critical"] for c in cbus)
    assert top_critical == 5


# ── ④ 알람 정합 ──────────────────────────────────────────────────

def test_alarm_ok_nodata_not_alarmable():
    for r in [
        derive_status({"has_ever_polled": True, "reachable": True,
                       "output_status": OutputStatus.ON_LINE}),
        derive_status({"has_ever_polled": False}),
        derive_status({"has_ever_polled": True, "reachable": False,
                       "consecutive_fails": 1}),
    ]:
        assert r.alarmable is False


def test_alarm_warn_critical_unreachable_alarmable():
    for r in [
        derive_status({"has_ever_polled": True, "reachable": True,
                       "output_status": OutputStatus.ON_LINE,
                       "output_load_pct": 95, "battery_capacity": 45}),
        derive_status({"has_ever_polled": True, "reachable": True,
                       "output_status": OutputStatus.ON_BATTERY}),
        derive_status({"has_ever_polled": True, "reachable": False,
                       "consecutive_fails": 5}),
    ]:
        assert r.alarmable is True
