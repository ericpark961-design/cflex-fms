# 단계별 진행 체크리스트

## Phase 0 — 상태 의미론 (정제 완료, 배포 대기)
✅ 5상태 분리: `ok | warn | critical | unreachable | nodata`.
✅ **unreachable/nodata는 critical과 분리 — 색=grey, severity='unknown'. 빨강 아님.**
✅ `consecutive_fails` 판정 — 단발(1~2회) 실패는 `nodata`, **3회 연속**부터 `unreachable`.
✅ **healthScore가 status 매핑 단일 출처** — 80↑=ok, 50~79=warn, <50=critical.
   nodata/unreachable은 점수 없음(별도 처리).
✅ 알람 정합: `ok`/`nodata`는 절대 alarmable=false, `warn`/`critical`/`unreachable`은 true.
✅ **카운트 정합** — `aggregateCounts`/`aggregate_counts` 단일 함수.
   `ok + warn + critical + unreachable + nodata = total` 강제.
   미정의 status는 nodata로 흡수 (절대 critical 부풀림 없음).
   최상위 critical = Σ(CBU critical) 동일 정의.
✅ `backend/services/fms-derive-status.js` — node:test **16 passed**.
✅ `probe/src/state_engine.py` — pytest **28 passed**.

**즉시 효과**
- "위험 41 / 알람 0" 모순 차단.
- 데이터없음·연결끊김이 위험 카운트 부풀리지 않음(회색).
- UI는 healthScore로 트렌드/정렬, status는 점수에서 자동 도출.

## Phase 1 — Collector + Buffer + State Engine (완료, 배포 대기)
✅ `src/state_engine.py` — 5상태 + 헬스 스코어 + stale 감지 (Python 포팅).
✅ `src/buffer.py` — SQLite store-and-forward (readings/states/egress_outbox/retention).
✅ `src/collector.py` — UPS-MIB(RFC1628) + PowerNet-MIB(APC) OID 매핑, SNMP 어댑터.
✅ `tests/` 22 passed (state_engine 12 + buffer 6 + collector 4).
✅ `config/probe.yaml` + `config/devices.yaml` — 폴링/임계/egress 정책 외부화.

**남은 작업** — pysnmp 실제 백엔드 구현 (현재 MockSNMPBackend만), `airgap`/`aggregate` 토글.

## Phase 2 — Edge Inference (예정)
- [ ] `src/edge_inference.py`
  - 배터리 EOL — 온도 10°C↑ → 수명 절반 룰 + 사용연수·내부저항 회귀
  - 이상탐지 — 장비별 EWMA 베이스라인 + N σ 이탈
  - 온도/부하 ETA — 선형 외삽 → "3일 뒤 과열 임계"
- [ ] tests/test_edge_inference.py

## Phase 3 — Triage + 작업지시 드래프트 (예정)
- [ ] `src/triage.py` — 알람 → 심각도 + 추정 원인 + 권장 런북
- [ ] 부품주문 드래프트 (사람 승인 게이트)
- [ ] 자동 RCA + 인시던트 리포트
- [ ] 감사 로그 (설명 가능성)

## Phase 4 — Egress + Updater (예정, 정책 토글 시)
- [ ] `src/egress.py` — mTLS 단방향 push, 화이트리스트 필터링
- [ ] `src/updater.py` — 서명된 모델/룰 업데이트 검증·적용

## Phase 5 — 비즈니스 루프 (예정)
- [ ] 자동주문 (배터리/UPS/칠러 교체)
- [ ] 절감액 정량화 ("막은 다운타임 = ₩")
- [ ] SLA 리포트

---

## 배포 (스펙 §10 외)
**모든 페이즈는 개발 완료까지 로컬에서만 검증.** 운영(HAEA) 배포는 별도 차수에서:
1. systemd unit + 로그 로테이션
2. SNMP credential 시크릿 관리 (별도 vault)
3. egress mTLS 인증서 배포
4. HAEA 보안팀 검토
