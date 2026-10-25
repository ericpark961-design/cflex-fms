# C-Flex FMS 2.x — 내부(HAEA 온프레미스) Probe & Local Console 명세서
### 담당: Claude Code · 문서번호 SPEC-CFLEX-INT-2026-1023 v1.0
### 계약서: `00_INTERFACE_CONTRACT_Probe-Portal_v1.md` (반드시 준수)

---

## 0. 역할 경계 — 무엇을 만들고, 무엇을 만들지 않는가

**만든다 (내부, HAEA 망 안)**
1. **Collector(probe)** — UPS NMC SNMP 폴링·trap 수신 → 정규화 → 로컬 저장 + 포털 전송.
2. **Local Console(앱)** — HAEA 사용자용 **단순 콘솔**: 장비 상태 보기, 실시간 값, **알람 받기·보여주기·ACK**, 간단 트렌드, 설정. 지금 만들어 둔 UI(심플한 현재 버전)를 그대로 완성한다. 기능을 더 얹지 않는다.
3. **Forwarder** — 계약서 §3대로 heartbeat/inventory/telemetry/events/files 전송, 명령 큐 처리, store-and-forward.
4. **로컬 알림(HAEA 내부 경로)** — HAEA SMTP 릴레이, Teams 웹훅(프록시), **ServiceNow eBonding**(HAEA 내부 ITSM이므로 내부에서 수행). 발송 결과를 이벤트의 `local_notified`에 실어 포털로.
5. **설치 번들·설치기·운영 문서** (컨테이너 기본, 베어 폴백).

**만들지 않는다 (외부 Portal = Codex 담당)**
- 담당자별 알람 라우팅/에스컬레이션/ACK 추적/SMS, RingOn NOC 콘솔, 멀티테넌트.
- 월간 Executive Report, 라이프사이클/예산 예측표, PM 체크리스트 디지털화, 3D 평면도 뷰, 고객 포털.
- 지정 담당자 연락처 저장(내부에는 HAEA 로컬 사용자 계정만 있음).

내부 콘솔은 **"알람을 받아서 보여주는 것"** 까지가 끝이다. 분석·보고·라우팅은 전부 포털.

---

## 1. 대상 환경 (HAEA 제공, 변경 불가)

| 호스트 | IP | 역할 | 사양 | 마운트 |
|---|---|---|---|---|
| haeipfmscap01v | 10.138.14.66 | Collector | 2 vCPU/4 GB/40 GB | — |
| haeipfmsapp01v | 10.138.14.67 | Local Console (Active) | 4 vCPU/16 GB | `/opt/app` 200 GB |
| haeipfmsapp02v | 10.138.14.68 | Local Console (Standby) | 4 vCPU/16 GB | `/opt/app` 200 GB |
| haeipfmsdb01v | 10.138.14.69 | PostgreSQL 16 | 4 vCPU/16 GB | `/opt/data` 500 GB |

- RHEL 8.10 (RHEL 9/Rocky 9 호환 유지), SELinux Enforcing, firewalld, HAEA EDR 설치됨, **인터넷 없음**, **HAEA Satellite AppStream만** (서드파티 저장소 금지), VM당 sudo 서비스 계정 1개, 앱은 `cflex` 비특권 계정.
- Collector는 1대. 10.138.14.x → HMA(10.112.x.x)·KUS(10.119.14x.x) NMC VLAN 라우팅이 안 되면 **사이트당 1대(3대)** → Collector N대 등록 구조 필수.
- DB 단일 노드(Phase 1), 추후 스트리밍 복제 스탠바이 추가 가능하게.

### 네트워크 (방화벽 요청서 v3와 1:1)
| 방향 | 포트 | 용도 |
|---|---|---|
| collector → NMC 41대(부록 B) | UDP 161 | SNMP v3 RO 폴링 (v2c 폴백) |
| NMC → collector | UDP 162 | trap |
| collector → NMC | TCP 443 | 온보딩/PM 시 NMC 점검(선택) |
| **collector/app → cflex.fms.support (40.114.79.164)** | **TCP 443 out** | **포털 전송(mTLS, 프록시 경유 가능) — 1순위** |
| HAEA 사용자 VLAN/VPN → app | TCP 443 | 로컬 콘솔 |
| RingOn(HAEA VPN/점프) → 4 VM | TCP 22/443 | 설치·유지보수 윈도우만 |
| collector → app 443, app → db 5432, app01↔app02 6379/443 | 내부 | |
| app → HAEA SMTP 릴레이 25/587, → 프록시 → Teams 443, → ServiceNow 443, → Satellite/DNS/NTP | 내부/아웃 | |

인터넷 **인바운드 없음**. 포털 연결은 항상 내부에서 시작.

---

## 2. 컴포넌트 명세

### 2.1 Collector — `cflex-collector`
- Node.js 20. 인벤토리(사이트→장비→NMC IP·프로토콜·크리덴셜)를 Local Console API에서 pull.
- SNMP v3 authPriv RO 우선, v2c(ACL) 폴백, 장비별 오버라이드. **현장 NMC는 현재 v1만** → 온보딩 때 현장 설정(John). 사이트별 RO 크리덴셜은 HAEA 발급.
- 폴링 기본 60초, 장비/사이트별 설정, 최소 10초. Trap 리스너 UDP 162(v1/v2c/v3).
- APC PowerNet MIB 드라이버: SRT(SRT3000/5K/8K RMXLT·RMXLA-NC·RMXLAQ), Modular Ultra(SRYLF15K/20K RMT), Symmetra LX(SYAF16KRMT). 드라이버 플러그인 인터페이스(`poll()`, `onTrap()`, `normalize()`)로 Eaton/Vertiv 추가 가능하게.
- 수집 항목 = 계약서 부록 A 메트릭 사전. 알람 룰엔진 = 계약서 부록 B 코드 사전(P1–P4), 중복 억제·플래핑 방지·유지보수 모드.
- **Store-and-forward**: 포털/앱 전송 실패 시 디스크 큐(7일, 디스크 80% 상한), 재전송 순서·중복 제거(event_id/Idempotency-Key).
- 포털 forwarder 내장(계약서 §3.1–3.4, 3.6–3.7). 포털 불가 시에도 Local Console로는 계속 전송.

### 2.2 Local Console — `cflex-app` + `cflex-web`
- nginx(TLS 443) + Node.js API + Redis 6(세션/큐) + PostgreSQL 16. app01 Active / app02 Standby(무상태, 세션은 Redis, 전환은 keepalived VIP 허용 시 VIP, 아니면 DNS/수동 — §6-2).
- 화면(현재 UI 유지, 추가 금지):
  1. **사이트/장비 현황** — 사이트 카드 → 장비 리스트(상태색, 부하, 배터리 %, 런타임, 마지막 수집), 장비 상세(현재 값, 24h/7d 트렌드, 장비 정보·시리얼·펌웨어·배터리 설치/교체일).
  2. **알람** — 활성 알람 목록(P1~P4 필터, 사이트 필터), 상세, **ACK/코멘트**, 이력, 유지보수 모드 설정. 포털 라우팅 결과(통보 인원 수·티켓 번호)는 계약서 §4 조회가 가능할 때만 표시.
  3. **설정(Admin)** — 사이트·장비·NMC 크리덴셜(Exhibit 1 CSV/XLSX 임포트), 알람 임계치, 알림 채널(SMTP/Teams/ServiceNow), 포털 연결 상태, Collector 상태, 사용자/역할.
- 인증: 로컬 계정 + 역할(Admin/Operator/Viewer), 비밀번호 정책·잠금, 감사로그. SAML 2.0은 설정으로만 활성화 가능하게 준비.
- 로컬 알림: SMTP(HAEA 릴레이), Teams 웹훅(프록시), ServiceNow 인시던트 생성/업데이트/종료(P1–P4 ↔ Impact/Urgency, alarm_id↔INC 매핑, **테스트 티켓 버튼** — SOW 수락 기준). 정책 플래그: `local_email/local_teams/local_itsm` on/off, P1만 등. 발송 결과는 이벤트 `local_notified`로 포털에 전달.
- 인벤토리 검증 규칙(저장 시 경고): 시리얼 중복(KUS IDF1/IDF2 실제 사례), 제조일 vs 시리얼 YYWW 불일치(1/1/YYYY 기본값 의심), 라벨 중복(HMA 2E-A ×3), Exhibit 1 외 장비 `in_sow=false`, 모듈형 장비 프레임/모듈 시리얼 복수 저장(`serial_alt`).

### 2.3 DB — PostgreSQL 16 (`/opt/data`)
- 텔레메트리 **월 파티션(네이티브 선언적 파티셔닝, pg_partman 금지)**, 앱 스케줄러가 선행 생성·보존 만료 드롭. 보존 기본 raw 3년 / 집계 10년 / 이벤트·감사 10년.
- 일 1회 `pg_basebackup` + WAL, 14일, `/opt/data/backup`. `wal_level=replica` 사전 설정(스탠바이 대비). repmgr 금지.

---

## 3. 패키징·설치 (컨테이너 기본, 베어 폴백)

### 3.1 컨테이너 프로파일 (기본) — Podman + Quadlet, UBI 이미지
- **Docker 금지.** RHEL AppStream `container-tools`(Podman 4.x) 사용, rootless `cflex`, Quadlet `.container/.pod` 유닛, `loginctl enable-linger`.
- 이미지 5개, 전부 **Red Hat UBI8 베이스**: `cflex/collector`(ubi8/nodejs-20), `cflex/app`(ubi8/nodejs-20), `cflex/web`(ubi8/nginx-122), `cflex/redis`(rhel8/redis-6), `cflex/postgres`(rhel8/postgresql-16). 고정 태그, HEALTHCHECK, UID 1001, read-only rootfs, stdout 로그→journald.
- 오프라인 번들: `podman save` tar + SHA-256 + 서명(cosign/GPG) + 이미지별 SBOM(CycloneDX) + 취약점 스캔 리포트. 현장은 `podman load`만.
- 볼륨: `/opt/app/cflex/{config,certs,queue,log}`(`:Z`), `/opt/data/pgsql`, `/opt/data/backup`. 이미지 교체에도 데이터 유지.
- 특권/host network 금지. trap UDP 162: `net.ipv4.ip_unprivileged_port_start=161` 또는 firewalld 포워딩 162→1162 중 설치기가 선택(문서화).
- 이미지 내부 패치 = RingOn 월 1회 + CVE 시 리빌드 공급(운영 문서에 절차).

### 3.2 베어 프로파일 (폴백, HAEA가 Podman 거절 시)
- `dnf module enable nginx nodejs:20 postgresql:16 redis:6` (Satellite) 만 사용. node_modules 사전 빌드 포함. Valkey→Redis 6, pg_partman→네이티브 파티셔닝, repmgr 제외.
- 릴리스 디렉터리 `/opt/app/cflex/releases/<ver>` + `current` 심링크, systemd 유닛(`ProtectSystem=strict`), SELinux 정책 모듈(.pp) 포함, `setenforce 0` 금지.

### 3.3 설치기 `cflex-install` (두 프로파일 공통)
- `--role collector|app|db --profile container|bare --config site.yaml`
- `preflight`(OS/모듈/마운트/SELinux/firewalld/sudo/NTP/호스트명·IP 일치, **네트워크 호출 0건**), 설치할 패키지·이미지 목록 출력 후 `--yes` 없이는 진행 안 함, 멱등, 로그 `/opt/app/cflex/log/install-<ts>.log`.
- `verify`: 서비스·DB·collector→app·app→portal(프록시 포함)·SMTP/Teams/ServiceNow 연결성(`--send-test`로 실제 발송).
- `netcheck`: 실제 리스닝 포트·아웃바운드 목적지가 §1 네트워크 표와 1:1인지 자동 점검(HAEA Security 증빙).
- `upgrade`/`rollback`: 이미지 태그 교체(또는 릴리스 심링크) + DB 마이그레이션(전방향+롤백 스크립트), 헬스 실패 시 자동 롤백, Standby 먼저 순차.
- 번들 구조: `MANIFEST.json`, `SHA256SUMS`, `sbom/`, `images/` 또는 `app/`, `install/`, `db/migrations`, `config/site.example.yaml`, `docs/`(MOP·설정 레퍼런스·백업/복구·업그레이드·SAT 체크리스트·보안 백서: 포트·아웃바운드·데이터 흐름).

### 3.4 `site.yaml` 핵심 키
```yaml
tenant: { code: HAEA, timezone: America/Los_Angeles }
hosts:
  collectors: [{ id: cap01, ip: 10.138.14.66, sites: [HMA-FV, KUS-IRV, HAEA-HQ] }]
  app: [{ id: app01, ip: 10.138.14.67, role: active }, { id: app02, ip: 10.138.14.68, role: standby }]
  db: { ip: 10.138.14.69, port: 5432 }
snmp: { default_version: 3, poll_interval_sec: 60, min_interval_sec: 10, trap_port: 162 }
portal: { enabled: true, url: https://cflex.fms.support, ip_pin: 40.114.79.164, mtls_cert: /opt/app/cflex/certs/device.pem, proxy: "http://<haea-proxy>:<port>", buffer_days: 7 }
notify: { smtp: { host: <relay>, port: 587 }, teams: { webhook: <url>, via_proxy: true }, itsm: { type: servicenow, url: <endpoint> }, policy: { local_email: true, local_teams: true, local_itsm: true } }
retention: { raw_years: 3, aggregate_years: 10, events_years: 10 }
auth: { local: true, saml: { enabled: false } }
```

---

## 4. 보안
- GMDM → ITOM → HAEA 보안툴 배포 → 핸드오버 후 설치. EDR 에이전트와 충돌 금지.
- Security 사전 제출물: SBOM·체크섬·리스닝/아웃바운드 목록·데이터 흐름(계약서 §5 데이터 최소화 그대로).
- 비밀정보(DB·SNMP·SMTP/Teams/ServiceNow·장치 인증서 키): 0600 + 암호화 저장, 로그 출력 금지. mTLS 키는 노드 밖으로 나가지 않음(계약서 §6).
- 감사로그 append-only. nginx 인증서는 HAEA 내부 CA 교체 절차 제공.

## 5. 수락 시험(SAT) — 내부 범위
1. 4 VM 설치 완료, `verify`·`netcheck` 전부 PASS, 설치 중 네트워크 호출 0건(로그).
2. **44대(+현장 추가분, 실사 48대) 전부 콘솔에 표시·수집**, SNMP v3 검증 로그 (SOW D1).
3. Trap 수신 테스트.
4. P1 시나리오(On Battery) → 콘솔 알람 표시·ACK, 로컬 e-mail/Teams, **ServiceNow 테스트 티켓**(SOW D1), 포털 수신 확인(계약서 목 서버 또는 실 포털).
5. 포털 링크 차단 → 복구 시 store-and-forward 무손실.
6. app01 중지 → app02 서비스 지속.
7. 백업/복구·업그레이드/롤백 리허설(컨테이너: 이미지 태그, 재부팅 후 자동 기동, `podman image trust` 검증).
8. SELinux denial 0건, EDR에 프로세스 정상 표시, 비밀정보 평문 없음.

## 6. 미확정 (HAEA 회신 대기 — 양쪽 다 지원)
1. 10.138.14.x → HMA/KUS NMC VLAN 라우팅 (Collector 1 vs 3)
2. keepalived VIP 허용 여부 vs DNS/수동 전환
3. HAEA 프록시 주소/인증, SMTP 릴레이, ServiceNow 엔드포인트·계정, 사용자/원격접속 소스 대역
4. Podman(container-tools) 허용 여부·rootless·EDR 정책 → 거절 시 베어 프로파일
5. HAEA 내부 CA 인증서, SAML IdP 시점
6. HMA 3대 NMC IP(PG-A2, PG-B2, 6F Boardroom), Exhibit 1(31) vs 실사(35)

## 부록 A. 수량 기준
**44** = SOW Exhibit 1 계약 대수 / **41** = NMC IP 기재분(방화벽 대상) / **48** = Q3 2026 실사(HMA 35·KUS 7·HAEA 6, 시드 CSV). 혼용 금지.

## 부록 B. Exhibit 1 NMC IP
- HMA(28): PG-A 10.112.0.76, PG-B 10.112.0.77, TC-A 10.112.5.21, TC-B 10.112.5.20, 1W-A 10.112.3.155, 1W-B 10.112.3.169, 2E-A 10.112.7.21, 2E-B 10.112.7.20, 2W-A 10.112.9.39, 2W-B 10.112.9.50, 3E-A 10.112.11.139, 3E-B 10.112.11.40, 3W-A 10.112.13.44, 3W-B 10.112.13.19, 4E-A 10.112.15.74, 4E-B 10.112.15.15, 4W-A 10.112.17.186, 4W-B 10.112.17.208, 5E-A 10.112.19.136, 5E-B 10.112.19.180, 5W-A 10.112.21.157, 5W-B 10.112.21.187, 6E-A 10.112.23.155, 6E-B 10.112.23.2, 6W-A 10.112.25.32, 6W-B 10.112.25.20, MPOE 1E-A 10.112.5.34 (SYAF16KRMT), MPOE 1E-B 10.112.5.19 (SRYLF15KRMT); IP 없음: PG-A2, PG-B2, 6F Boardroom
- KUS(7): 10.119.141.25 / .142.237 / .143.129 / .144.7 / .145.9 / .146.135 / .147.21 (SRT5KRMXLT)
- HAEA HQ(6): IDF2 10.189.193.210, IDF3 .220, IDF4 .230, IDF5 .240 (SRT5KRMXLT), MDF-A .196, MDF-B .197 (SRYLF20KRMT)

## 부록 C. 시드 데이터
`Appendix_C_Q3-2026_PM_Inventory_Seed.csv`(48행) — 설치 시 인벤토리 초기 로딩(시리얼로 Exhibit 1 IP와 조인). PM 이력 자체는 포털로 업로드(계약서 §3.5).
