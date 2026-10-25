# C-Flex FMS 2.x On-Premises Edition (RHEL) — 상용 버전 설계·기능 명세서
### 레퍼런스 배포: HAEA (RHEL 8.10, VM 4대)

- 문서번호: SPEC-CFLEX-HAEA-2026-1023 v1.4 (컨테이너 배포 프로파일 §5-B 추가 — Podman/Quadlet/UBI, 베어 설치는 폴백)
- 작성: RingOn Service Corp. (Eric Park, GM) — 개발팀 전달용 (Claude Code 작업 지시서 겸용)
- 대상 고객: Hyundai AutoEver America (HAEA) — SOW ORMF260018 / PO 2000014792
- 상태: 확정 요구사항 + 미확정 항목(§13) 구분 표기
- **성격: 이 문서는 HAEA 1회성 커스텀이 아니라 C-Flex FMS 2.x의 정식 상용 "온프레미스 에디션"을 만드는 명세다.** HAEA는 첫 번째 레퍼런스 고객이며, HAEA 고유 값(호스트명·IP·장비 목록·연락처)은 전부 설정/데이터(§6, 부록 B)로 분리하고 코드·설치기·문서에는 하드코딩하지 않는다. 같은 번들로 다음 고객(KMX, GLOVIS, MPA, GENESIS 등)에 배포할 수 있어야 한다.

---

## 0. 이 문서의 목적과 가장 중요한 변경점

기존 C-Flex FMS는 **VMware OVA 어플라이언스**(우리 OS 이미지 포함)로 고객에게 전달했다. HAEA 건은 그 방식이 **불가**하다. HAEA가 자체 표준으로 빌드한 **RHEL 8.10 VM 4대**를 우리에게 넘겨주고, 우리는 그 위에 **설치 패키지(오프라인 번들)** 로 C-Flex를 설치해야 한다. OS·패치·보안툴은 HAEA가 소유·운영한다.

따라서 개발 산출물은 "OVA 이미지"가 아니라 다음 세 가지다.

1. **오프라인 설치 번들** (`cflex-fms-2.x-rhel8-offline.tar.gz` + SHA-256 체크섬 + 패키지 인벤토리/SBOM) — **기본은 Podman 컨테이너 이미지 번들(§5-B)**, 폴백으로 베어 설치(§5)
2. **설치·구성 자동화** (`cflex-install` — 역할별: collector / app / db, 멱등, 재실행 가능)
3. **운영 문서** (설치 MOP, 설정 레퍼런스, 백업·복구, 업그레이드 절차, SAT 체크리스트)

OVA 시절과 달라지는 전제는 아래 §2에 모두 있다. **인터넷이 없고, 서드파티 저장소가 없고, 우리가 root 이미지를 만들지 않는다**는 세 가지가 핵심이다.

---

## 1. 배경과 범위 (Phase 1)

| 항목 | 내용 |
|---|---|
| 고객 | HAEA (Hyundai AutoEver America) — IDC Planning & Management (Kay Kim, Patrick Juan, 스폰서 John Trainor) |
| 계약 | SOW ORMF260018 (3건: HMA / KUS / HAEA HQ), 2026-07-15 ~ 2026-12-31, 이후 갱신 예정 |
| Phase 1 모니터링 대상 | UPS **44대** (SOW Exhibit 1 기준): HMA Fountain Valley 31, KUS Irvine 7, HAEA HQ Irvine 6 — 전부 APC/Schneider, SNMP |
| 실제 현장 수량 | Q3 PM(2026-10-02/05/06) 실사 **48대** = HMA 35 + KUS 7 + HAEA 6. HMA는 Exhibit 1의 31대보다 4대 많음(그중 2대는 리포트에 UNLISTED 표기). 인벤토리는 Exhibit 1 외 장비 추가·`in_sow` 구분을 지원해야 함 |
| 수량 기준 정리 | **44** = SOW Exhibit 1 계약 대수 / **41** = Exhibit 1 중 NMC IP가 기재된 대수(방화벽 룰 대상; HMA PG-A2·PG-B2·6F Boardroom 3대 IP 미기재) / **48** = Q3 실사 대수(시드 데이터). 코드·문서에서 이 세 숫자를 혼용하지 말 것 |
| 향후 확장 | HAEA가 북미 전 지역(HMA/KUS/GLOVIS/MPA/GENESIS …) 지역 사이트로 순차 확대 예정 → **50+ 사이트, 수백 대 UPS** 용량 가정 |
| 알림 | Microsoft Teams + e-mail (Phase 1). SMS는 포털 측에서 처리 |
| 라이선스 | C-Flex 플랫폼 요금 **$0** (SOW 명시). 설치 후 **업데이트·라이선스 관리는 HAEA가 수행**할 수 있어야 함 → 라이선스 키/만료 로직 없음 또는 영구 키 |
| 범위 외 | 전기/기계 설비, 누수, CCTV/화재 등 빌딩 시스템 통합(옵션, 별도 제안) |

---

## 2. 대상 환경 (HAEA가 제공, 변경 불가)

### 2.1 VM 4대 (HAEA ISE, VMware, RHEL 8.10, Production) — 빌드 완료, IP 확정

| 호스트명 | IP | 역할 | 사양 | 마운트 |
|---|---|---|---|---|
| haeipfmscap01v | 10.138.14.66 | Collector (probe) | 2 vCPU / 4 GB / 40 GB | — |
| haeipfmsapp01v | 10.138.14.67 | Application (Active) | 4 vCPU / 16 GB | `/opt/app` 200 GB |
| haeipfmsapp02v | 10.138.14.68 | Application (Standby) | 4 vCPU / 16 GB | `/opt/app` 200 GB |
| haeipfmsdb01v | 10.138.14.69 | Database | 4 vCPU / 16 GB | `/opt/data` 500 GB |

- **모든 애플리케이션 파일은 `/opt/app`(앱) / `/opt/data`(DB) 아래에만** 둔다. 루트 파티션에 데이터를 쓰지 않는다.
- Collector는 1대. 단, 10.138.14.x에서 HMA(10.112.x.x)·KUS(10.119.14x.x) NMC VLAN으로 라우팅이 안 되면 **사이트당 1대(총 3대)** 로 전환 → Collector는 **N대 등록·운용 가능한 구조**여야 한다(사이트/Collector 매핑).
- DB는 Phase 1 단일 노드. 추후 **스탠바이 복제본 추가가 재설계 없이** 가능해야 한다.

### 2.2 OS·패키지 제약 (가장 중요)

- OS: **RHEL 8.10** (RHEL 9도 허용되나 8.10 기준으로 빌드·검증). SELinux **Enforcing**, firewalld 활성, HAEA 보안툴(EDR 등) 설치됨을 전제.
- 패키지 소스: **HAEA Red Hat Satellite의 RHEL 8 AppStream만** 사용. 인터넷 불가, PGDG/EPEL/NodeSource 등 **서드파티 저장소 금지**.
  - 사용 모듈: `nginx` (AppStream), `nodejs:20`, `postgresql:16`, `redis:6`
  - **Valkey → Redis 6** 로 교체 (프로토콜 호환 범위 내에서만 사용: 세션/큐/캐시. Redis 7+ 전용 명령·기능 사용 금지)
  - **pg_partman 사용 금지 → PostgreSQL 16 네이티브 선언적 파티셔닝**으로 대체 (파티션 생성/드롭은 앱 내 스케줄러가 수행)
  - **repmgr 사용 금지** (Phase 1 단일 DB). 이후 복제는 PostgreSQL 내장 스트리밍 복제로 설계
  - Python 스크립트가 필요하면 RHEL 8 기본 `python3` (3.6/3.9 AppStream) 범위 내에서만. 가능하면 Node.js로 통일
- 우리 애플리케이션: **오프라인 번들**로 반입 (HAEA 승인 파일 전송 경로). npm 의존성은 번들에 포함(`node_modules` 사전 빌드, 네이티브 모듈은 RHEL 8 glibc 기준 사전 컴파일). 설치 중 `npm install`/`pip install`/`curl` 등 **네트워크 호출 0건**.
- 접근: VM당 **sudo 가능한 서비스 계정 1개**(HAEA 발급)로 설치. 설치 후 앱은 전용 비특권 계정(`cflex`)으로 구동. root 로그인·비밀번호 하드코딩 금지.
- 패치: OS 패치는 HAEA Satellite가 수행. 앱 업그레이드는 우리 번들 교체 방식(§9).

### 2.3 네트워크 (방화벽 요청서 v3와 1:1 일치해야 함)

| 룰 | 방향 | 포트 | 용도 |
|---|---|---|---|
| A | collector → NMC 41대 | UDP 161 | SNMP v3 read-only 폴링 (v2c 폴백) |
| A | NMC → collector | UDP 162 | SNMP trap 수신 |
| A | collector → NMC | TCP 443 | 온보딩/PM 시 NMC 설정 점검 (선택) |
| **B (1순위)** | collector/app → **cflex.fms.support (40.114.79.164, Azure static)** | TCP 443 outbound | **매니지드 서비스 포털로 텔레메트리·이벤트·알람 전송 (mTLS)** — HAEA 프록시 경유 가능해야 함 |
| C | HAEA 사용자 VLAN/VPN → app | TCP 443 | 로컬 대시보드 |
| C | RingOn 엔지니어(HAEA VPN/점프) → 4 VM | TCP 22, 443 | 설치·유지보수 윈도우만 |
| 내부 | collector → app | TCP 443 | 텔레메트리 포워딩 (REST/TLS) |
| 내부 | app → db | TCP 5432 | PostgreSQL |
| 내부 | app01 ↔ app02 | TCP 6379, 443 | Redis 복제/헬스체크 |
| D | app → HAEA SMTP 릴레이 | TCP 25/587 | 알람 메일, 월간 리포트 |
| D | app → HAEA 프록시 → Teams webhook | TCP 443 | Teams 알림 (선택, 거절 시 SMTP만) |
| D | app → HAEA ITSM/ServiceNow API | TCP 443 | eBonding |
| D | 4 VM → Satellite/DNS/NTP | 443/80, 53, 123 | HAEA 표준 |

**인터넷 인바운드 없음.** 모든 외부 연결은 HAEA 내부에서 시작하는 아웃바운드만.

---

## 3. 시스템 아키텍처

```
[UPS NMC ×41+]  ──SNMP 161/162──▶  [Collector cap01v .66]
                                          │ HTTPS 443 (내부)
                                          ▼
   HAEA 사용자 ──HTTPS 443──▶ [App01 .67 Active] ◀─Redis/health─▶ [App02 .68 Standby]
                                          │ 5432
                                          ▼
                                   [DB db01v .69  PostgreSQL 16]
                                          
   [Collector 및 App] ──HTTPS 443 outbound (mTLS, 프록시 경유 가능)──▶ cflex.fms.support (RingOn 매니지드 서비스 포털)
                                                                        └─▶ 알람 라우팅/에스컬레이션 → 사이트별 지정 담당자 + RingOn 당직 (e-mail/SMS/Teams)
   [App] ──SMTP──▶ HAEA 릴레이        [App] ──HTTPS──▶ Teams webhook (프록시)        [App] ──HTTPS──▶ ServiceNow (eBonding)
```

### 3.1 Collector (probe) — `cflex-collector`
- Node.js 20 서비스(systemd). 사이트별 NMC 인벤토리를 App에서 받아(pull) 폴링 스케줄 실행.
- SNMP: **v3 authPriv read-only 우선**, v2c(ACL) 폴백. 현재 현장 NMC는 **SNMP v1만 설정**되어 있음 → 온보딩 시 v3/v2c 설정은 현장 작업(John). Collector는 장비별 프로토콜/크리덴셜을 개별 설정 가능해야 함(사이트 단위 기본값 + 장비 오버라이드).
- 폴링 주기: **기본 60초**, 장비/사이트별 설정 가능, **최소 10초**(Kay 질의 "5초/1분?" 답변 기준). 1분 1포인트 기준 44대 연간 raw < 5 GB.
- Trap 리스너 UDP 162 (SNMP v1/v2c/v3 trap, APC MIB 매핑).
- **Store-and-forward**: App 또는 포털로 전송 실패 시 로컬 디스크 큐(최대 7일, 40 GB 디스크 고려 상한 설정)에 보관 후 재전송. 순서·중복 제거 보장(장비ID+timestamp 키).
- 수집 항목(APC PowerNet MIB 최소): 입/출력 전압·전류·주파수, 부하 %, kVA/kW, 배터리 용량 %, 런타임, 배터리 온도, 배터리 상태/교체 필요 플래그, 배터리 설치일·교체 권장일, 모델·시리얼·펌웨어, 셀프테스트 결과/일시, 알람 상태 비트, 바이패스 상태, 내부 온도. Modular Ultra(SRYLF)·Symmetra LX(SYAF)·SRT 계열 OID 차이 흡수.
- Collector 다중화: 사이트→Collector 매핑, 각 Collector는 자기 ID로 App에 등록·헬스비트.

### 3.2 Application — `cflex-app` (Active/Standby)
- nginx(TLS 종단, 443) + Node.js 20 API/워커 + Redis 6(세션·큐·캐시). app01 Active, app02 Standby.
- 페일오버: Phase 1은 **DNS/수동 전환 또는 keepalived VIP**(HAEA가 VIP 허용 시) — §13 미확정. 애플리케이션은 **무상태(stateless)** 로 작성하여 어느 노드가 Active여도 동일하게 동작(세션은 Redis, 파일은 `/opt/app/data` 공유 불가 전제 → 첨부/리포트 파일은 DB 또는 포털 업로드로 처리).
- 기능 모듈: 인벤토리·자산(사이트/장비/Exhibit 1 임포트), 텔레메트리 수신·저장, 알람 엔진(P1–P4 분류, 억제/중복제거/플래핑 방지), 배터리 EOL 90일 알림, 대시보드, 리포트(월간 Executive Report PDF), 알림(SMTP/Teams), ITSM eBonding, 포털 포워더, 사용자/권한, 감사로그, 설정 UI.
- 인증: Phase 1 **로컬 계정 + 역할(Admin/Operator/Viewer)**, MFA 선택. **SAML 2.0 SSO는 설정만으로 활성화** 가능하게 준비(HAEA Entra ID 예상).

### 3.3 Database — `cflex-db`
- PostgreSQL 16 (AppStream 모듈). 데이터 디렉터리 `/opt/data/pgsql`, WAL 아카이브·백업 `/opt/data/backup`.
- 텔레메트리 테이블 **월 단위 네이티브 파티션**, 앱 스케줄러가 N개월 선행 생성·보존기간 경과 파티션 드롭.
- 보존 정책(기본, 설정 가능): raw 1분 데이터 **3년**, 시간/일 집계 **10년**, 알람·이벤트·감사로그 **10년**. (Kay 질의 "3년? 10년?" 답변 기준)
- 백업: 일 1회 `pg_basebackup` + WAL, 보존 14일, `/opt/data/backup` (500 GB 내 배분 계산 포함). 복구 절차 문서화.
- 향후 스트리밍 복제 스탠바이 추가 가능하도록 `wal_level=replica`, 복제 슬롯·인증 사전 준비(비활성).

### 3.4 매니지드 서비스 포털 연동 (핵심 경로) — `cflex-forwarder`
- Collector(1차) 및 App(2차: 알람·리포트·헬스)에서 **cflex.fms.support:443** 으로 **아웃바운드 HTTPS, TLS 1.2+, mTLS(장치 인증서)**. HTTP(S) 프록시 설정 지원(`HTTPS_PROXY`, 인증 프록시 포함), 프록시 CA 신뢰 설정.
- 전송 데이터: 텔레메트리·이벤트·알람·장비 식별정보(사이트/라벨/모델/시리얼/NMC IP)·플랫폼 헬스. **개인정보·업무데이터 없음**을 코드 수준에서 보장(스키마 화이트리스트).
- 포털에서 알람 라우팅/에스컬레이션(사이트별 지정 담당자 + RingOn 당직, e-mail/SMS/Teams, ACK 추적) 수행 — 온프레미스 App의 SMTP/Teams 알림과 **중복 발송 방지 정책**(설정: 로컬 알림 on/off, 포털 알림 on/off, P1만 양쪽 등).
- 포털 불가 시(방화벽 거절) **로컬 모드**: SMTP/Teams 알림만으로 24/7 운영 가능해야 함 (알람 메일을 support@ringonservice.net 로 발송하는 설정 포함).
- 장치 등록: 고객 테넌트 코드 + 장치 인증서 발급(오프라인 CSR → 포털 서명 → 번들에 포함 또는 설치 시 주입).

### 3.5 알림·ITSM
- SMTP: HAEA 릴레이(주소/포트/인증 설정), 발신자·수신 그룹 설정, HTML 템플릿.
- Teams: Incoming Webhook URL(프록시 경유), 어댑티브 카드.
- ServiceNow eBonding: 인시던트 생성/업데이트/종료 REST API, 우선순위 매핑(P1–P4 ↔ Impact/Urgency), 중복 방지(알람 ID ↔ INC 번호), **SOW 수락 기준 "ITSM eBonding test ticket completed"** 를 위한 테스트 티켓 기능.

---

## 4. 기능 요구사항 (상세)

### 4.1 인벤토리·온보딩
- 사이트: HMA FV / KUS Irvine / HAEA HQ (+ 향후 사이트 추가). 사이트 속성: 주소, 타임존, Collector 매핑, SNMP 기본 크리덴셜, 지정 담당자(알림 그룹).
- 장비: Exhibit 1 CSV/XLSX **임포트** (라벨, 모델, 모델번호, 시리얼, 위치, NMC IP). Exhibit 1 외 장비(현장 발견분) 추가·"SOW 외" 태그.
- NMC 자동 탐지/검증: IP에 SNMP 시도 → sysDescr·모델·시리얼 읽기 → 인벤토리 시리얼과 **불일치 경고**(예: MPOE 1E-A Exhibit 1 시리얼 5D2249T04846 vs 섀시 AD2248220154 → 모듈형 장비는 프레임/MIM 시리얼 둘 다 저장).
- 제조일 자동 추정: APC 시리얼 3~6자리 = YYWW → 제조년월 저장(라이프사이클 산출용). NMC가 보고하는 제조일(기본값 1/1/2013 등)은 "unverified"로 표시.

### 4.2 모니터링·알람
- 알람 분류 P1–P4 (SOW SLA: P1 현장 4시간, 일반 NBD). 기본 매핑 예: On Battery/Low Battery/Battery Failed/Output Off → P1; Overload/Bypass/고온 → P2; 자체진단 실패/통신 단절 30분 → P3; 정보성 → P4. 사이트별 오버라이드.
- 중복 억제·플래핑 방지·유지보수 모드(PM 방문 시 억제).
- **배터리 EOL 90일 사전 알림**: 설치일 + 수명(모델별 기본 3~5년, 설정) 또는 NMC의 교체 권장일 기준.
- 통신 단절(폴링 실패 N회) 알람, Collector 헬스 알람, 포털 전송 실패 알람.

### 4.3 대시보드·리포트
- 대시보드: 사이트 → 장비 드릴다운, 상태 요약, 알람 목록, 트렌드(부하/전압/배터리), 라이프사이클(연식·배터리 교체 예정) 뷰.
- **월간 Executive Report**(SOW Deliverable 6): 가용성, 알람 통계, 배터리 상태, 교체 권장, SLA 준수 — PDF 생성·메일 발송·포털 업로드.
- 연간 **라이프사이클/예산 예측표**(고객 요청: 매년 9월 차년도 교체 예산 — Region/Office/City/Item/Age/Cost) 내보내기(CSV/XLSX).
- PM 리포트 첨부 보관(분기 PM 결과 PDF 업로드, 장비별 연결).

### 4.4 3D 평면도(Digital Twin) 뷰 — 기존 구현 이식
기존에 구현해 둔 **평면도 3D 뷰**를 HAEA 배포판에 포함한다. OVA 시절과 달리 온프레미스·오프라인 환경이므로 아래 조건을 만족하도록 이식한다.

- **렌더링**: 브라우저 WebGL(현 구현: Three.js 기반으로 가정 — 실제 스택/모델 포맷은 개발팀이 §13-9에 기재). 모든 JS 라이브러리·폰트·텍스처는 **번들에 포함**하여 nginx가 서빙한다. **CDN·외부 URL 호출 0건**(HAEA 내부망에서 인터넷 불가). 라이선스가 배포 가능한 오픈소스만 사용(SBOM에 기재).
- **모델 자산**: 사이트/층별 3D 모델(glTF/GLB 권장, Draco 압축), 2D 평면도 원본(DWG/PDF/PNG)에서 생성. 모델은 `/opt/app/cflex/shared/models/<site>/<floor>.glb` 에 저장하고 DB에 메타데이터(사이트, 층, 스케일, 원점, 버전) 등록. 모델 교체·추가는 Admin UI 업로드로 가능(재배포 불필요).
- **장비 매핑**: 인벤토리의 장비마다 (site, floor, x, y, z, rotation) 좌표를 가진다. **Admin 배치 편집기**: 3D 뷰에서 드래그로 장비를 놓고 저장, Exhibit 1의 Location 문자열(예: "HMA 3East", "IDF2 Relay Rack 2", "IE INFO RACK 4")을 층/구역 초기값으로 매핑. 좌표가 없는 장비는 "미배치" 목록에 표시.
- **실시간 상태**: 장비 마커 색상 = 알람 등급(Normal/P4/P3/P2/P1), 통신 단절은 회색 점멸. 클릭 → 상세 패널(현재 값·트렌드·알람·배터리 교체 예정·PM 리포트). 알람 발생 시 해당 층 자동 포커스 옵션. 데이터는 기존 대시보드와 동일 API(WebSocket/SSE)를 사용하고 폴링 주기와 동기.
- **사이트 구성(Phase 1)**: HMA Fountain Valley — 본관 1W~6W/E 층(IDF 각 층 A/B), 1E MPOE(IE Info Room), 6F Boardroom, Training Center(TC IDF1), Parking Garage(PG) / KUS Irvine — IDF1~7(1·2층) / HAEA HQ Irvine — 1F MDF(캐비닛 2·3), 2F MDF, IDF 332·433·537. **평면도 원본은 HAEA/HMA/KUS에서 수령 필요(§13-10)**; 수령 전까지는 층 단위 단순 박스 모델(블록아웃)로 배치만 가능하게 한다.
- **성능·호환**: HAEA 표준 브라우저(Edge/Chrome 최신)에서 층당 1만 폴리곤 이하 목표, 저사양 PC 대비 "2D 평면도 모드"(같은 좌표를 2D로 투영) 폴백 제공. 모바일/태블릿 터치 조작 지원.
- **포털 동기**: 모델·좌표 메타데이터를 포털로 함께 포워딩하여 RingOn 관제 포털에서도 같은 3D/2D 뷰를 제공(모델 파일은 포털 측 별도 업로드 또는 forwarder 통해 1회 전송, 용량 상한 설정).
- **보안**: 모델 파일은 로그인 사용자만 접근(nginx auth_request), 평면도에 민감 정보(출입통제, 보안실 등) 포함 시 Admin이 레이어 비공개 설정 가능.

### 4.5 PM(예방점검) 리포트 디지털화 — Q3 2026 점검 리포트 48건 기준
현재 분기 PM 결과는 엔지니어가 Word 양식("UPS Preventative Maintenance Service Report", 유닛당 4쪽 PDF)으로 수작업 작성한다(첨부 Q3 2026 리포트: HMA 35 · KUS 7 · HAEA 6 = 48건). 이 양식을 **제품 기능**으로 흡수한다.

- **PM 체크리스트 모듈**: 리포트 구조를 그대로 데이터 모델로 — 헤더(고객/사이트/주소/분기/시작·종료 시각/엔지니어), 서비스 승인 문구, System Information(제조사·모델·시리얼·정격 kVA/kW·입출력 전압·상수·팬 수·배터리 스트링 수·Ah·제조일·외부 바이패스 유형·설치 위치·펌웨어), UPS Battery Information(설치일·권장 교체일·배터리 상태·셀프테스트 결과/일시), **점검 항목 10~12개(PASS/FAIL/N/A)**(전기 연결 토크·과열, 바이패스 캐비닛, 팬, 자체진단 기록, 전면 디스플레이 값, 환경 온도, 알람 이력, 고객 리뷰 등), 전기 측정값(입출력 A-B/A-N/B-N 전압·전류, DC 전압, 부하 %, kVA/kW, 런타임), 환경(실내 온도, 청결), 비고/권고, 서명(FSE·고객).
- **모바일/태블릿 입력**: 현장에서 장비 QR/시리얼 스캔 → 해당 유닛 체크리스트 오픈, **SNMP로 읽을 수 있는 값은 자동 채움**(모델·시리얼·펌웨어·전압·부하·배터리 상태·셀프테스트·런타임), 엔지니어는 육안 점검 항목과 사진만 입력. 오프라인 입력 후 동기화.
- **출력**: 동일 레이아웃의 유닛별 PDF + 사이트별 합본(표지·인덱스 자동) + 분기 Status Report(3사이트 요약·조치 필요 유닛) 자동 생성 — 이번 Q3에 수작업으로 만든 패키지(인덱스 페이지 포함)와 같은 결과물을 버튼 하나로.
- **이력·비교**: 분기별 PM 결과를 유닛 타임라인에 저장, 직전 PM 대비 변화(배터리 상태·런타임·부하) 하이라이트, 월간/연간 리포트와 라이프사이클 예측표에 연결.
- **데이터 품질 규칙(Q3 리포트에서 실제 발견된 문제를 검증 규칙으로)**:
  1. 시리얼 중복 금지 — KUS IDF1·IDF2가 동일 시리얼(AS1935371831)로 기록됨 → 저장 시 중복 경고, Exhibit 1(IDF1 AS1936371898)과 대조.
  2. 제조일 신뢰도 — NMC/엔지니어 입력 제조일이 시리얼 YYWW와 불일치하면 "unverified" 플래그 (예: PG-A1 보고 2013-08 vs 시리얼 AQ2431=2024년 31주, PG-B1 보고 2013-02 vs AS2507=2025년 7주, MPOE 1E-A 이전 리포트 2013-01-01 vs AD2248=2022년 48주). 기본값성 날짜(1/1/YYYY) 자동 의심.
  3. 유닛 라벨 중복 — HMA "2E-A" 3건, "2E-B" 2건(시리얼은 모두 다름) → 라벨 유일성 + 위치 문자열 정규화(건물/층/실/랙), 라벨–위치 불일치(1W-B가 Parking Garage) 경고.
  4. 날짜 포맷 정규화 — 실제 입력 형태: `AUG 2025`, `10/13/2025`, `JUL-2025`, `12/11/2025 OR NEWER`, `May 2028`, `JULY 2028` → 파서는 월/연 단위 불확실성 보존(precision 필드).
  5. 필수값 누락 — 완료 시각, 제조일, Ah, 펌웨어 공란 다수 → 제출 전 필수 필드 검증(자동 채움으로 해소).
  6. Exhibit 1 외 장비 — "UNLISTED" 2건(HMA 2E-A 서브유닛) → `in_sow=false` 태그로 계약 범위와 분리 집계.
  7. 배터리 교체 권장일은 모델별 수명 규칙으로 자동 계산하고 엔지니어 값과 차이 시 표시(예: SRT 계열 설치+4.5~5년, Modular Ultra 10년).
- **시드 데이터**: 부록 C(`Appendix_C_Q3-2026_PM_Inventory_Seed.csv`) — 48대 모델·시리얼·위치·펌웨어·배터리 설치/교체 권장일·셀프테스트·PM 일자·점검 결과. 설치 시 인벤토리 초기 로딩과 첫 분기 PM 이력으로 임포트(Exhibit 1 IP 목록과 시리얼로 조인).

### 4.6 사용자·보안
- 역할: Admin / Operator / Viewer. 로컬 계정(비밀번호 정책·잠금) + SAML SSO 준비.
- 감사로그(로그인, 설정 변경, ACK, 수동 작업).
- 비밀정보: DB 비밀번호, SNMP 크리덴셜, SMTP/Teams/ServiceNow 토큰, 포털 인증서 키 → 파일 권한 0600 + 암호화 저장(앱 마스터 키는 systemd credential 또는 보호된 파일). 로그에 비밀정보 출력 금지.
- TLS: nginx 서버 인증서는 HAEA 내부 CA 발급 예상 → 교체 절차 제공. 기본은 자체서명 + 교체 가이드.

### 4.7 용량 목표
- 500 UPS, 50 사이트, 10초 폴링 최악 조건에서 App 1노드·DB 1노드로 수용 (4 vCPU/16 GB). 설계 시 산정표 제출.

---

## 5. 설치 번들 및 설치기 (`cflex-install`)

### 5.1 번들 구성
```
cflex-fms-2.x.y-rhel8-offline.tar.gz
├── MANIFEST.json            # 버전, 빌드일, 파일별 SHA-256, SBOM 참조
├── SHA256SUMS
├── sbom/ (CycloneDX json)    # Security 사전 검토용 패키지 인벤토리
├── install/
│   ├── cflex-install         # bash + node, 역할: --role collector|app|db, --config site.yaml
│   ├── preflight.sh          # OS/모듈/디스크/SELinux/firewalld/권한 점검, 실패 시 중단
│   ├── roles/{collector,app,db}/   # 역할별 systemd unit, nginx conf, sysconfig, selinux 모듈(.pp)
│   └── uninstall.sh / rollback.sh
├── app/                      # Node 앱 + 사전 빌드 node_modules (RHEL 8 x86_64)
├── collector/
├── db/                       # 스키마 마이그레이션(버전형), 초기 데이터, 파티션 생성 SQL
├── config/site.example.yaml  # 모든 설정 키 샘플 (아래 §6)
└── docs/ (MOP, 설정 레퍼런스, 백업/복구, 업그레이드, SAT 체크리스트)
```

### 5.2 설치기 요구사항
- **사전 점검(preflight)**: RHEL 8.10 확인, Satellite 모듈 활성 가능 여부(`dnf module list nginx nodejs:20 postgresql:16 redis:6`), `/opt/app`·`/opt/data` 마운트·용량, SELinux enforcing, firewalld, sudo, 시간동기, 호스트명·IP가 site.yaml과 일치. **네트워크 접근 0건**.
- OS 패키지 설치는 **`dnf module enable/install`만** 사용(Satellite 경유). 설치할 패키지 목록을 먼저 출력하고 `--yes` 없이는 진행하지 않음(HAEA 운영자 확인용).
- 모든 파일 `/opt/app/cflex/{current,releases/<ver>,shared}` (심링크 릴리스 전환, 롤백 1단계) / DB `/opt/data`.
- systemd 유닛: `cflex-collector`, `cflex-app`, `cflex-worker`, `cflex-forwarder`, `nginx`, `redis`, `postgresql-16`. `cflex` 사용자로 구동, `ProtectSystem=strict` 등 하드닝.
- SELinux: 커스텀 포트/컨텍스트가 필요하면 **정책 모듈(.pp) 번들 포함**, `setenforce 0` 금지.
- firewalld: 역할별 필요 포트만 오픈(§2.3), 나머지 거부.
- 멱등·재실행 가능, 로그 `/opt/app/cflex/log/install-<ts>.log`, 종료 시 요약(성공/실패/다음 단계).
- `cflex-install verify` : 설치 후 자가진단(서비스 상태, DB 연결, collector→app, app→portal 연결성(프록시 포함), SMTP/Teams/ServiceNow 연결 테스트 — 실제 발송은 `--send-test`).

### 5.3 업그레이드·롤백
- 새 번들 반입 → `cflex-install upgrade` → 릴리스 디렉터리 전환 + DB 마이그레이션(전방향, 롤백 스크립트 동반) → 헬스체크 실패 시 자동 롤백.
- Active/Standby 순차 업그레이드 절차(Standby 먼저).

---

## 5-B. 컨테이너 배포 프로파일 (기본) — Podman / Quadlet, UBI 이미지

§5의 베어 설치(AppStream 패키지 직접 설치)는 **폴백 프로파일**이다. 기본 프로파일은 **Podman 컨테이너**다. 같은 설치기(`cflex-install --profile container|bare`)가 두 프로파일을 모두 처리한다.

### 5-B.1 원칙
- **Docker 금지, Podman 사용.** Docker CE는 서드파티 저장소라 HAEA Security 승인 대상. Podman은 RHEL 8.10 AppStream `container-tools` 모듈(Satellite 제공)로 설치, 데몬 없음, **rootless**(`cflex` 사용자), systemd **Quadlet**(`.container`/`.pod` 유닛)으로 부팅 시 기동·재시작. 개발은 Dockerfile/compose로 하고 CI가 Quadlet 유닛을 생성한다.
- **베이스 이미지는 Red Hat UBI만**: `registry.redhat.io/ubi8/nodejs-20`, `rhel8/postgresql-16`, `rhel8/redis-6`, `ubi8/nginx-122`(또는 UBI9 동등). Docker Hub·Alpine·Debian 베이스 금지. 멀티아키 불필요(x86_64).
- **오프라인 이미지 번들**: 빌드 시 `podman save --multi-image-archive` → `images/cflex-<ver>.tar` + SHA-256 + 이미지별 SBOM(CycloneDX) + 취약점 스캔 리포트. 현장에서 `podman load`만 수행, 레지스트리 접속 0건. 이미지 서명(cosign/sigstore 또는 GPG)과 `podman image trust` 정책 파일 포함.
- **데이터는 호스트 볼륨**: `/opt/app/cflex/{config,certs,models,queue,log}`, `/opt/data/pgsql`, `/opt/data/backup` 을 `:Z` 라벨로 마운트. 이미지 교체(업그레이드/롤백)에도 데이터·설정 유지.
- **SELinux Enforcing 유지**(`container_t`), 호스트 노출 포트는 역할별 최소(§2.3)만 `podman`이 아닌 **firewalld**로 통제. 특권 컨테이너·`--privileged`·host network 금지(예외: collector의 UDP 162 trap 수신은 rootless에서 1024 미만 포트 바인딩 필요 → `net.ipv4.ip_unprivileged_port_start=161` sysctl 또는 firewalld 포트 포워딩(162→1162) 중 설치기가 선택, 문서화).
- **패치 책임 분리**: 호스트 OS = HAEA Satellite. **이미지 내부 패키지 = RingOn**이 월 1회 정기 리빌드 + 중요 CVE 시 수시 리빌드하여 새 이미지 번들 공급(변경로그·스캔 리포트 동봉). 이 절차를 운영 문서와 SOW 갱신본에 명시해 "Satellite 밖 소프트웨어" 우려에 답한다.
- HAEA 보안툴(EDR)과의 호환: rootless 컨테이너 프로세스는 호스트에서 일반 프로세스로 보임. 설치 전 HAEA에 "container-tools(Podman) 사용 가능 여부"와 EDR 컨테이너 정책을 확인(§13-11).

### 5-B.2 이미지 구성 (5개)
| 이미지 | 베이스 | 내용 | 실행 호스트 |
|---|---|---|---|
| `cflex/collector` | ubi8/nodejs-20 | SNMP 폴러·trap 리스너·로컬 큐·포털 포워더(collector 측) | cap01v |
| `cflex/app` | ubi8/nodejs-20 | API·워커·알람 엔진·리포트 생성(헤드리스 크롬 대신 PDF 라이브러리 사용, 폰트 포함)·ITSM·SMTP/Teams·forwarder(app 측) | app01v, app02v |
| `cflex/web` | ubi8/nginx-122 | TLS 종단, 정적 자산(대시보드·3D 뷰 라이브러리·모델 서빙 auth_request), 리버스 프록시 | app01v, app02v |
| `cflex/redis` | rhel8/redis-6 | 세션·큐·캐시, app01→app02 복제 | app01v, app02v |
| `cflex/postgres` | rhel8/postgresql-16 | DB + 초기화/마이그레이션 엔트리포인트, 백업 사이드카 스크립트 | db01v |

- 태그: `cflex/<img>:<semver>` + `:<semver>-<gitsha>`; `latest` 사용 금지(Quadlet 유닛에 고정 태그 기재).
- 각 이미지에 `/healthz`(HTTP) 또는 `pg_isready` 기반 **HEALTHCHECK**, 비루트 UID 고정(1001), 읽기 전용 루트 FS(`--read-only` + tmpfs), 로그는 stdout → journald(`podman logs` / `journalctl -u`).

### 5-B.3 Quadlet 배치 (예시: app 노드)
```
/etc/containers/systemd/ (rootful) 또는 ~cflex/.config/containers/systemd/ (rootless)
├── cflex.pod                 # app·web·redis를 한 pod로 (localhost 통신)
├── cflex-app.container       # Image=localhost/cflex/app:2.1.0  Pod=cflex.pod  Volume=/opt/app/cflex/config:/config:Z,ro ...
├── cflex-web.container       # PublishPort=443:8443
├── cflex-redis.container
└── cflex.network             # (collector/db 노드는 단일 .container)
```
`systemctl --user enable --now cflex-pod.service` (rootless, `loginctl enable-linger cflex`). 업그레이드 = 새 이미지 load → `.container`의 Image 태그 변경 → `systemctl daemon-reload && restart`; 롤백 = 태그 되돌리기(이전 이미지는 N-1 보관).

### 5-B.4 개발·CI 산출물
- 레포 구조: `images/{collector,app,web,redis,postgres}/Containerfile`, `compose.yaml`(개발용, podman-compose/docker compose 호환), `quadlet/` 템플릿(설치기가 site.yaml 값으로 렌더), `scripts/build-offline-bundle.sh`(이미지 빌드 → 스캔 → SBOM → save → 서명 → tar).
- CI 매트릭스: 이미지는 UBI8 기준 1종이지만 **호스트 테스트는 RHEL 8.10 / RHEL 9 / Rocky 9**에서 Podman 4.x로 설치기 E2E.
- 베어 프로파일(§5)은 같은 소스에서 빌드하며 릴리스마다 둘 다 산출(컨테이너 우선 검증).

### 5-B.5 SAT 추가 항목
- `podman load` 후 `podman image trust` 검증 통과, 이미지 다이제스트가 MANIFEST와 일치.
- 재부팅 후 모든 Quadlet 서비스 자동 기동, 헬스체크 정상.
- 이미지 태그 업그레이드 → 롤백 리허설(데이터 유지 확인).
- 컨테이너 프로세스가 HAEA EDR에 정상 표시, SELinux denial 0건(`ausearch -m avc`).

## 6. 설정 (`site.yaml` 주요 키)
```yaml
tenant: { code: HAEA, name: "Hyundai AutoEver America", timezone: America/Los_Angeles }
hosts:
  collectors: [{ id: cap01, host: haeipfmscap01v, ip: 10.138.14.66, sites: [HMA-FV, KUS-IRV, HAEA-HQ] }]
  app: [{ id: app01, ip: 10.138.14.67, role: active }, { id: app02, ip: 10.138.14.68, role: standby }]
  db: { host: haeipfmsdb01v, ip: 10.138.14.69, port: 5432 }
snmp: { default_version: 3, poll_interval_sec: 60, min_interval_sec: 10, trap_port: 162, per_site_credentials: ref }
portal: { enabled: true, url: https://cflex.fms.support, ip_pin: 40.114.79.164, mtls_cert: /opt/app/cflex/shared/certs/device.pem, proxy: "http://<haea-proxy>:<port>", buffer_days: 7 }
notify: { smtp: { host: <relay>, port: 587, from: fms-noreply@haeaus.com }, teams: { webhook: <url>, via_proxy: true }, policy: { local_email: true, local_teams: true, portal_routing: true, dedupe: true } }
itsm: { type: servicenow, url: <endpoint>, auth: ref, priority_map: {P1: 1, P2: 2, P3: 3, P4: 4}, test_ticket: true }
retention: { raw_years: 3, aggregate_years: 10, events_years: 10 }
auth: { local: true, saml: { enabled: false, idp_metadata: null } }
```

---

## 7. 보안·컴플라이언스 요구(HAEA 측 절차와 맞물림)
- VM은 **GMDM(정보시스템 등록) 코드 발급 → ITOM 등록 → HAEA 보안툴 배포 → 핸드오버** 후에야 우리에게 넘어온다. 설치기는 보안툴(EDR 등) 에이전트가 이미 있는 환경에서 동작해야 하며, 에이전트 프로세스/포트와 충돌 금지.
- Security 사전 검토용: **SBOM(CycloneDX) + 체크섬 + 오픈포트/리스닝 목록 + 아웃바운드 목적지 목록**을 번들 `docs/security/`에 포함.
- 방화벽 요청서 A/B/C/D(§2.3)와 실제 리스닝/아웃바운드가 1:1 일치하는지 자동 점검 스크립트(`cflex-install netcheck`).
- 로그: journald + `/opt/app/cflex/log`, 로테이션. 감사로그 변조 방지(append-only 테이블).

---

## 8. 고가용성·백업
- App Active/Standby: Redis 복제(app01→app02), 헬스체크, 전환 절차 문서. VIP(keepalived) 허용 여부 §13.
- Collector 단일 장애: Collector 다운 시 App이 P2 알람 + 포털 통보. (사이트별 Collector로 가면 사이트 단위 격리.)
- DB: 일일 베이스백업 + WAL, 복구 리허설 절차. 스탠바이 추가 설계 준비.
- 포털 측에서 온프레 플랫폼 헬스 모니터링(헬스비트 5분 미수신 시 RingOn 당직 알람).

---

## 9. 운영 (HAEA 이관 전제)
- 설치 후 HAEA가 **OS 패치·백업 인프라·계정**을 관리, RingOn이 **앱 운영·알람·리포트**를 수행(SOW Deliverable 6). 앱 업그레이드는 RingOn 유지보수 윈도우에 HAEA VPN/점프호스트로 수행.
- 운영 문서 세트: 설치 MOP(단계별 명령·예상 출력·롤백), 설정 레퍼런스, 백업/복구, 업그레이드, 장애 대응 런북, SAT 체크리스트, 핸드오버 체크리스트.

---

## 10. 현장 준비 상태(설치 전제) — 현황
| 항목 | 상태 |
|---|---|
| NMC 장착 | 전 장비 장착 확인(HAEA) |
| NMC IP | 전 장비 고정 IP(HAEA). 단 HMA PG-A2, PG-B2, 6F Boardroom은 Exhibit 1에 IP 없음 → 현장 확인 필요 |
| SNMP | **현재 v1만 설정** → v3(권장)/v2c+ACL 현장 설정 필요, 사이트별 read-only 크리덴셜은 HAEA 발급·관리, Collector에 RingOn이 입력 |
| 라우팅 | 10.138.14.x → HMA/KUS NMC VLAN 라우팅 여부 미확인 → 안 되면 Collector 3대 |
| 서비스 계정 | VM당 sudo 계정 HAEA 발급 예정 |
| 파일 반입 | HAEA 승인 경로로 오프라인 번들 전달 |

---

## 11. 수락 시험(SAT) — SOW 수락 기준 반영
1. 설치: 4 VM에 역할별 설치 완료, `cflex-install verify` 전 항목 PASS, 네트워크 호출 0건 증빙(설치 로그).
2. 온보딩: **44대(+현장 추가분) 전부 대시보드에 표시·수집 중**, SNMP v3 검증 로그(SOW D1 기준).
3. Trap 수신 테스트(장비 1대 셀프테스트 유발 또는 시뮬레이터).
4. 알람: P1 시나리오(On Battery) → 로컬 e-mail/Teams + 포털 수신 + ServiceNow **테스트 티켓 생성**(SOW D1 기준) + 지정 담당자 라우팅 확인.
5. 포털 연동: mTLS 접속, 프록시 경유, 전송 차단 후 복구 시 store-and-forward 무손실 확인.
6. 페일오버: app01 중지 → app02로 서비스 지속, 데이터 손실 없음.
7. 리포트: 월간 Executive Report 생성·발송(SOW D6 기준).
8. 배터리 EOL 90일 알림 시뮬레이션(설치일 조작).
9. 백업/복구 리허설, 업그레이드·롤백 리허설.
10. 보안: 리스닝 포트/아웃바운드 목적지가 방화벽 요청서와 일치, SELinux enforcing 유지, 비밀정보 평문 없음.
11. PM 모듈: Q4 2026 PM을 앱에서 수행 → 유닛 PDF·사이트 합본·분기 Status Report 자동 생성, Q3 이력과 비교 화면 확인.
12. 3D 평면도: 3개 사이트 전 장비 배치 완료, P1 시나리오 시 해당 장비 마커 적색·층 포커스, 외부 URL 호출 0건(브라우저 네트워크 탭 증빙), 2D 폴백 동작.

---

## 12. 산출물·일정
| 산출물 | 비고 |
|---|---|
| 오프라인 번들(컨테이너 이미지 tar + 서명 + 베어 패키지) + 체크섬 + SBOM | HAEA Security 사전 검토 제출 |
| 설치기·역할별 구성 | preflight/verify/netcheck 포함 |
| 설치 MOP·설정 레퍼런스·운영 문서 | 영문 (HAEA 제출), 국문 내부본 |
| SAT 체크리스트·결과서 | SOW D1/D6 수락 증빙 |
| 인벤토리 임포트 파일 | Exhibit 1 41대 IP + 현장 추가분 |
| 3D 평면도 모델·장비 배치 데이터 | 사이트/층별 GLB + 좌표, 블록아웃 → 실측 모델 순차 교체 |
| PM 체크리스트 템플릿 + Q3 2026 이력 임포트 | 부록 C CSV, 유닛별 PDF 48건 첨부 보관 |

일정 제약: HAEA 방화벽 승인·GMDM 코드·핸드오버 완료 즉시 설치 윈도우(목표 2026-11 초). 월간 리포트는 2026-12 분기부터 실 데이터로 발행.

---

## 13. 미확정 항목 (HAEA 회신 대기 — 설계는 양쪽 다 지원하도록)
1. 10.138.14.x → HMA/KUS NMC VLAN 라우팅 가능 여부 (Collector 1대 vs 3대)
2. App Active/Standby 전환 방식: keepalived VIP 허용 여부 vs DNS/수동
3. HAEA 웹 프록시 주소·인증 방식(포털·Teams 아웃바운드), SMTP 릴레이 주소/포트/인증, ServiceNow 엔드포인트·계정
4. 사용자 접근 소스 대역, RingOn 원격접속 방식(VPN/점프) — 유지보수용
5. 포털 아웃바운드(B) 승인 여부 → 거절 시 로컬 모드 + SMTP 필수, 대안으로 Site-to-Site IPsec(HAEA ↔ Azure 40.114.79.164) 제안 가능
6. HAEA 내부 CA 서버 인증서 발급 여부, SAML IdP(Entra ID) 연동 시점
7. HMA 3대 NMC IP, HMA Exhibit 1(31) vs 실사(35) 정합
8. 보존기간·최소 폴링 주기 최종 확정(기본값: 3년/10년, 60초/최소 10초)
9. 3D 평면도 기존 구현의 스택·모델 포맷·라이브러리 라이선스 확인(개발팀) → 오프라인 번들 포함 가능 여부
10. 사이트 평면도 원본(DWG/PDF) 수령 — HMA FV(본관 6개 층·MPOE·TC·PG), KUS(1·2층), HAEA HQ(1F·2F·3~5F IDF) — Kay/Patrick 통해 요청
11. HAEA RHEL 표준 빌드에서 container-tools(Podman) 사용 허용 여부, rootless 정책, EDR의 컨테이너 가시성 정책 — Security 확인 (거절 시 §5 베어 프로파일로 설치)

---

---

## 14. 상용 제품화 요구사항 (HAEA 범위를 넘어 제품으로 유지되어야 하는 것)

1. **에디션 구조**: 단일 코드베이스에서 (a) Cloud/매니지드 포털, (b) On-Premises Edition(컨테이너 기본 + 베어 폴백), (c) 사이트 Collector 어플라이언스(미니PC 이미지)를 빌드. 공통 코어 + 에디션별 패키징. **같은 컨테이너 이미지가 Cloud·On-Prem·OVA(내부에 Podman) 세 곳에서 동일하게 동작**하는 것이 목표. OVA 산출물은 On-Prem 에디션의 선택 포맷으로 유지.
2. **지원 OS 매트릭스**: RHEL 8.10 / RHEL 9.x / Rocky 9 (x86_64). CI에서 세 OS 컨테이너로 설치기·앱 테스트. Ubuntu 22.04는 Collector만.
3. **벤더 추상화**: UPS 드라이버 플러그인 구조 — APC/Schneider(PowerNet MIB: SRT, SRYLF Modular Ultra, Symmetra LX/PX, Smart-UPS) Phase 1, Eaton·Vertiv·Mitsubishi·Delta는 드라이버 추가만으로 지원. 장비 타입 확장(PDU, CRAC, 온습도·누수 센서, 발전기)은 같은 플러그인 인터페이스(poll/trap/normalize).
4. **테넌트·사이트 모델**: 온프레 1인스턴스 = 1테넌트이지만 데이터 모델은 멀티테넌트(tenant_id)로 설계해 포털과 스키마를 공유. 사이트/건물/층/구역 계층.
5. **설정 분리**: 모든 고객 값은 `site.yaml` + DB. 번들은 고객 무관(동일 체크섬). 라이선스 키 없음(무상 플랫폼 정책) — 대신 테넌트 코드·장치 인증서로 포털 식별.
6. **릴리스·버전**: SemVer, 번들 서명(GPG) + SHA-256, 변경로그, DB 마이그레이션 버전표, N-2 버전에서 업그레이드 지원, 롤백 1단계 보장.
7. **빌드 파이프라인**: 오프라인 번들을 CI에서 재현 가능하게 생성(네이티브 모듈 RHEL 8 glibc 빌드, node_modules 고정 lockfile), SBOM 자동 생성, 취약점 스캔 결과 첨부.
8. **테스트**: 단위·통합 + SNMP 시뮬레이터(APC MIB 응답·trap 생성)로 44대 이상 가상 장비 E2E, 설치기 멱등성 테스트, 업그레이드/롤백 테스트, 페일오버 테스트 자동화.
9. **문서 세트(제품 수준, EN/KR)**: 설치 가이드, 관리자 가이드, 운영 런북, API 레퍼런스(포털 연동·ITSM), 보안 백서(데이터 흐름·포트·암호화·SBOM), SAT 템플릿. HAEA 제출본은 이 템플릿에서 값만 채운 것.
10. **관측성**: 앱 자체 메트릭/헬스 엔드포인트(인증 필요), 포털 헬스비트, 로그 구조화(JSON) — 고객 SIEM 연계 가능.
11. **접근성·현지화**: UI 다국어(EN/KR, 추후 ES — KMX), 타임존·단위(°C/°F) 사이트별.
12. **3D 평면도 제품화**: 모델 업로드·배치 편집기·2D 폴백을 제품 기능으로(§4.4), 고객별 모델은 데이터.


## 부록 A. 의사결정 기록 (메일 스레드 기준)
| 일자 | 결정/합의 |
|---|---|
| 09-15 | HAEA 요구사항: 이중화 VMware(앱 2 + 코디네이터 1, RHEL 8.8), UPS 외 설비 통합 포함(→ Phase 1에서 UPS로 축소) |
| 10-13 | SAT 초안 제출(Hyundai Cloud + 사이트 Collector 안). Kay: Phase 1 = UPS 44대 SNMP, Teams/e-mail. Eric: FMS 2.0 사양표(Collector 3, App 2, DB 1+1), 1분 1포인트, 연 5 GB 미만 |
| 10-13 | Kay 질의: 최소 수집주기, 50+ 사이트 용량, 보존기간, 설치 소요, 무상 라이선스 → 본 문서 §3.1/§4.7/§3.3/§12/§1 반영 |
| 10-14 | HAEA 온프레미스 VM 호스팅 확정. RHEL 8.8 → **8.10**. VM 4대(cap/app×2/db) ISE 빌드 요청. HAEA가 설치 후 업데이트·라이선스 운영 |
| 10-14 | Mike: Satellite 네이티브 저장소만, 서드파티는 Security 승인 필요, 세그먼트 간 접근은 방화벽 승인 → **nginx/nodejs:20/postgresql:16/redis:6, pg_partman·repmgr 제외, 오프라인 패키지+체크섬** 합의 |
| 10-14 | Kay → Security: "벤더 RingOn의 외부 접근(24/7 모니터링) 필요" 명시 |
| 10-16 | HAEA 방화벽 요청 양식(HISNA) 수령 |
| 10-21 | 방화벽 요청 v1 제출(A/B/C) |
| 10-22 | VM 빌드 완료·IP 확정(.66~.69). GMDM 코드 대기(보안툴 배포·핸드오버 선행조건). 방화벽 v3: **포털 아웃바운드(cflex.fms.support = 40.114.79.164, static) 1순위**, VPN은 유지보수용으로 축소 |

## 부록 B. Exhibit 1 장비 목록(NMC IP)
- **HMA (28 w/ IP)**: PG-A 10.112.0.76, PG-B 10.112.0.77, TC-A 10.112.5.21, TC-B 10.112.5.20, 1W-A 10.112.3.155, 1W-B 10.112.3.169, 2E-A 10.112.7.21, 2E-B 10.112.7.20, 2W-A 10.112.9.39, 2W-B 10.112.9.50, 3E-A 10.112.11.139, 3E-B 10.112.11.40, 3W-A 10.112.13.44, 3W-B 10.112.13.19, 4E-A 10.112.15.74, 4E-B 10.112.15.15, 4W-A 10.112.17.186, 4W-B 10.112.17.208, 5E-A 10.112.19.136, 5E-B 10.112.19.180, 5W-A 10.112.21.157, 5W-B 10.112.21.187, 6E-A 10.112.23.155, 6E-B 10.112.23.2, 6W-A 10.112.25.32, 6W-B 10.112.25.20, MPOE 1E-A 10.112.5.34 (Symmetra LX SYAF16KRMT), MPOE 1E-B 10.112.5.19 (SRYLF15KRMT); IP 없음: PG-A2, PG-B2, 6F Boardroom
- **KUS (7)**: IDF1 10.119.141.25, IDF2 10.119.142.237, IDF3 10.119.143.129, IDF4 10.119.144.7, IDF5 10.119.145.9, IDF6 10.119.146.135, IDF7 10.119.147.21 (전부 SRT5KRMXLT)
- **HAEA HQ (6)**: IDF2 10.189.193.210, IDF3 .220, IDF4 .230, IDF5 .240 (SRT5KRMXLT); MDF-A .196, MDF-B .197 (SRYLF20KRMT)

## 부록 C. Q3 2026 PM 인벤토리 시드
별도 파일 `Appendix_C_Q3-2026_PM_Inventory_Seed.csv` (48행: site, unit, location, model, serial, serial_yyww, mfg_date_reported, firmware, battery_strings, battery_install, battery_replace_due, battery_status, self_test, pm_date, checks, fails, note, exhibit1, source). 원본 PDF 48건은 사이트별 zip으로 함께 보관.

