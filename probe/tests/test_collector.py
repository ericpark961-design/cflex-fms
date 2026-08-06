"""collector.py 단위테스트 — Phase 1.

MockSNMPBackend로 SNMP 응답 시뮬레이트.
실제 pysnmp는 의존성 필요 — 본 차수는 mock만.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from collector import Collector, MockSNMPBackend
from state_engine import derive_status, OutputStatus


def test_collect_apc_normal_to_reading():
    backend = MockSNMPBackend({
        "10.0.0.11": {
            "output_status": 2,           # onLine
            "battery_status": 2,          # normal
            "battery_replace": 1,
            "output_load_pct": 45,
            "battery_capacity": 85,
            "battery_temp_c": 28,
            "runtime_remaining_sec": 1800 * 100,   # timeticks
        }
    })
    col = Collector(backend)
    res = col.poll({"id": "ups-01", "ip": "10.0.0.11",
                    "snmp": {"community": "public", "port": 161},
                    "profile": "apc_smartups_rt"})
    assert res.reachable is True
    assert res.data["has_ever_polled"] is True
    assert res.data["output_status"] == OutputStatus.ON_LINE
    assert res.data["runtime_remaining_sec"] == 1800   # ticks → sec


def test_collect_unreachable_when_all_none():
    backend = MockSNMPBackend()   # 빈 응답
    col = Collector(backend)
    res = col.poll({"id": "ups-99", "ip": "10.99.99.99",
                    "snmp": {"community": "public"},
                    "profile": "apc_smartups_rt"})
    assert res.reachable is False
    assert res.data["has_ever_polled"] is True
    assert res.data["reachable"] is False


def test_collect_then_derive_pipeline():
    """end-to-end: SNMP 응답 → reading → derive_status."""
    backend = MockSNMPBackend({
        "10.0.0.11": {
            "output_status": 3,    # onBattery
            "output_load_pct": 65,
            "battery_capacity": 50,
        }
    })
    col = Collector(backend)
    res = col.poll({"id": "ups-01", "ip": "10.0.0.11",
                    "snmp": {"community": "public"},
                    "profile": "apc_smartups_rt"})
    state = derive_status(res.data, now_ts=res.ts)
    assert state.status == "critical"
    assert state.alarmable is True
    assert state.health_score is not None and state.health_score < 100


def test_collect_rfc1628_profile():
    backend = MockSNMPBackend({
        "10.0.0.12": {
            "battery_status": 2,
            "battery_capacity_pct": 70,
            "runtime_remaining_min": 30,         # 분
            "output_source": 2,                  # normal
        }
    })
    col = Collector(backend)
    res = col.poll({"id": "ups-02", "ip": "10.0.0.12",
                    "snmp": {"community": "public"},
                    "profile": "vertiv_gxt5"})
    assert res.reachable is True
    assert res.data["runtime_remaining_sec"] == 1800
    assert res.data["output_status"] == 2     # online
