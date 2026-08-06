# Runless 온프렘 프로브 (HAEA 1차 대상)

> 스펙: `../../stock-sentinel/runless_프로브_아키텍처_스펙.md`
> Phase 0(상태 의미론) — 본 cflex-fms backend에 이미 반영(`backend/services/fms-derive-status.js`).
> Phase 1+ — 본 디렉토리.

## 기본 결정 (스펙 §11)
| 항목 | 1차 값 | 비고 |
|---|---|---|
| egress 정책 | `airgap` | 100% 로컬. 모든 페이즈는 egress 0으로도 작동. 추후 토글로 `aggregate`/`federated` 전환 |
| 런타임 | Python 3.11+ | cflex/stock-sentinel과 동일 스택. pysnmp · httpx · sqlite3 |
| 1차 장비 | UPS만 (SNMP UPS-MIB / PowerNet-MIB) | 44 대 (HAEA). 칠러·센서는 Phase 2/3 |

## 디렉토리
```
probe/
  src/
    collector.py      Phase 1: SNMP UPS 폴링 (UPS-MIB 표준 OID)
    buffer.py         Phase 1: 로컬 SQLite store-and-forward
    state_engine.py   Phase 1: 결정론 상태머신 (5상태) + 헬스 스코어
    edge_inference.py Phase 2: 배터리 EOL / 이상탐지 / ETA
    triage.py         Phase 3: 자동 트리아지 + 권장 런북
    egress.py         (off 기본) Phase 4: mTLS 단방향 push
    updater.py        (off 기본) Phase 4: 서명된 모델 업데이트 수신
  config/
    probe.yaml        폴링 주기 · 임계 · egress 토글
    devices.yaml      대상 UPS 목록 (IP · community · 모델 프로파일)
  tests/
    test_collector.py
    test_state_engine.py
    test_buffer.py
  docs/
    OIDS.md           UPS-MIB 표준 OID 매핑
    PHASES.md         단계별 체크리스트
```

## 진행
- ✅ Phase 0 — 상태 5분리 + 헬스 스코어 + 알람 정합 (cflex-fms backend, 10 passed)
- ⏳ Phase 1 — Collector + Buffer + State Engine
- ⏳ Phase 2 — Edge Inference
- ⏳ Phase 3 — Triage + 작업지시 드래프트
- ⏳ Phase 4 — Egress + Updater (`airgap` → `aggregate` 토글 시)
- ⏳ Phase 5 — 비즈니스 루프 (자동주문 · 절감 정량화)

## 배포 (추후)
운영 배포는 별도 차수. 현 단계는 개발만 — 로컬에서 pytest로 검증.
