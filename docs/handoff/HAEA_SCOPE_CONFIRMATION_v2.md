# HAEA Probe 범위 확인서 v2 — 정정판

- 문서번호: SCOPE-CFLEX-INT-2026-1025 v2.0 · 작성 2026-10-25 · 담당 Claude Code (내부)
- 작업지시: **WO-INT-001**
- 기준: `docs/spec/00_INTERFACE_CONTRACT_Probe-Portal_v1.md`, `docs/spec/01_SPEC_INTERNAL_Probe-OnPrem_for-ClaudeCode_v1.md`, `docs/control/DECISIONS.md`
- v1 폐기: v1(아티팩트)은 역할 경계를 **좁게** 잘못 읽었다. 무엇을 틀렸는지는 §9에 남긴다.

---

## 0. 한 줄 확인 — 정정

**v1에서 이렇게 썼다 (틀렸다):**
> "Probe는 수집해서 NOC에 보낸다. 그게 전부다. 판정·티켓·알람 발송·분석은 전부 외부 C-Flex 쪽 일이다."

**정정:**

내부(HAEA 온프레미스)는 **다섯 가지**를 만든다 — 수집만이 아니다.

| | 내부에서 만드는 것 | 근거 |
|---|---|---|
| 1 | **Collector** — SNMP 폴링 + trap 수신 → 정규화 → 로컬 저장 + 포털 전송 | 01 §0-1, §2.1 |
| 2 | **Local Console** — 장비 현황·실시간 값·**알람 받기·보여주기·ACK**·트렌드·설정 | 01 §0-2, §2.2 |
| 3 | **Forwarder** — 계약서 §3 전송, 명령 큐 처리, store-and-forward | 01 §0-3, 00 §3 |
| 4 | **로컬 알림** — HAEA SMTP 릴레이 · Teams 웹훅(프록시) · **ServiceNow eBonding** | 01 §0-4 |
| 5 | **설치 번들·설치기·운영 문서** (컨테이너 기본, 베어 폴백) | 01 §0-5, §3 |

**특히 알람 1차 분류가 내부다.** Collector의 룰엔진이 계약서 부록 B 코드 사전으로 P1–P4를
분류하고, 중복 억제·플래핑 방지·유지보수 모드까지 내부에서 수행한다 (01 §2.1).
포털은 그 **코드를 받아서 라우팅·에스컬레이션**을 한다 (00 §3.4).

경계를 정확히 말하면 이렇다:

> 내부 콘솔은 **"알람을 받아서 보여주는 것"** 까지가 끝이다. 분석·보고·라우팅은 전부 포털. (01 §0)

"수집해서 보내기만 한다"가 아니라 **"분류하고 로컬에 알리고 보여주고, 라우팅은 넘긴다"** 가 맞다.

### 내부가 만들지 않는 것 (= Codex 포털 담당)

담당자별 알람 라우팅·에스컬레이션·ACK 추적·**SMS** · RingOn NOC 콘솔 · 멀티테넌트 ·
월간 Executive Report · 라이프사이클/예산 예측 · PM 체크리스트 디지털화 · 3D 평면도 뷰 ·
고객 포털 · **지정 담당자 연락처 저장**(내부에는 HAEA 로컬 계정만). (01 §0)

---

## 1. 역할 경계

```
┌─ HAEA 망 안 (인터넷 없음, 인바운드 없음) ────┐      ┌─ 외부 Portal (Codex) ──────────┐
│                                              │      │                                │
│  cap01  Collector                            │      │  Ingest /api/v1/*              │
│    · SNMP v3 RO 폴링 (v2c 폴백)  UDP 161     │      │   · mTLS 장치 인증             │
│    · trap 수신                   UDP 162     │      │   · 멱등 캐시 · 429            │
│    · 알람 1차 분류 (부록 B, P1–P4)          │      │                                │
│    · 중복 억제 · 플래핑 방지 · 유지보수     │      │  알람 라우팅 · 에스컬레이션    │
│    · store-and-forward 디스크 큐 7일        │ ───▶ │   · 담당자 + 당직 · SMS        │
│                                              │ 443  │   · local_notified 중복 억제   │
│  app01/app02  Local Console                  │ mTLS │   · PROBE_OFFLINE (hb 5분)     │
│    · nginx TLS 443 ← HAEA 사용자 VLAN/VPN   │      │                                │
│    · 알람 목록/상세/ACK · 장비 현황/트렌드  │      │  NOC 콘솔 · 고객 포털          │
│    · 로컬 계정 + 역할 3종                   │      │  리포트 · PM · 3D · 라이프사이클│
│    · 로컬 알림 SMTP / Teams / ServiceNow    │      │                                │
│                                              │ ◀─── │  명령 큐 (6종 고정)            │
│  db01  PostgreSQL 16                         │ pull │   config_update · cert_renew   │
│    · 텔레메트리 월 파티션                   │      │   request_inventory · poll_now  │
│    · raw 3년 / 집계 10년 / 이벤트 10년      │      │   set_maintenance· collect_diag│
└──────────────────────────────────────────────┘      └────────────────────────────────┘
```

**Probe가 항상 먼저 연결한다 (아웃바운드 전용).** 포털은 Probe로 인바운드를 열지 않는다.
포털 → Probe 방향은 **전부 §3.6 명령 큐**로만 전달되고, **허용 명령은 6종으로 고정**이다
(원격 셸·임의 스크립트 금지 — HAEA Security 설명용). (00 원칙, §3.6, §4)

### 데이터 흐름

| 방향 | 내용 | 주기 |
|---|---|---|
| → | `POST /api/v1/heartbeat` | **60초** (00 §3.1) |
| → | `PUT /api/v1/inventory` | 변경 시 + 일 1회 전체 |
| → | `POST /api/v1/telemetry` | 60초 또는 500포인트 배치 |
| → | `POST /api/v1/events` | 알람·이벤트 즉시. `local_notified` 포함 |
| → | `POST /api/v1/files` | PM 리포트·사진·로그 ≤ 25 MB |
| ← | `GET /api/v1/commands` | heartbeat의 `commands_pending > 0`일 때 폴링 |
| ← | `GET /api/v1/config` | 선택적 중앙 설정. **로컬 `site.yaml`이 우선** |
| ✕ | 전원 조작 · 설정 변경 · 펌웨어 자동 변경 | 없음 — §6 |

---

## 2. 사업 구조

| 항목 | 내용 | 따라오는 결론 |
|---|---|---|
| **과금** | FMS 구축비·라이선스로 팔지 않는다. FMS 사용을 포함한 **운영 서비스 구독료**를 받는다. | Probe 설치는 납품물이 아니라 구독을 가능하게 하는 수단. 설치가 쉬울수록 마진이 좋아진다. |
| **마진** | 고객 청구 운영 인력·서비스 비용을 AI 자동화로 줄인 차액. | 사람 손이 가는 모든 단계가 원가. |
| **운영** | AI가 상시 감시·분류·티켓·분석·응답·후속조치를 **중심으로** 수행. 사람은 예외·긴급만. | 사람이 기본이고 AI가 보조인 구조가 아니다. 반대다. |
| **FMS의 위치** | ① 장비를 보여주는 도구 ② **AI 운영센터의 근거 데이터 + 작업 화면** | ②가 판단 기준. "사람이 보기 좋은가"보다 "AI가 이걸 근거로 티켓을 처리할 수 있는가"를 먼저 본다. |

②번 때문에 데이터 출처·신뢰도(provenance)가 장식이 아니라 제품의 일부다. 숫자가 어디서
왔는지(측정값/명판값/라이브러리값) 말할 수 없으면 AI가 그걸 근거로 티켓을 처리할 수 없다.
`fms_metrics`에 `source` 없는 행을 거부하게 만든 이유다.

**단, 자동화의 장비 쓰기는 금지다** — D-05. ②는 근거 데이터와 작업 화면까지이고,
장비에 손을 대는 것까지가 아니다.

---

## 3. 우선순위 변경

| 항목 | 이전 | 지금 | 근거 |
|---|---|---|---|
| SMS 게이트웨이 | 개발 전용 인증 구성 + 테스트 1건 발송 진행 중 | **Probe 범위 아님.** 포털 WO-PTL-003에서 처리. 자격증명 검증 결과(toll-free `TWILIO_APPROVED`, `+18775529797` 소유)는 포털 팀에 넘긴다. | TASKS §C |
| Probe 기능 확장 | 폴러 추가·로컬 분석 등 여지를 열어두고 있었음 | **범위 확정.** 01 §0의 다섯 가지. Local Console은 "기능 추가 금지". | 01 §0, §2.2 |
| 작업 성격 | 기능 개발 | **계약 수렴 + 배포·운영 엔지니어링.** | TASKS §A |

---

## 4. 집중 영역 — 상태 정정

상태는 코드를 직접 확인한 결과다. 낙관적으로 적지 않았다.

### 4.1 RHEL 8.10 설치 — 미구현 → WO-INT-005

**현재:** `probe-agent/install.sh`(70줄)은 **Ubuntu 전용이고 RHEL에서 즉시 실패한다.**

| 줄 | 내용 | RHEL에서 |
|---|---|---|
| 15–16 | `apt-get update` / `apt-get install build-essential` | 명령·패키지 없음 |
| 20–21 | `curl deb.nodesource.com/setup_20.x` | Debian 전용 저장소. **서드파티 저장소 금지**(01 §1)에도 위반 |
| 27 | `useradd --shell /usr/sbin/nologin` | RHEL 경로는 `/sbin/nologin` |
| — | SELinux Enforcing · firewalld 처리 | 없음 |

`systemd/cflex-probe.service`는 양호하다 — `NoNewPrivileges`, `ProtectSystem=strict`,
`ProtectHome`, `PrivateTmp`, `ReadWritePaths`가 들어가 있다. 베어 프로파일에서 재사용한다.

**할 일:** Node는 **HAEA Satellite AppStream 모듈만** 사용 (`dnf module enable nodejs:20`) —
외부 저장소 추가 없음. SELinux 정책 모듈(.pp) 동봉, `setenforce 0` 금지. trap UDP 162는
`ip_unprivileged_port_start=161` 또는 firewalld 162→1162 포워딩 중 설치기가 선택·문서화.

### 4.2 컨테이너 — 미구현 → WO-INT-005

**현재:** `Containerfile`·`Dockerfile`·Quadlet 유닛 **전무.** 호스트에 Node를 직접 깔고
systemd로 띄우는 방식뿐이다.

**확정(D-03):** **Podman + Quadlet, UBI8 nodejs-20 기본. Docker 금지.** 베어 설치 폴백 유지.

> **"도커(?)"에 대한 답.** RHEL 8은 Docker를 쓰지 않는다 — Red Hat이 제거하고 Podman으로
> 대체했다. AppStream에 `docker` 패키지가 없고, Docker사 저장소를 붙이면 01 §1의
> **"서드파티 저장소 금지"** 에 정면으로 걸리며 `podman`·`runc`와 충돌한다. 현대 Security
> 심사에서 가장 먼저 걸릴 지점이다. 이미지 형식·CLI는 호환이므로
> (`Containerfile` = `Dockerfile`) 작업 내용은 거의 같다.

이미지 5개 전부 UBI/RHEL 베이스: `cflex/collector`·`cflex/app`(ubi8/nodejs-20),
`cflex/web`(ubi8/nginx-122), `cflex/redis`(rhel8/redis-6), `cflex/postgres`(rhel8/postgresql-16).
rootless `cflex`, UID 1001, read-only rootfs, 특권·host network 금지, 볼륨 `:Z`.
오프라인 번들은 `podman save` tar + SHA-256 + 서명(cosign/GPG) + SBOM(CycloneDX) + 스캔 리포트.

### 4.3 포털 전송 — v1에서 "구현 완료"라고 썼다. 틀렸다 → WO-INT-002

**v1의 오류:** 현재 forwarder가 동작하므로 "이미 완료, 손댈 것 없음"으로 적었다.
계약서 00이 나온 지금 기준으로는 **거의 전부 교체 대상**이다.

| 항목 | 현재 코드 | 계약서 00 요구 |
|---|---|---|
| 목적지 | `https://cflex.runless.co.uk` | `https://cflex.fms.support` (40.114.79.164 static) |
| 경로 | `POST /v1/probe/event` (단일) | `/api/v1/{heartbeat,inventory,telemetry,events,files,commands,config}` |
| 인증 | 헤더 `X-Probe-Key` (공유 토큰) | **mTLS 장치 인증서** (사설 CA, CN=`<tenant>.<node-id>`, 2년) |
| 테넌트·노드 | `X-Probe-Id` / `X-Tenant-Id` | `X-CFlex-Node` / `X-CFlex-Tenant` |
| 멱등성 | 없음 | `Idempotency-Key` UUIDv4 **필수**, 24시간 |
| 재시도 | 실패 시 버퍼 적재 + `drain()` | 지수 백오프 1s→5분, 지터 ±20%, **4xx 재시도 금지**(409 제외) |
| 레이트 | 없음 | 노드당 60 req/min, **429 + `Retry-After` 처리** |
| 프록시 | 없음 | `HTTPS_PROXY` (basic/NTLM), 프록시 CA 신뢰 |
| heartbeat | **30초** | **60초** (D-07) |
| 데이터 최소화 | 없음 | **스키마 화이트리스트** 필터 + 차단 키 로컬 카운트 (00 §5) |
| 시간 | — | UTC ISO-8601 ms, NTP 동기, drift 60초 초과 시 경고 이벤트 |

**맞게 되어 있는 것** (유지한다): 아웃바운드 전용 · 실패 시 로컬 SQLite 버퍼 + 재전송 ·
배치 전송 · 폴링 동시성 12(41대 한 주기 약 40초) · SNMP 읽기 전용 경로만.

기존 `/v1/probe/event`는 **설정으로만 남기고 기본 off** (WO-INT-002 완료 기준).

### 4.4 업그레이드 — v1 권고가 틀렸다 → D-04

**v1에서 이렇게 권고했다:**
> "`podman auto-update` + systemd 타이머. 이미지 다이제스트가 바뀌면 받아서 교체하고,
> 실패하면 자동 롤백. 사람 손 0회." / "WireGuard로 Probe가 발신해 터널 유지."

**정정 (D-04):**

- **아웃바운드 풀은 맞다.** 단 목적지는 **`cflex.fms.support:443` 뒤의 레지스트리**다
  (포털 WO-PTL-005, 서명 검증). 별도 레지스트리 호스트를 열지 않는다 — 01 §1 네트워크
  표의 아웃바운드 목적지 1개를 그대로 쓴다.
- **무인 자동 적용은 아니다.** 받아두는 것과 적용하는 것을 분리하고, **적용은 승인된
  유지보수 창에서** 한다. `podman auto-update`의 무인 교체는 쓰지 않는다. 고객 데이터센터
  전원 설비 감시 장비가 심야에 스스로 버전을 바꾸면 안 된다.
- **WireGuard는 보류다.** HAEA 방화벽 요청서 **양식 C 결과 후 결정** (TASKS §C).
  현재 원격 접속 근거는 01 §1의 **"RingOn(HAEA VPN/점프) → 4 VM, TCP 22/443,
  설치·유지보수 윈도우만"** 한 줄이다. 별도 VPN 터널을 전제로 설계하지 않는다.

업그레이드 자체는 설치기 `cflex-install upgrade`/`rollback`이 담당한다 — 이미지 태그 교체
(또는 릴리스 심링크) + DB 마이그레이션(전방향+롤백), 헬스 실패 시 자동 롤백,
**Standby 먼저 순차** (01 §3.3).

### 4.4b 로컬 알림 — 내부 범위. v1에 아예 없었다 → WO-INT-003

v1은 알람 발송을 전부 포털로 돌려놨다. **ServiceNow eBonding은 HAEA 내부 ITSM이므로
내부에서 수행한다** (01 §0-4).

- SMTP — HAEA 릴레이 25/587
- Teams — 웹훅, **프록시 경유**
- ServiceNow — 인시던트 생성/업데이트/종료, P1–P4 ↔ Impact/Urgency, **`alarm_id` ↔ INC 매핑 저장**
- **테스트 티켓 버튼** — SOW 수락 기준 (01 §2.2, §5-4)
- 정책 플래그 `local_email` / `local_teams` / `local_itsm` on/off, P1만 등
- 발송 결과를 이벤트 `local_notified`로 포털에 전달 → 포털의 **중복 발송 억제 입력** (00 §3.4)

`packages/notify`가 이미 9채널을 의존성 0개로 분리해 두었다. 그중 SMTP·Teams·ServiceNow를
쓰고, SMS·LINE은 쓰지 않는다(폐쇄망에서 닿지 않고, 포털 범위다).

---

## 5. 결정 — 채택 결과

v1 §5에서 7개를 권고했다. 관리자 판정은 **1·2·7 채택**이고 나머지는 수정·보류다.

| # | v1 권고 | 결과 | 확정 내용 |
|---|---|---|---|
| 1 | Podman + Quadlet | **채택** | D-03 |
| 2 | UBI8 / nodejs-20 | **채택** | D-03. 베어 폴백 유지 |
| 3 | 아웃바운드 풀 (서명 이미지) | **수정** | D-04 — `cflex.fms.support:443` 경유, **자동 적용 아님**(승인된 유지보수 창) |
| 4 | WireGuard, Probe 발신 | **보류** | 양식 C 결과 후. 현재 근거는 01 §1의 HAEA VPN/점프 22/443, 유지보수 윈도우만 |
| 5 | 우리 레지스트리 + 아웃바운드 1개 | **수정** | 레지스트리를 `cflex.fms.support:443` 뒤에 둔다 (WO-PTL-005) |
| 6 | 사이트별 Probe 1대 | **미확정** | 01 §1: Collector **1대 기본**. 10.138.14.x → HMA/KUS NMC VLAN 라우팅 불가 시 **사이트당 1대(3대)**. 01 §6-1 HAEA 회신 대기 |
| 7 | 버퍼 7일 | **채택** | D-07. heartbeat **60초**, 폴링 60초(최소 10초) |

---

## 6. 유지되는 제약 — D-05

**전원 조작 · 설정 변경 · 펌웨어 자동 변경 금지. Probe는 SNMP 읽기 전용.**

이 금지가 2026-10-23까지 **문서에만** 있었다. 제어 어댑터에 쓰기 액션 9개가 있고 라우트
2곳에 마운트돼 있었으며, 장비에 아무 일도 일어나지 않은 유일한 이유는 실행 함수 3개가
`not wired yet` 스텁이라는 것뿐이었다. 그 위에는 `// TODO: integrate …`가 붙어 있었다 —
다음 사람이 채우면 금지가 조용히 사라지는 상태였다.

`88870a7`로 코드에 넣었다 (D-05가 이 커밋을 기준으로 지정).

- `backend/services/fms-control-policy.js` — 테넌트 설정으로 켤 수 없는 층
- **자동화(AI)는 어떤 쓰기도 영구 거부**, 우회 불가. `origin`을 말하지 않는 호출자는 자동화로 간주
- 사람 관리자는 전원·설정·펌웨어 클래스를 `FMS_CONTROL_UNBAN`에 **액션명 명시** 시에만
- 거부는 `fms_control_log`에 `channel='denied'`로 감사 기록
- 테스트 9개. 일부러 깨뜨려(fail-closed→fail-open, 정책 호출 우회) 실제로 잡히는지 확인

Probe 쪽은 애초에 `snmp-read.js`만 있고 SET 구현이 없다. 00 §3.6의 **허용 명령 6종**에도
장비 쓰기가 없다 — `config_update`·`cert_renew`·`request_inventory`·`poll_now`·
`set_maintenance`·`collect_diag`뿐이다. 이 구조를 유지한다.

---

## 7. 수량 기준 — D-06

| 숫자 | 의미 |
|---|---|
| **44** | SOW Exhibit 1 계약 대수 |
| **41** | NMC IP 기재분 = **방화벽 요청 대상** |
| **48** | Q3 2026 실사 (HMA 35 · KUS 7 · HAEA 6, 시드 CSV) |

**혼용 금지.** v1 §7.4는 이것을 "열린 질문"으로 적었는데, 질문이 아니라 **규칙**이다.
문장마다 어느 기준인지 명시한다. 예: SAT는 "44대(+현장 추가분, 실사 48대) 전부 콘솔에
표시·수집" (01 §5-2).

---

## 8. 남은 미확정 — 01 §6 (HAEA 회신 대기)

v1 §7과 달리, 이것들은 내 추측이 아니라 **명세서가 미확정으로 지정한 항목**이다.

| # | 항목 | 영향 |
|---|---|---|
| 1 | 10.138.14.x → HMA/KUS NMC VLAN 라우팅 | Collector 1대 vs 3대. 48대 전부 `no-route`였던 것이 이 질문의 근거 |
| 2 | keepalived VIP 허용 여부 | 허용 시 VIP, 아니면 DNS/수동 전환 (WO-INT-004) |
| 3 | HAEA 프록시 주소·인증, SMTP 릴레이, ServiceNow 엔드포인트·계정, 사용자/원격접속 소스 대역 | WO-INT-002·003 모두 여기서 막힌다 |
| 4 | Podman(container-tools) 허용·rootless·EDR 정책 | 거절 시 베어 프로파일로 (WO-INT-005) |
| 5 | HAEA 내부 CA 인증서, SAML IdP 시점 | nginx 인증서 교체 절차 |
| 6 | HMA 3대 NMC IP (PG-A2, PG-B2, 6F Boardroom), Exhibit 1(31) vs 실사(35) | 인벤토리 조인 |

추가로 내 쪽 미결 1건: **운영 DB의 시뮬레이터 장비 4대** — 데모 유지인지 삭제인지.
`Q-2026-10-25-02`로 DECISIONS에 올린다.

---

## 9. v1에서 틀린 것 (기록)

정정 이력을 남기는 이유는, 같은 오독이 다시 나오지 않게 하기 위해서다.

| v1 위치 | 틀린 내용 | 원인 |
|---|---|---|
| §0 | "Probe는 수집해서 NOC에 보낸다. 그게 전부" | 역할 경계를 좁게 읽었다. Local Console·로컬 알림·알람 1차 분류가 모두 내부인데 전부 포털로 돌렸다 |
| §1 | "알람 발송 9채널"을 포털 쪽 상자에 그렸다 | SMTP·Teams·ServiceNow는 내부, SMS·담당자 라우팅이 포털이다 |
| §1 | "로컬 조회 127.0.0.1:8080 — 범위 확인 필요" | 01 §2.2에 범위가 확정돼 있다. nginx TLS 443 뒤 `0.0.0.0`, 로컬 계정 + 역할 3종 |
| §4.3 | 포털 전송을 "구현 완료"로 표시 | 계약서 00 기준으로는 목적지·인증·멱등성·레이트·프록시·heartbeat 주기가 전부 교체 대상이다 |
| §4.4 | `podman auto-update` 무인 적용 권고 | D-04는 **승인된 유지보수 창에 적용**. 무인 아님 |
| §4.4 | WireGuard 권고 | 보류 (양식 C 결과 후). 설계 전제로 쓸 수 없다 |
| §7.1 | 로컬 조회 범위를 "열린 질문"으로 | 01 §2.2에 답이 있다 |
| §7.2 | "판정은 NOC" | **알람 1차 분류는 내부**다 (01 §2.1, 00 부록 B). 이 항목은 v1에서 서술도 잘렸다 — 본 문서 §0·§1·§4.4b에 복원 |
| §7.4 | 수량 44/41/48을 "열린 질문"으로 | D-06의 **확정 규칙**이다 |
| 전반 | 아티팩트 링크로만 전달 | 저장소 md가 정본이어야 한다 (WO-INT-001 완료 기준) |

공통 원인: **기준 문서(00·01)가 나오기 전에 작성한 것을, 나온 뒤에도 그대로 두었다.**
앞으로 계약·명세 변경 시 이 문서의 §4·§5를 먼저 대조한다.

---

## 10. 다음 작업 (TASKS.md §A 순서)

| 우선 | WO | 내용 | 선행 조건 |
|---|---|---|---|
| 1 | INT-001 | **본 문서** + `HAEA_CURRENT_STATE.md` §10 갱신 | — |
| 2 | INT-002 | Forwarder를 계약서 00으로 교체 | 스키마 파일(부록 C) 생성, 포털 `/_mock` 또는 자체 목 |
| 3 | INT-003 | 알람 1차 분류 + 로컬 알림 | 01 §6-3 (SMTP·ServiceNow 엔드포인트) |
| 4 | INT-004 | Local Console 범위 확정 구현 | 01 §6-2 (keepalived VIP) |
| 5 | INT-005 | RHEL 설치 — 컨테이너 프로파일 | 01 §6-4 (Podman 허용 여부) |
| 6 | INT-006 | SNMP trap 리스너 UDP 162 | — |
| 7 | INT-007 | Node 20 검증 + `node:sqlite` 폴백 제거 | — |
| 8 | INT-008 | PostgreSQL 16 전환 (Collector 버퍼는 SQLite 유지) | — |
