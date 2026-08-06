"""buffer.py 단위테스트 — Phase 1."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import tempfile
import pytest
from buffer import Buffer


@pytest.fixture
def buf():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        path = f.name
    b = Buffer(path)
    yield b
    b.close()
    Path(path).unlink(missing_ok=True)


def test_add_and_latest_reading(buf):
    buf.add_reading("ups-01", {"output_load_pct": 50}, ts=1700000000.0)
    buf.add_reading("ups-01", {"output_load_pct": 55}, ts=1700000060.0)
    r = buf.latest_reading("ups-01")
    assert r["output_load_pct"] == 55
    assert r["ts"] == 1700000060.0


def test_latest_reading_none_when_empty(buf):
    assert buf.latest_reading("ups-02") is None


def test_add_and_latest_state(buf):
    buf.add_state("ups-01", "ok", health_score=100, alarmable=False,
                  reasons=["Online"], ts=1700000000.0)
    buf.add_state("ups-01", "critical", health_score=30, alarmable=True,
                  reasons=["On battery"], ts=1700000060.0)
    s = buf.latest_state("ups-01")
    assert s["status"] == "critical"
    assert s["health_score"] == 30
    assert s["alarmable"] is True
    assert s["reasons"] == ["On battery"]


def test_egress_outbox_airgap_empty_until_enqueue(buf):
    assert buf.dequeue_pending() == []
    buf.enqueue_egress(policy="aggregate", kind="state",
                       payload={"device_id_hash": "abc", "status": "ok"})
    pending = buf.dequeue_pending()
    assert len(pending) == 1
    assert pending[0]["kind"] == "state"
    assert pending[0]["payload"]["status"] == "ok"


def test_egress_ack_removes_from_pending(buf):
    rid = buf.enqueue_egress(policy="aggregate", kind="state",
                              payload={"status": "warn"})
    buf.ack_egress([rid])
    assert buf.dequeue_pending() == []


def test_purge_old_removes_aged_rows(buf):
    import time
    buf.add_reading("ups-01", {"x": 1}, ts=time.time() - 60 * 86400)
    buf.add_reading("ups-01", {"x": 2}, ts=time.time())
    n = buf.purge_old(days=30)
    assert n == 1
    r = buf.latest_reading("ups-01")
    assert r["x"] == 2
