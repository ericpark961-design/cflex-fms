# C Flex 병행 개발 인계

2026년 10월 11일 기준. 기존 개발자의 작업 디렉터리와 브랜치를 유지하고 Codex는 별도 브랜치와 worktree에서 작업한다. 이번 체크포인트는 Mac의 현재 소스이며 운영 서버 파일이나 DB의 최신 스냅샷을 뜻하지 않는다. 코드 이동, 서버 변경, 배포, 원격 push는 수행하지 않았다. 비밀번호, API 키, SNMP community 값, webhook URL, 개인키와 토큰은 포함하지 않는다.

## 저장소와 체크포인트

| 역할 | 로컬 경로 | GitHub 저장소 | 현재 브랜치 | 소스 커밋 |
| --- | --- | --- | --- | --- |
| FMS 및 Twin 최신 개발 | `/Users/macstudio/work/cflex-fms` | `ericpark961-design/cflex-fms` | `feat/twin-rack-elevation` | `3206eec` |
| Node 고객 Probe | `/Users/macstudio/work/cflex-probe` | `ericpark961-design/cflex-probe` | `main` | `f0567bf` |
| 기존 v2 기반 소스 | `/Users/macstudio/work/cflex-v2` | `ericpark961-design/cflex-v2-prod-2026-05-` | `main` | `05ad935` |

세 저장소 모두 시작 시 변경사항이 없었다. 각 저장소의 로컬 `checkpoint/source-2026-10-11` 브랜치가 위 소스 커밋을 고정한다. 전체 SHA와 원격 URL은 `checkpoint-source-2026-10-11.json`에 있다. FMS 인계 문서는 별도 커밋이며 `checkpoint/handoff-2026-10-11` 브랜치로 고정한다. 원격 저장소 반영 여부는 별개다.

병행 개발 시작 예시(아직 실행하지 않음):

```sh
cd /Users/macstudio/work/cflex-fms
git worktree add ../cflex-fms-codex -b codex/fms-next checkpoint/handoff-2026-10-11
```

기존 작업 경로에서 checkout/reset/stash를 하지 않는다. 담당 파일을 먼저 나누고 각자 커밋한 뒤 리뷰하여 cherry-pick 또는 merge한다. `cflex-v2-prod-2026-05-`, v1, 모바일 등 다른 디렉터리는 이번 변경 대상에서 제외했다. 운영 `/opt` 파일은 Git 정본과 다를 수 있으므로 향후 배포 전 파일 해시와 DB 스키마를 대조해야 한다.

## 실행과 소스 범위

현재 FMS 저장소의 `backend/`에는 서비스·라우트·마이그레이션 패치가 있지만 독립 실행용 package.json, 서버 부트스트랩, DB config가 없다. README의 `cd backend && npm install && node src/server.js`만으로 재현되지 않는다. `cflex-shell/`도 기존 v2 위에 얹는 패치다. API 개발에는 기반 v2 소스와 의존성, 별도 개발 DB 및 비밀정보 주입이 필요하다. 운영 DB에 로컬 개발 프로세스를 연결하지 않는다.

Twin은 독립 앱이며 오프라인 mock으로 시작할 수 있다. 두 터미널을 사용한다.

```sh
cd /Users/macstudio/work/cflex-fms/apps/twin
npm ci
node mock/server.js
# 다른 터미널에서 같은 디렉터리
npm run dev
# http://localhost:5174/twin/  — mock API localhost:3001
```

검증: Twin에서 `npm test`, `npm run build`, `npm run lint`. 백엔드 순수 로직 테스트는 해당 `*.test.js`의 의존성을 확인하고 `node --test`로 선택 실행한다. Python Probe는 `python3 -m pytest probe/tests`이며 별도 Python 환경을 사용한다. 이번 문서 작업에서는 앱 설치·기동·전체 테스트를 수행하지 않았다.

Node Probe는 Node 20 이상에서 `npm install`, `.env.example`을 참고한 로컬 `.env` 구성, `npm start`로 실행한다. 시작 직후 장비 설정을 조회하고 5초 후 실제 폴링하므로 격리된 시험 대상에만 연결한다. `CFLEX_TOKEN`이 없으면 중앙 전송 대신 버퍼링한다. 운영 설치용 `install.sh`는 systemd와 파일을 변경하므로 이번에는 실행하지 않았다.

주요 환경변수 이름: `CFLEX_URL`, `CFLEX_TOKEN`, `TENANT_ID`, `PROBE_ID`, `POLL_INTERVAL_MS`, `HEARTBEAT_INTERVAL_MS`, `BUFFER_DB_PATH`, `BUFFER_RETENTION_DAYS`, `SNMP_VERSION`, `SNMP_COMMUNITY`, `SNMP_TIMEOUT_MS`, `SNMP_RETRIES`. 값은 담당자가 별도 보안 경로로 제공한다.

## Azure 구성

아래는 저장소 nginx·배포 스크립트 및 기존 운영 기록 기준이다. 현재 Azure 리소스를 실시간 조회하지 않았으므로 NSG·DNS·실행 프로세스와 실제 서버 파일은 재확인 대상이다.

| 호스트 | 역할과 경로 | 실행과 DB |
| --- | --- | --- |
| `cflex-v2-vm`, `20.25.17.81` | `cflex.runless.co.uk`, 중앙 shell/API. `/opt/cflex-v2/cflex-api`, `/opt/cflex-v2/cflex-frontend/dist` | PM2 사용자 `cflex`, 앱 `cflex-api-v2`, TCP 3000. SQLite `/opt/cflex-v2/cflex-api/data/cflex.db`가 최신 배포 스크립트 기준 |
| `vm-cflex-probe-01`, `172.172.161.236`, `RG-CFLEX-PROD` | `fms.runless.co.uk`, Azure 참조 FMS. `/opt/cflex-fms/frontend-dist`, `/opt/cflex-fms/twin-dist`, `/opt/cflex-fms/backend` | 기록상 PM2 사용자 `ringon`, `cflex-fms-api`, TCP 3000, SQLite `/opt/cflex-fms/data/fms.db` |
| 동일 참조 VM | `sentinel.runless.co.uk`, `/opt/cflex-sentinel-api` | Sentinel API TCP 4000 |

중요: 체크인된 `nginx/vm1-fms-vhost.conf`는 `/v1/`을 로컬 API가 아니라 `https://cflex.runless.co.uk`로 프록시한다. 따라서 참조 FMS 화면이 떠도 로그인/API는 중앙 장애의 영향을 받는다. 고객 어플라이언스는 `/v1/`을 로컬 3000으로 연결하는 자립 구조다. 두 구성을 혼동하지 않는다.

중앙 VM에는 FMS 외 서비스도 공존한다. 과거 디스크 포화로 SQLite I/O 오류, PM2 dump 손상, FMS 로그인 장애가 함께 발생했다. 기록상 디스크는 128 GB로 확장했고 로그 회전·디스크 가드를 추가했다. 향후 장애 확인은 SPA HTTP 200만 보지 말고 API health·인증 조회·디스크·PM2를 함께 본다. Azure 참조 FMS에는 2분 워치독 기록이 있으나 VM 전체 다운을 감지할 외부 감시는 별도 과제다.

## 현대 내부 VMware 구성

제품의 목표는 고객 VMware 안에 FMS 전체 스택을 설치하는 온프레미스 어플라이언스다. 로컬 UI → 로컬 nginx → 로컬 FMS API → 로컬 SQLite로 동작하며 Probe가 UPS VLAN을 폴링한다. 고객 알람도 로컬에서 채널로 직접 발송하고 중앙에는 알람을 아웃바운드로 전달하는 모델이다. 전체 telemetry를 중앙으로 전송하는 기존 Node Probe 모델과 구분한다.

기존 설치 런북 기준 Ubuntu 22.04, 2 vCPU, RAM 4 GB, 디스크 20 GB 이상, `open-vm-tools`, UPS 네트워크 도달성이 필요하다. systemd API 자동재시작·워치독·야간백업·하트비트 클라이언트가 설치 패키지 구성으로 기록되어 있다. VM 수준 HA는 고객 vSphere 정책에 따른다.

Mac 보관 산출물:

- `/Users/macstudio/Downloads/cflex-fms-appliance-1.0.4.run`
- `/Users/macstudio/Downloads/cflex-fms-1.0.4.ova`
- 구버전 `/Users/macstudio/Downloads/cflex-fms-appliance-1.0.3.run`

바이너리는 이번 Git 커밋에 넣지 않았다. 패키지에는 초기 계정 등 민감 설정이 있을 수 있으므로 별도 관리한다. 기록상 .run 1.0.4는 Linux 컨테이너 설치·업그레이드·로그인 검증을 거쳤으며 OVA는 구조 검증만 거쳤다. 실제 vSphere import, 고객 내부 설치 완료 여부, VMware VM명·IP·FQDN·VLAN·게이트웨이·접근 경유지·OS 인증 방식은 확인 필요다. Azure의 VM1을 현대 내부 VM1로 간주하지 않는다. 패키지 빌드 원본이 이 저장소에 완전히 포함되어 있다는 근거도 없으므로 바이너리만으로 소스 재현 가능하다고 보지 않는다.

## 연결 방향과 포트 및 인증

| 시작 → 목적지 | 포트와 프로토콜 | 용도와 인증 |
| --- | --- | --- |
| 사용자 브라우저 → Azure FMS 또는 고객 FMS | TCP 443 HTTPS | UI/API, 사용자 로그인 토큰. Twin은 `localStorage.cflex_token` 공유 |
| 브라우저 → nginx | TCP 80 HTTP | Azure 설정상 HTTPS 리다이렉트·ACME. 중앙 IP 직접접근 예외가 설정에 남아 있음 |
| Azure FMS nginx → 중앙 C Flex | TCP 443 HTTPS | `/v1/` 프록시, 사용자 인증 헤더 전달 |
| 중앙 nginx → 로컬 API | TCP 3000 HTTP loopback | 일반 `/v1/`; 외부 공개 포트로 간주하지 않음 |
| 고객 nginx → 로컬 FMS API | TCP 3000 HTTP | 어플라이언스 목표 구성, 로컬 인증 및 DB |
| Node Probe → 중앙 C Flex | TCP 443 HTTPS outbound | `X-Probe-Key`, `X-Probe-Id`, `X-Tenant-Id`. 서버는 키 prefix 조회 후 bcrypt hash 검증, tenant는 인증된 Probe에서 결정 |
| Probe → UPS NMC | UDP 161 SNMP | v2c community 또는 v3 사용자·인증·암호화 설정. 장비 ACL에 Probe 송신 IP 허용 필요 |
| 관리 단말 → Azure VM | TCP 22 SSH | 중앙 배포 스크립트는 `azureuser` SSH 사용. 키 값 제외. 참조 VM은 Azure Run Command 사용 기록도 있음 |
| 관리자 → Azure 관리 API | TCP 443 HTTPS | Azure CLI의 Entra 로그인·RBAC로 Run Command 수행. 실제 계정 권한은 별도 확인 |
| 로컬 알람 디스패처 → Slack·Teams·LINE·SMS 등 | TCP 443 HTTPS | webhook·OAuth·API 자격증명 등 채널별 방식, 값은 비공개 |
| Twin 개발 서버 → mock | TCP 3001 HTTP | 로컬 시험용, Vite는 TCP 5174 |

고객 측 중앙 통신은 outbound만 사용한다. 명령 조회도 Probe가 시작하는 HTTP 요청이며 중앙에서 내부 VMware로 연결하는 inbound 포트를 요구하지 않는다. 사용자 UI 접근은 고객 내부에서 별도 필요하다. DNS·NTP·패키지 다운로드 및 프록시 정책은 설치 환경에서 확인한다.

중앙 nginx에 UC 3100, NOC 8091 loopback, 참조 VM의 8080으로 eBond 프록시도 존재한다. 이들은 FMS 필수 수집 포트와 구분한다. Probe config의 `LOCAL_API_PORT=8080`은 선언만 있으며 현재 index.js에는 HTTP 리스너가 없다. Modbus TCP 502와 SNMP trap UDP 162는 확장 후보이며 현재 Node UPS 주기 수집의 필수 연결이 아니다.

사용자 SSO는 코드에 Microsoft Entra PKCE·JWKS 검증 및 tenant별 설정이 있으나 HAEA 실제 적용 여부는 확인 필요다. 기존 기록의 Bearer 방식 Probe 설명은 오래된 내용이며 현 코드의 `X-Probe-Key`가 기준이다. Python 차세대 egress의 mTLS는 예정 사항이다.

## DB와 API 계약

중앙과 어플라이언스 모두 SQLite 계열이지만 파일·스키마·라우트 마운트가 동일하다고 가정하지 않는다. 운영 파일을 개발 DB로 공유하지 않는다.

- 장비·수집: `ups_devices`, `ups_metrics`, `alerts`, `probes`. 장비 `tenant_id`와 CBU를 함께 유지한다.
- FMS: `fms_alarm_routes`, `fms_alarm_mutes`, push subscriptions 및 dispatch log. topology는 `fms_rooms`, `fms_racks`, `fms_devices`, `fms_power_links`.
- Incident: `cflex_tickets`, notes/RCA, `cflex_incident_alarm_links`; dedup·상태전이·알람 연결. `0010_incidents_layer.sql`은 다른 기본 스키마와의 호환성을 먼저 확인한다.
- 마이그레이션: `backend/migrations/`와 `deploy/backend/migrations/`는 패치 번들이며 현재 서버 적용 상태를 뜻하지 않는다. `apply.js`나 seed를 이번에는 실행하지 않았다.

Probe API의 현재 코드:

| 메서드와 경로 | 기능 |
| --- | --- |
| `POST /v1/probe/event` | `{kind,payload,buffered_ts?}`로 telemetry/alert 전송. 장비 tenant 일치 확인 |
| `POST /v1/probe/heartbeat` | 생존·버전 등 갱신 |
| `GET /v1/probe/devices` | 인증된 Probe에 속한 장비 설정 |
| `GET /v1/probe/jobs/next` | 작업 조회 |
| `POST /v1/probe/jobs/:jobUuid/result` | 결과 업로드 |
| `POST /v1/probe/jobs/:jobUuid/progress` | 진행 업로드 |

README의 `/poll-cmd`, `/cmd-result`는 현 서버 라우트와 다르다. 현재 Node Probe index/forwarder는 설정 조회·event·heartbeat·버퍼 drain만 연결하고 jobs 명령 루프는 구현되어 있지 않다.

화면 API는 `/v1/fms/assets`, `/assets/:id`, `/alerts`, `/floor`, `/topology` 등이 있으며 라우트 파일이 계약의 기준이다. 알람의 `device_id='ups-41'`과 자산 ID `41`을 혼용하지 말고 Twin `devId()`로 정규화한다. 조회에도 tenant·CBU 범위를 유지한다.

## 장비 수집 노하우와 현황

HAEA 계약 대상은 44 UPS, tenant 10, CBU는 HMA 31·KUS 7·HAEA_HQ 6이다. 원장 사본은 `reference/HMA_KUS_HAEA_UPS_List_Updated.xlsx`; 최근 KMX topology 확장 원장과 기존 44 UPS 원장을 혼합하지 않는다. 모델별 `apc_srt`, `apc_modular`, `apc_symmetra` 프로파일과 시리얼을 확인한다.

UPS-MIB RFC1628과 APC PowerNet OID는 단위가 다르다. 현 Node `ups-metrics.js`는 APC runtime ticks를 6000으로 나눠 분으로 만들고, 비 APC 전압은 10으로 나눈다. 신규 모델에는 실제 응답 원값과 단위를 대조한다. 값 0, OID 미지원, timeout, 빈 metrics를 같은 정상값으로 처리하지 않는다. NMC 버전, SNMP 버전, community/v3 설정, UDP ACL, 라우팅, 실제 Probe 송신 위치를 순서대로 확인한다. 중앙 Azure에서 사설 장비 IP를 직접 폴링한다고 성공을 기대하면 안 된다.

Node 주기는 기본 폴링 60초, heartbeat 30초, 설정 새로고침 5분, drain 30초, 버퍼 보존 7일이다. 장비는 순차 폴링하고 이전 사이클이 끝나지 않으면 다음 주기를 건너뛴다. 다수 timeout이 있으면 전체 수집 지연을 계산해야 한다. 장비 설정을 처음 한 번도 받지 못하면 폴링하지 않으며, 프로세스 재시작 후 오프라인 설정 캐시도 별도 검토가 필요하다.

`docs/probe_status_2026-10-10.csv`에는 다수 `Request timed out`, `no metrics`, `0.0.0.0` 미설정 주소와 오래된 `ok`가 기록되어 있다. 이는 해당 시각의 수집 상태이며 현재 상태로 단정하지 않는다. 마지막 성공 시각·마지막 시도·연속 실패·활성화 여부를 함께 본다. `reached` 필드를 SNMP 성공으로 자동 해석하지 않는다.

상태의 목표 계약은 `ok/warn/critical/unreachable/nodata`이며 데이터 없음과 연결 끊김은 위험과 분리한다. health score 80 이상 ok, 50 이상 warn, 미만 critical; 미수집은 점수가 없다. 단, 현재 probe route 실패 경로는 첫 두 실패를 `unknown`, 세 번째부터 `unreachable`로 저장하고 Node poller는 실패마다 P2 알람을 보낸다. 공통 derive-status와의 정합성·중복알람 억제는 확인 과제다. UI 정상 표시만으로 장비 통신 성공을 판정하지 않는다.

## 미완성 기능과 다음 개발

1. **소스 재현성**: standalone API 부트스트랩·의존성·DB 초기화와 .run/OVA 빌드 원본을 확보하고 개발 환경에서 재현한다. 운영 파일을 옮기는 작업은 별도 범위로 남긴다.
2. **고객 VMware 확인**: 실제 import·설치·로컬 로그인·UPS VLAN 접근·443 egress·재부팅 복구·백업 복원 검증. OVF properties/guestinfo로 tenant·hostname 설정 주입은 기존 기록상 미구현이다.
3. **수집 신뢰성**: timeout 장비·미등록 주소 정리, 모델별 실제 OID 검증, 상태 의미론 통일, 중복알람·버퍼 재전송 dedup, jobs 루프 및 로컬 설정 캐시 검토.
4. **Python 차세대 Probe**: `probe/docs/PHASES.md` 기준 상태·버퍼·수집 골격 완료, 실제 pysnmp backend는 미완성. edge inference 파일이 존재하므로 README 체크리스트만으로 완료를 판단하지 않는다. egress mTLS·업데이터·airgap 토글은 예정이며 Node 운영 Probe를 자동 대체하지 않는다.
5. **Twin 실데이터 연결**: Fleet Live/AI/PUE, 추이·예측·RCA, root-cause grouping/rules/rota, powerchain 샘플을 실제 데이터로 연결. 샘플 표시 배지를 유지하고 현재 branch의 랙 높이·위치·KMX 원장 작업을 보존한다.
6. **제품화**: 외부 dead-man 감시, 중앙 HA, 백업 데이터 상주 정책, 고객 vSphere HA 책임 경계. APC 온보딩 자동화는 실제 NMC에서 SSH/REST 차이를 확인한 후 진행한다.
7. **알림과 Incident**: 8월 운영 기록은 tenant 10의 Slack만 활성이라고 명시한다. 초기 SMS/Teams/LINE 계획과 구분하고 실제 DB 설정을 확인한다. Incident 계층·추가 마이그레이션의 배포 완료 여부도 코드 존재만으로 단정하지 않는다.

## 근거와 인계 경계

코드 근거: 저장소 `README.md`, `apps/twin/README.md`, `apps/twin/vite.config.js`, `backend/routes/probe.routes.js`, `backend/migrations/`, `probe/docs/PHASES.md`, `nginx/`, `deploy/deploy-fms-backend.sh`; 별도 Probe의 `src/index.js`, `src/forwarder.js`, `src/services/ups-metrics.js`.

기존 운영 기록 근거: `/Users/macstudio/.claude/projects/-Users-macstudio/memory/`의 `cflex_fms_haea_project.md`, `shared_vm_disk_dependency.md`, `apc_onboarding_deferred.md`, `cflex_incident_layer_phase1.md`. 기록은 시점이 다르고 민감 설정을 포함할 수 있으므로 원문을 Git에 복사하지 않았다. 실제 현대 내부 구성과 운영 최신 상태를 확정하려면 담당자 확인 또는 별도로 승인된 읽기 전용 점검이 필요하다.
