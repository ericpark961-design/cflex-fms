# 작업 지시서: cflex CUCM → Microsoft Teams 자동 마이그레이션 모듈

> 본 문서는 Claude Code에 전달하는 개발 작업 지시서입니다.
> 대상 제품: cflex (UC 마이그레이션/관리 솔루션)
> 작성일: 2026-06-10

---

## 1. 목표

Cisco CUCM(Unified Communications Manager)의 사용자 및 텔레포니 설정을 추출하여 Microsoft Teams Phone으로 자동 프로비저닝하는 마이그레이션 모듈을 개발한다. cflex의 핵심 기능으로 탑재하며, ipilot 기능과 연계하여 마이그레이션 과정의 지능형 보조(매핑 추천, 검증, 예외 처리 안내)를 제공한다.

## 2. 범위

### 포함
- CUCM 설정 추출 (AXL API 기반)
- CUCM → Teams 매핑/변환 엔진 (룰 기반 + ipilot 연계)
- Teams 프로비저닝 (Graph API + Teams PowerShell)
- 사전 검증(Pre-flight check), 시뮬레이션(Dry-run), 롤백
- 마이그레이션 대시보드/리포트 (배치 단위 진행률, 성공/실패/보류)
- ipilot 연계 인터페이스

### 제외
- 전화번호 포팅 (통신사 절차, API 미지원 — 수동 가이드만 제공)
- SBC 자체 설정 자동화 (1차 릴리스 제외, 설정 가이드 문서 출력까지만)
- CUCM 외 PBX (Avaya 등은 차기 버전)

## 3. 아키텍처

```
[CUCM] --AXL(SOAP)--> [Extractor] --> [정규화 DB (중간 스키마)]
                                            |
                                     [매핑/변환 엔진] <--> [ipilot 연계 API]
                                            |
                                     [Provisioner]
                                      /          \
                          [Graph API]            [PowerShell Runner]
                          (사용자/라이선스)        (음성정책/번호/AA/CQ)
                                            |
                                     [검증 & 리포트]
```

### 배포 모델 (2가지 모두 지원할 것)

**A. 프로브형 (기본)**
- CUCM AXL은 고객 내부망에만 노출되므로, Extractor를 경량 프로브(에이전트)로 분리하여 고객 내부망 VM에 탑재 (기존 FMS 프로브와 동일 패턴)
- 프로브 → cflex 서버 통신은 아웃바운드 HTTPS 443 단방향만 사용 (인바운드 포트 개방 불요)
- 매핑엔진, ipilot 연계, Provisioner는 cflex 서버(클라우드/IDC)에서 실행
- 프로브 요구사항: 단일 바이너리 또는 Docker 컨테이너로 패키징, 자동 업데이트, 수집 데이터 전송 전 암호화, 오프라인 버퍼링(망 단절 시 재전송)

```
[고객 내부망 VM: cflex 프로브(Extractor)] --443 outbound--> [cflex 서버: 매핑엔진+ipilot+Provisioner] --> [Microsoft 365]
```

**B. 풀 온프레미스형 (공공/금융 등 데이터 반출 불가 고객)**
- Extractor + 매핑엔진 + DB + Provisioner 전체를 고객 내부망 VM에 설치
- Provisioner만 프록시 경유로 Microsoft 365 구간(Graph, PowerShell 엔드포인트) 아웃바운드 허용 필요 — 필요 도메인/포트 목록을 설치 가이드에 명시할 것
- ipilot 연계는 온프레미스 환경에서의 동작 방식(로컬 모델 또는 비활성화 옵션)을 ipilot 담당자와 협의

설치/업그레이드는 두 모델 모두 스크립트 한 번으로 가능하게 할 것 (Ansible 또는 셸 인스톨러).

### 기술 스택
- 백엔드: Python 3.11+ (FastAPI)
- CUCM 연동: `zeep` (AXL SOAP), AXL 스키마 v12.5/v14/v15 지원
- Teams 연동: Microsoft Graph API (`msal` 인증) + MicrosoftTeams PowerShell 모듈 (PowerShell 7, 컨테이너 기반 Runner)
- 중간 데이터: PostgreSQL (마이그레이션 상태머신 포함)
- 작업 큐: Celery + Redis (대량 배치, throttling 제어)
- 프론트: 기존 cflex UI 프레임워크에 마이그레이션 위저드 추가

## 4. 단계별 작업 (Phase)

### Phase 1: CUCM Extractor (2주 분량)
1. AXL 클라이언트 모듈 작성
   - 인증: AXL 전용 계정, HTTPS, 인증서 검증 옵션
   - 추출 대상:
     - End User (userid, 이름, 메일, 부서, primary extension)
     - DN(Directory Number), 파티션, CSS
     - Device (전화기 모델, MAC, 등록 상태)
     - Hunt Pilot / Hunt List / Line Group
     - Call Forward 설정 (CFA, CFB, CFNA)
     - Speed Dial, BLF
     - Translation Pattern, Route Pattern (참고용)
   - 대량 추출: `executeSQLQuery` 병행 (Thin AXL), 페이지네이션 필수
2. 정규화 스키마 설계: CUCM 원본 → 벤더 중립 중간 모델(IR, Intermediate Representation)
3. 추출 결과 검증 리포트 (누락/이상치 표시)

**완료 기준:** 테스트 CUCM에서 1,000 사용자 추출 → IR 저장 → 검증 리포트 생성

### Phase 2: 매핑/변환 엔진 (3주 분량)
1. 룰 기반 매핑 테이블 구현 (아래 §5 참조)
2. 매핑 불가/부분 매핑 항목의 분류 체계: `AUTO` / `REVIEW`(관리자 확인 필요) / `MANUAL`(자동화 불가)
3. ipilot 연계 (§6 참조): REVIEW 항목에 대해 ipilot이 추천 매핑 + 근거 제시
4. Dry-run 모드: 실제 프로비저닝 없이 변환 결과 전체를 시뮬레이션 리포트로 출력

**완료 기준:** 추출된 IR 전체가 AUTO/REVIEW/MANUAL로 분류되고, Dry-run 리포트가 Excel/PDF로 출력됨

### Phase 3: Teams Provisioner (3주 분량)
1. Graph API 모듈
   - Entra ID 사용자 매칭 (UPN/메일 기준, 불일치 시 REVIEW 처리)
   - 라이선스 확인 및 할당 (Teams Phone Standard / E5 내장 여부 체크)
2. PowerShell Runner
   - 컨테이너화된 PowerShell 7 + MicrosoftTeams 모듈, REST 인터페이스로 래핑
   - 번호 할당: `Set-CsPhoneNumberAssignment` (DirectRouting / OperatorConnect / CallingPlan 타입 분기 — **설정값으로 양쪽 모두 지원**)
   - 음성 라우팅: `New-CsOnlineVoiceRoutingPolicy`, `Grant-CsOnlineVoiceRoutingPolicy`
   - Auto Attendant / Call Queue 생성 (`New-CsAutoAttendant`, `New-CsCallQueue`)
   - 발신자 ID, 통화 차단, 다이얼 플랜 정책
3. Throttling/재시도: 지수 백오프, 배치 크기 설정 가능 (기본 50명/배치)
4. 롤백: 프로비저닝 전 상태 스냅샷 저장, 사용자 단위 롤백 지원

**완료 기준:** 테스트 테넌트에서 100 사용자 E2E 마이그레이션 성공, 실패 사용자 롤백 동작 확인

### Phase 4: 운영 기능 (2주 분량)
1. 마이그레이션 위저드 UI: 소스 연결 → 추출 → 매핑 검토(ipilot 추천 표시) → Dry-run → 실행 → 리포트
2. 배치 스케줄링 (야간/주말 cutover 지원)
3. 감사 로그 (누가, 언제, 어떤 사용자, 결과)
4. 최종 리포트: 경영진용 요약 + 기술 상세 (성공률, 미처리 항목, 수동 작업 목록)

## 5. 매핑 테이블 (핵심 룰)

| CUCM | Teams | 분류 | 비고 |
|---|---|---|---|
| End User + Primary DN | Entra 사용자 + Teams 전화번호 | AUTO | UPN 매칭 실패 시 REVIEW |
| Hunt Pilot/List/Line Group | Call Queue | AUTO | 라우팅 알고리즘 매핑: Top-down→Serial, Circular→RoundRobin, Longest idle→LongestIdle, Broadcast→Attendant |
| CTI Route Point + IVR | Auto Attendant | REVIEW | 복잡 IVR은 수동 재설계 |
| CFA/CFB/CFNA | Call forwarding / unanswered 설정 | AUTO | `Set-CsUserCallingSettings` |
| 파티션/CSS | Voice Routing Policy + 다이얼 플랜 | REVIEW | 1:1 불가, 정책 단순화 필요 — ipilot 추천 대상 |
| Shared Line | Delegation(보스-비서) 또는 그룹 통화 | REVIEW | 동일 기능 없음, 대체안 제시 |
| Call Pickup Group | Group Call Pickup (제한적) | REVIEW | 기능 차이 안내 필수 |
| Speed Dial/BLF | Teams 단축 다이얼/연락처 | MANUAL | API 제한적, 가이드 출력 |
| 회의실/공용 전화 | Teams Shared Device 라이선스 | REVIEW | 라이선스 별도 |

## 6. ipilot 연계 (중요)

매핑 엔진과 ipilot 사이 인터페이스를 정의한다. ipilot은 cflex의 지능형 어시스턴트 기능으로, 본 모듈에서의 역할:

1. **매핑 추천**: REVIEW 항목(특히 파티션/CSS → 정책 변환, 복잡 헌트 구조)에 대해 추천 매핑안 + 근거를 생성하여 위저드 UI에 표시. 관리자가 승인/수정.
2. **사전 진단**: 추출 데이터에서 마이그레이션 리스크 자동 탐지 (예: 라이선스 부족, UPN 불일치 다수, 미등록 디바이스).
3. **예외 처리 안내**: 실패 건에 대해 오류 로그 분석 → 원인과 조치 방법을 자연어로 제시.
4. **리포트 요약**: 최종 리포트의 경영진 요약 자동 생성.

인터페이스: 내부 REST API `POST /ipilot/recommend`, `POST /ipilot/diagnose` (요청: IR 스냅샷 + 컨텍스트, 응답: 추천안 + confidence + 근거). ipilot 측 상세 스펙은 ipilot 담당자와 협의 후 확정 — **본 모듈에서는 인터페이스 계약(contract)과 mock 서버까지 구현**할 것.

## 7. 비기능 요구사항

- 규모: 단일 배치 최대 10,000 사용자, 전체 추출 1시간 이내 (CUCM 부하 고려해 AXL 호출 rate limit 설정 가능)
- 보안: CUCM/M365 자격증명 암호화 저장(Vault 또는 KMS), 감사 로그 불변 저장
- 멀티테넌트: 고객사별 격리 (cflex 기존 테넌트 모델 따름)
- Graph throttling(429) 및 PowerShell 세션 제한 대응 필수
- 모든 외부 호출에 구조화 로깅 (correlation ID)

## 8. 테스트 요구사항

- AXL 응답 mock 기반 단위 테스트 (스키마 버전별 fixture)
- PowerShell Runner 통합 테스트 (테스트 테넌트)
- E2E 시나리오: 추출 → Dry-run → 100명 프로비저닝 → 1명 실패 주입 → 롤백
- 매핑 룰 회귀 테스트 스위트 (룰 변경 시 기존 케이스 보존 확인)

## 9. 산출물

1. 소스 코드 (모듈별 README 포함)
2. API 명세 (OpenAPI)
3. 매핑 룰 문서 (§5 확장판)
4. ipilot 인터페이스 계약 문서 + mock 서버
5. 운영 가이드 (사전 준비 체크리스트: AXL 계정, M365 권한, 라이선스)
6. 배포 모델별 설치 가이드 (프로브형 / 풀 온프레미스형, 필요 도메인·포트 목록 포함)

## 10. 진행 방식 지시

- Phase 순서대로 진행하되, 각 Phase 완료 시 완료 기준 충족 여부를 보고할 것
- 불명확한 요구사항은 임의 구현하지 말고 질문으로 정리해서 물어볼 것
- Direct Routing / Operator Connect는 **둘 다 설정으로 지원**하는 구조로 설계할 것
- 외부 API 스펙(AXL 스키마, Graph, Teams PowerShell cmdlet)은 최신 공식 문서를 확인 후 구현할 것

---

## ADDENDUM v2 (2026-06-10) — 선택적 마이그레이션 + 하이브리드 + 양방향 롤백

v1은 "전체 cutover" 가정인데, 실제 엔터프라이즈 운영에서는 **유저 단위로 골라서 단계적으로** 옮기고, 일정 기간 Cisco와 Teams를 **병행 (dual-fork)** 한 뒤, 문제가 있으면 **Teams → Cisco 역방향 롤백**이 가능해야 한다. 본 addendum이 우선 (v1과 충돌하면 본 문서가 이김).

### A. 마이그레이션 단위 = User Cohort (Wave)

- **Job** = 클러스터 한 쌍 (CUCM 1개 ↔ Teams 테넌트 1개)
- **Wave** = Job 안의 한 묶음 (예: "Pilot 10명", "Wave 1 — HQ 임원 50명", "Wave 2 — 영업본부 200명")
- **MigrationUser** = Wave에 속한 유저 1명, 각자 독립적인 state machine을 가짐

### B. 유저별 Migration Mode (3가지)

| Mode | Cisco 쪽 | Teams 쪽 | 용도 |
|---|---|---|---|
| `cutover` | 디바이스 unregister + DN 삭제 | Teams Phone 라이선스 + DID 할당 | 완전 전환 (v1 기본) |
| `dual_fork` | 기존 DN 유지 + Remote Destination Profile에 Teams DID 등록 (SNR) **또는** SBC에서 fork rule 추가 | Teams Phone + 동일 DID (또는 새 DID) | Cisco 사용 중에 Teams 병행 테스트 |
| `coexist` | 기존 그대로 손대지 않음 | Teams 라이선스만 부여 (DID 없음, 채팅+회의만) | 라이선스 사전 배포, 음성은 나중에 |

각 유저는 mode 변경 가능 (예: coexist → dual_fork → cutover 순으로 단계적 진행).

### C. State Machine (per user)

```
draft → selected → planned → snapshotted
        ↓
        provisioning_teams → provisioned (mode=coexist 끝)
                          ↓
                          activating_fork → active_hybrid (mode=dual_fork)
                                          ↓
                                          cutting_over → cutover_done (mode=cutover)
                                                       ↓
                                                       (← rollback 가능 시점)
                          ↓
                          rolling_back → rolled_back  (Teams 라이선스 회수 + Cisco 복구)

failed (어느 단계든) → support 모드 진입, 수동 개입 필요
```

### D. Snapshot — 롤백을 위한 사전 상태 저장

Cisco 쪽 prov 시작 전에 다음을 DB에 통째로 캡처해서 `migration_snapshots` 테이블에 저장한다.

- CUCM user record (모든 필드)
- 모든 DN 라인, partition, CSS
- Device 할당 + 등록 상태 + button layout
- Hunt List 멤버십
- Call Forward 설정 (CFA/CFB/CFNA + targets)
- Speed Dial / BLF
- Voicemail account 연결

Teams 쪽 prov 후에도 적용된 변경 내역을 audit로 기록 (rollback 시 정확히 역순으로 되감기 위함).

### E. Rollback (Teams → Cisco)

발동 조건:
- 운영자 수동 요청 (UI 버튼 "Rollback this user")
- 모니터링 실패 임계치 (예: dual_fork 상태에서 7일 동안 Teams 통화 품질 < MOS 3.5)

실행 순서:
1. Teams Phone DID 해제 (`Remove-CsPhoneNumberAssignment`)
2. Teams Voice Routing Policy 해제
3. Teams Phone 라이선스 회수 (사용자가 Teams 채팅은 그대로 쓸 수 있게 라이선스 회수만, Entra 계정 삭제는 안 함)
4. CUCM Remote Destination Profile / SNR 제거
5. CUCM DN/Device 재등록 (snapshot 기반 복원)
6. 상태 → `rolled_back`, audit 기록

### F. 데이터 모델 추가 (Phase 1.5)

```sql
-- Wave (cohort)
migration_waves(
  id, job_id, name, sequence, target_start_ts, target_complete_ts,
  status (planned|in_progress|done|aborted), created_at
)

-- MigrationUser 컬럼 추가
ALTER migration_users ADD COLUMN wave_id INT REFERENCES migration_waves(id);
ALTER migration_users ADD COLUMN selected BOOLEAN DEFAULT FALSE;  -- 마이그 대상 여부
ALTER migration_users ADD COLUMN mode VARCHAR(16) DEFAULT 'cutover'; -- cutover|dual_fork|coexist
ALTER migration_users ADD COLUMN state VARCHAR(32) DEFAULT 'draft'; -- state machine 위치
ALTER migration_users ADD COLUMN target_tenant_id VARCHAR(255);
ALTER migration_users ADD COLUMN snapshot_id BIGINT REFERENCES migration_snapshots(id);

-- 스냅샷 (롤백용)
migration_snapshots(
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES migration_users(id) ON DELETE CASCADE,
  taken_at TIMESTAMP DEFAULT NOW(),
  cucm_state JSONB,    -- 전체 Cisco 상태 dump
  teams_state JSONB,   -- prov 이전 Teams 상태 (있으면)
  notes TEXT
)

-- 액션 로그 (rollback 재생용)
migration_actions(
  id BIGSERIAL,
  user_id INT,
  ts TIMESTAMP DEFAULT NOW(),
  phase VARCHAR(32),   -- provision_teams|activate_fork|cutover|rollback
  target VARCHAR(32),  -- cucm|teams|sbc
  cmd VARCHAR(128),    -- 실행한 cmdlet/AXL operation
  payload JSONB,       -- 보낸 파라미터
  result JSONB,        -- 응답
  inverse JSONB,       -- 이 액션을 되돌릴 inverse 명령 (rollback 재생용)
  status VARCHAR(16)   -- ok|error|reverted
)
```

### G. UI 흐름 변경 (Phase 1.5 + Phase 4 통합)

마이그레이션 위저드는 6 단계로 재정의:
1. **Connect** — CUCM + Teams 테넌트 자격증명 입력
2. **Extract** — AXL로 전체 인벤토리 가져오기
3. **Select** — 표에서 마이그레이션 대상 유저 체크박스로 선택, Wave 배정
4. **Plan** — 각 유저에 mode 지정 (기본 cutover, 변경 가능), target tenant/DID 매핑, ipilot 추천 표시
5. **Snapshot & Provision** — 스냅샷 캡처 → Teams 프로비저닝 → (mode에 따라) fork 활성화 / cutover 실행
6. **Operate** — 실시간 상태 + per-user rollback 버튼 + 통화 품질 모니터링 (Teams CQD 연동)

### H. dual_fork 라우팅 정책 — CUBE Teams-First / Cisco-Fallback (확정)

dual_fork 모드의 구현은 **Cisco CUBE (Unified Border Element) 의 dial-peer preference + huntstop 조합**으로 한다. 단순 양쪽 동시 ring이 아니라, **Teams가 먼저 받고 실패하면 Cisco로 fallback** 하는 순차 모델이다.

**왜 이 방식인가**
- 사용자는 Teams 클라이언트로 점진 이행 (Pilot 기간 Teams 우선 사용 유도)
- Teams 장애·로그아웃 시 Cisco가 자동 백업 → 무중단
- CUCM SNR과 달리 양쪽이 동시에 울리지 않아 사용자 혼란 없음
- SBC fork(SIPREC)와 달리 PSTN 청구 / 통화 기록이 명확히 한쪽에만 남음

**CUBE 구성 (대상 dial-peer)**

```
! 인바운드 PSTN 콜을 받는 dial-peer (DID 매칭)
dial-peer voice 1000 voip
 description Inbound PSTN to {user_did}
 destination-pattern {user_did}
 ...

! Outbound 1: Teams Direct Routing trunk (PRIMARY)
dial-peer voice 2001 voip
 description Teams DR — primary route for {user_upn}
 destination-pattern {user_did}
 session protocol sipv2
 session target ipv4:{teams_sbc_fqdn_or_ip}
 preference 1                       ! 더 낮은 preference = 우선
 huntstop                            ! 응답되면 hunt 종료
 voice-class sip srtp negotiate
 voice-class codec 1

! Outbound 2: CUCM trunk (FALLBACK)
dial-peer voice 2002 voip
 description CUCM fallback for {user_did}
 destination-pattern {user_did}
 session protocol sipv2
 session target ipv4:{cucm_pub_ip}
 preference 2                       ! 더 높은 preference = 후순위
 voice-class codec 1
```

**Fallback trigger 조건 (preference 2로 넘어가는 시점)**

CUBE는 다음 SIP 상태 코드에서 자동으로 다음 preference로 hunt:
- `408 Request Timeout` — Teams가 응답 안 함 (기본 timeout 32초, `voice-class sip voice-class sip-profiles N` 으로 단축 가능)
- `486 Busy Here` — Teams 사용자 통화 중 (단, 이건 fallback 안 시키고 busy로 끝낼지 정책 필요)
- `503 Service Unavailable` — Teams trunk 자체 불가
- `480 Temporarily Unavailable` — Teams 사용자 로그아웃 / DnD
- `487 Request Terminated` — call canceled

운영자가 Wave 단위로 fallback 정책 선택 가능 (DB 컬럼 `fallback_codes` JSON):
- `aggressive` — 4xx/5xx 거의 모두 fallback (Teams 안정성 검증 단계)
- `standard` (기본) — 408/503/480만 fallback, 486은 busy로 유지
- `conservative` — 503만 fallback (Teams 완전 죽었을 때만)

**Outbound 콜 (Teams → PSTN, Cisco → PSTN)**
- Teams Direct Routing 발신은 CUBE를 통해 PSTN으로 나감
- Cisco 발신도 동일 CUBE를 거침
- 양쪽 발신을 같은 CUBE로 통일 → 통화 청구 단일화 + CDR 통합

**구현 (UCM Migrator 쪽 책임)**

1. **CUBE adapter** (`services/cube_adapter.py`)
   - SSH (paramiko) 또는 NETCONF로 CUBE 접속
   - dial-peer 생성/수정/삭제 — Jinja 템플릿
   - 변경 전 `show run | sec dial-peer voice {id}` 로 snapshot
   - 적용 후 `show dial-peer voice {id}` 로 검증
2. **Inverse**: 모든 dial-peer 생성에 대해 `no dial-peer voice {id}` 를 inverse로 기록 → rollback 시 자동 제거
3. **사전 검증**:
   - CUBE에 해당 destination-pattern dial-peer가 이미 있으면 충돌 경고
   - Teams DR trunk 도달성 확인 (`ping`, SIP OPTIONS)
   - CUCM trunk 도달성 확인

**대안 옵션 (Phase 4에서 추가될 수 있음)**

- `cucm_snr` — CUCM Remote Destination Profile + Single Number Reach (CUBE 변경 없이 Cisco-side만 만지는 옵션)
- `sbc_fork` — AudioCodes/Ribbon에서 SIPREC fork (동시 ring, 비용 비싸지만 동시성)

1차 릴리스는 **CUBE Teams-first/Cisco-fallback만 지원**. 다른 옵션은 어댑터 인터페이스로만 정의.

### I. Phase 재계획 (v2)

- **Phase 1** (현재 진행, 2주): AXL Extractor — IR로 정규화, 검증 리포트
- **Phase 1.5** (1주): Wave/User selection UI + DB 모델 확장 (cohort + state machine + snapshot 테이블)
- **Phase 2** (2주): 매핑 엔진 + ipilot 추천 + Dry-run
- **Phase 3** (3주): Teams Provisioner (Graph + pwsh runner) + Snapshot 캡처 + Rollback 엔진 + CUCM SNR/RDP 어댑터
- **Phase 4** (2주): Wizard UI 통합 + 실시간 운영 대시보드 + Teams CQD 품질 모니터링 연동
- **Phase 5** (1주): 감사 로그 + 최종 리포트 + 운영 가이드 v2

총 11주.

### J. 완료 기준 — v2

E2E 검증 시나리오:
1. HMC HQ Pilot Wave 10명 추출
2. 그 중 5명 선택, mode 지정 (3명 cutover, 2명 dual_fork)
3. Snapshot 캡처 검증 (CUCM 상태 100% 복원 가능)
4. Teams 프로비저닝 5명 성공
5. dual_fork 2명: Cisco + Teams 양쪽 통화 ringing 확인
6. cutover 3명 중 1명에 의도적 장애 주입 → rollback 발동 → Cisco 완전 복원 확인
7. 감사 로그에 액션 / inverse / 상태 변화 모두 기록

