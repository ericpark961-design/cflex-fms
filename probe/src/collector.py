"""SNMP UPS 폴링 — Phase 1.

UPS-MIB (RFC 1628) 표준 OID + PowerNet-MIB (APC) 확장.
pysnmp 또는 (CI 환경) puresnmp 둘 다 지원하도록 어댑터 패턴.

스펙 §2 / §8 / §10 Phase 1.
"""
from __future__ import annotations
import logging
import time
from dataclasses import dataclass

log = logging.getLogger("collector")


# ── 표준 OID 매핑 (UPS-MIB / PowerNet-MIB) ──────────────────────────

# RFC 1628 UPS-MIB
RFC1628_OIDS = {
    "battery_status":          "1.3.6.1.2.1.33.1.2.1.0",
    "seconds_on_battery":      "1.3.6.1.2.1.33.1.2.2.0",
    "runtime_remaining_min":   "1.3.6.1.2.1.33.1.2.3.0",   # 분 단위
    "battery_capacity_pct":    "1.3.6.1.2.1.33.1.2.4.0",
    "battery_voltage":         "1.3.6.1.2.1.33.1.2.5.0",
    "battery_current":         "1.3.6.1.2.1.33.1.2.6.0",
    "battery_temperature_c":   "1.3.6.1.2.1.33.1.2.7.0",
    "output_source":           "1.3.6.1.2.1.33.1.4.1.0",   # 1=other, 2=normal, 3=bypass, 4=battery
}

# PowerNet-MIB (APC) — Smart-UPS 계열
APC_OIDS = {
    "output_status":            "1.3.6.1.4.1.318.1.1.1.4.1.1.0",
    "output_load_pct":          "1.3.6.1.4.1.318.1.1.1.4.2.3.0",
    "battery_status":           "1.3.6.1.4.1.318.1.1.1.2.1.1.0",
    "battery_capacity":         "1.3.6.1.4.1.318.1.1.1.2.2.1.0",
    "battery_temp_c":           "1.3.6.1.4.1.318.1.1.1.2.2.2.0",
    "runtime_remaining_sec":    "1.3.6.1.4.1.318.1.1.1.2.2.3.0",   # timeticks/100
    "battery_replace":          "1.3.6.1.4.1.318.1.1.1.2.2.4.0",
    "input_voltage":            "1.3.6.1.4.1.318.1.1.1.3.2.1.0",
    "output_voltage":           "1.3.6.1.4.1.318.1.1.1.4.2.1.0",
}


@dataclass
class CollectResult:
    device_id: str
    reachable: bool
    ts: float
    data: dict      # 정규화된 reading (state_engine.derive_status 입력 형식)
    error: str | None = None
    raw: dict | None = None


# ── SNMP 백엔드 어댑터 ───────────────────────────────────────────────

class SNMPBackend:
    """SNMP get_many 어댑터 — pysnmp 의존성 부재 환경에서도 mock으로 작동."""

    def get_many(self, ip: str, port: int, community: str,
                 oids: dict[str, str], timeout: float = 5.0) -> dict[str, str | None]:
        raise NotImplementedError


class MockSNMPBackend(SNMPBackend):
    """테스트·데모용. 사전 등록된 응답을 반환."""

    def __init__(self, responses: dict[str, dict[str, str | None]] | None = None):
        # responses: {ip → {oid_short → value}}  (short = key name 또는 OID)
        self.responses = responses or {}

    def get_many(self, ip, port, community, oids, timeout=5.0):
        store = self.responses.get(ip, {})
        out = {}
        for k, oid in oids.items():
            if k in store:
                out[k] = store[k]
            elif oid in store:
                out[k] = store[oid]
            else:
                out[k] = None
        return out


# pysnmp 실제 백엔드는 의존성 설치 후 별도 구현 — 본 차수는 mock으로만 검증.


# ── Collector 본체 ─────────────────────────────────────────────────

class Collector:
    def __init__(self, backend: SNMPBackend):
        self.backend = backend

    def poll(self, device: dict) -> CollectResult:
        """devices.yaml 엔트리 1건 → 정규화된 reading.

        device: {id, ip, snmp:{community, port, version}, profile}
        """
        device_id = device["id"]
        ip = device["ip"]
        snmp = device.get("snmp") or {}
        community = snmp.get("community", "public")
        port = int(snmp.get("port", 161))
        timeout = float(device.get("timeout_sec", 5.0))
        profile = (device.get("profile") or "apc_smartups_rt").lower()

        # 프로파일 → MIB 선택
        oid_map = APC_OIDS if profile.startswith("apc") else RFC1628_OIDS

        try:
            raw = self.backend.get_many(ip, port, community, oid_map, timeout=timeout)
        except Exception as e:
            log.warning("collect %s SNMP error: %s", device_id, type(e).__name__)
            return CollectResult(
                device_id=device_id, reachable=False,
                ts=time.time(), data={"has_ever_polled": True, "reachable": False,
                                       "error": str(e)},
                error=str(e),
            )

        if all(v is None for v in (raw or {}).values()):
            return CollectResult(
                device_id=device_id, reachable=False,
                ts=time.time(),
                data={"has_ever_polled": True, "reachable": False,
                      "error": "no SNMP response"},
                error="no response",
                raw=raw,
            )

        # 정규화 — APC는 timeticks(1/100s), RFC1628은 minute. 통일된 reading 형태.
        reading = {"has_ever_polled": True, "reachable": True}
        if profile.startswith("apc"):
            reading["output_status"] = _to_int(raw.get("output_status"))
            reading["battery_status"] = _to_int(raw.get("battery_status"))
            reading["battery_replace"] = _to_int(raw.get("battery_replace"))
            reading["output_load_pct"] = _to_int(raw.get("output_load_pct"))
            reading["battery_capacity"] = _to_int(raw.get("battery_capacity"))
            reading["battery_temp_c"] = _to_int(raw.get("battery_temp_c"))
            rt_ticks = _to_int(raw.get("runtime_remaining_sec"))
            if rt_ticks is not None:
                reading["runtime_remaining_sec"] = rt_ticks // 100  # ticks → sec
        else:  # RFC 1628
            reading["battery_status"] = _to_int(raw.get("battery_status"))
            reading["battery_capacity"] = _to_int(raw.get("battery_capacity_pct"))
            reading["battery_temp_c"] = _to_int(raw.get("battery_temperature_c"))
            rt_min = _to_int(raw.get("runtime_remaining_min"))
            if rt_min is not None:
                reading["runtime_remaining_sec"] = rt_min * 60
            src = _to_int(raw.get("output_source"))
            # output_source 4=onBattery → output_status onBattery(3) 매핑
            if src == 4: reading["output_status"] = 3
            elif src == 3: reading["output_status"] = 9  # bypass
            elif src == 2: reading["output_status"] = 2  # online

        return CollectResult(
            device_id=device_id, reachable=True,
            ts=time.time(), data=reading, raw=raw,
        )


def _to_int(v) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
