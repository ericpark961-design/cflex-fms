# HAEA RHEL 상용화 — 현재 저장소 상태

2026-10-22 작성 · Claude Code ↔ Codex 공동 작업용 인계 문서

**이 문서의 목적**: 설계 스펙이 **무엇을 만들어야 하는지**를 적은 문서라면, 이 문서는 **지금 무엇이 있는지**를 적은 문서다. 두 문서의 차이가 §9에 있고, 그게 실제 작업 목록이다.

**대조 기준**: `CFLEX_FMS_OnPrem_Design_Spec_v1.3.md` (SPEC-CFLEX-HAEA-2026-1023 **v1.3** 검수본) + 부록 C `Appendix_C_Q3-2026_PM_Inventory_Seed.csv` (v1.3 보정본, sha256 `c614220d…`). v1.0 대비 추가분은 §9-D(3D 평면도 §4.4, 상용 제품화 §14)와 §9-E(PM 리포트 디지털화 §4.5 + 시드 검증)에 정리했다.

**수량 기준 (v1.3 §1 — 혼용 금지)**

| 숫자 | 뜻 | 이 문서에서 |
|---|---|---|
| **44** | SOW Exhibit 1 계약 대수 | §14-8 시뮬레이터 E2E 목표 |
| **41** | Exhibit 1 중 NMC IP 기재분 (방화벽 룰 대상) | 수집기가 실제 폴링하는 대수 |
| **48** | Q3 2026 실사 대수 (부록 C 시드) | 카탈로그 커버리지 게이트 (`fleet.test.mjs`) |

⚠ **`docs/snmp_reach_2026-10-11.csv`의 48행은 위의 48이 아니다.** 그건 당시 DB에 등록된 전 장비(HMA 28 + KUS 7 + HQ 6 + KMX 5 + 테스트 2)이고 숫자가 우연히 같다. 혼동을 막기 위해 §3.2에 명시했다. v1.1은 성격이 바뀌었다 — **HAEA 1회성 커스텀이 아니라 C-Flex FMS 2.x 정식 온프레미스 에디션**이고, HAEA 고유 값은 전부 설정·데이터로 분리해 같은 번들로 KMX·GLOVIS·MPA·GENESIS에 배포할 수 있어야 한다.

**작성 원칙**: 저장소를 읽고 테스트를 실제로 실행해 확인한 사실만 적었다. 비밀번호·토큰·인증서 개인키·SNMP community 값·webhook URL은 포함하지 않는다. 이 문서 작성 중 **운영 서버와 고객 VM은 변경하지 않았다** (읽기도 하지 않았다 — 전부 저장소 기준).

**선행 문서**: `docs/CODEX_HANDOFF_2026-10-11.md` (10-11 체크포인트, 병행 개발 규칙). 그 문서의 규칙은 유효하고, 이 문서는 HAEA RHEL 관점의 내용을 더한다.

---

## 1. 저장소·브랜치·커밋

| 항목 | 값 |
|---|---|
| GitHub | `git@github.com:ericpark961-design/cflex-fms.git` (origin, fetch=push) |
| 로컬 경로 | `/Users/macstudio/work/cflex-fms` |
| 현재 브랜치 | `feat/twin-rack-elevation` |
| 커밋 | `6c9cb6e` — *fms: stop the SMS flood — and stop a disabled route from sending anyway* |
| 워킹트리 | clean (미커밋 변경 0건) |
| `main` 대비 | **ahead 9 / behind 0** — 이 브랜치가 최신이고 `main`은 뒤처져 있다 |

### 1.1 워크트리 (Codex가 이미 쓰고 있는 것)

```
/Users/macstudio/work/cflex-fms         6c9cb6e [feat/twin-rack-elevation]   ← Claude Code
/Users/macstudio/work/cflex-fms-codex   23576fd [codex/bootstrap]            ← Codex
```

`codex/bootstrap`은 `23576fd`(docs 커밋)에 있고, 그 뒤 Claude Code가 3개 커밋을 더했다:

```
6c9cb6e  fms: stop the SMS flood — and stop a disabled route from sending anyway
a4485a1  s1: collect the rest of the room — PDU, NetBotz, network and CRAC
360011e  s1: find out what the collectors were actually doing, and make them say it
23576fd  docs: include supplied competitive baseline and device integration guide   ← codex/bootstrap
```

**Codex는 `feat/twin-rack-elevation`(또는 그 이후)에서 rebase하거나 분기하는 것이 맞다.** `23576fd` 기준으로 작업하면 S1 수집기·프로브 헬스 작업과 충돌한다.

### 1.2 다른 브랜치

`checkpoint/handoff-2026-10-11`, `checkpoint/source-2026-10-11`(10-11 고정), `ci/deploy-twin`, `feat/fms-twin-nav-link`, `feat/twin-3d-app`, `feat/twin-v3-ledger`, `fix/alarmmap-basemap-keyless`(미머지), `main`.

---

## 2. 코드 경로와 실행 방법

### 2.1 전체 구조

| 디렉터리 | 역할 | 파일 수 | 독립 실행 |
|---|---|---|---|
| `backend/` | FMS API 라우트·서비스·마이그레이션 | 50 | **불가** (§2.3) |
| `apps/twin/` | `/twin` 3D·운영 콘솔 (Vite 8 + React 19) | 636 | **가능** |
| `probe-agent/` | Node 수집기 (현장 설치용, 운영 중) | 27 | 가능 (의존성 설치 필요) |
| `probe/` | Python 수집기 (Phase 0/1 별개 구현) | 22 | 가능 (pytest 필요) |
| `deploy/` | 배포 스크립트·패치·auto-recovery | 25 | — |
| `nginx/` | vhost 설정 (현 Azure 기준) | 5 | — |
| `frontend/` | 1.x 잔존 (FMS 페이지 1개 + 지도 데이터) | 9 | — |
| `cflex-shell/`, `sentinel-api/`, `ringonservice-net/`, `reference/` | HAEA 범위 외 | 32 | — |

### 2.2 Collector — `probe-agent/`

```
probe-agent/
├── src/index.js                 폴링 루프 (bounded concurrency), 하트비트, 부트스트랩
├── src/config.js                env 로딩 (CFLEX_URL, POLL_INTERVAL_MS, POLL_CONCURRENCY, SNMP_*)
├── src/forwarder.js             App으로 전송 (axios), 장비/객체 인벤토리 pull
├── src/buffer.js                store-and-forward 큐 (better-sqlite3)
├── src/pollers/index.js         kind → collector 라우팅 레지스트리
├── src/pollers/{ups,pdu,netbotz,network,crac}.js
├── src/services/snmp-helpers.js  세션 생성 (v1/v2c/v3 authPriv), UPS OID 프로파일 2종
├── src/services/snmp-read.js     get / walkTable (부분 응답 허용)
├── src/services/oid-catalog.js   OID 카탈로그 — 스케일·확신도 명시
├── src/services/ups-metrics.js   UPS 지표 fetch
├── src/services/ups-probe-engine.js
├── sim/{lib,sim-pdu,sim-netbotz,sim-crac,sim-switch}.js   SNMP 시뮬레이터 (개발 전용)
├── test/{cycle,collectors}.test.js
├── systemd/cflex-probe.service   하드닝 포함 (NoNewPrivileges, ProtectSystem=strict)
└── install.sh
```

실행:

```sh
cd probe-agent
npm install                       # 또는 npm ci (lock 파일은 .gitignore 되어 있지 않음 — 확인 필요)
cp .env.example .env              # ※ .env.example 없음 — README 참조해 수동 작성
node src/index.js
```

필요 env (값은 적지 않는다): `CFLEX_URL`, `CFLEX_TOKEN`, `TENANT_ID`, `PROBE_ID`, `POLL_INTERVAL_MS`(기본 60000), `POLL_CONCURRENCY`(기본 12), `HEARTBEAT_INTERVAL_MS`(기본 30000), `SNMP_VERSION`/`SNMP_COMMUNITY`/`SNMP_TIMEOUT_MS`/`SNMP_RETRIES`, `BUFFER_DB_PATH`, `LOCAL_API_PORT`.

시뮬레이터로 하드웨어 없이 검증:

```sh
SNMP_PORT=16401 PDU_TYPE=switched LOAD_A=6.1,7.4,5.2 node sim/sim-pdu.js
SNMP_PORT=16501 node sim/sim-netbotz.js
SNMP_PORT=16601 COOLING=standby ALARMS=1 node sim/sim-crac.js
SNMP_PORT=16701 PORTS=48 DOWN=2 SHUT=1 TEMP_C=42 node sim/sim-switch.js
```

각 시뮬레이터는 **서비스하는 진짜 값을 평문 십진수로 출력**한다. 수집기가 스케일을 틀리면 그 숫자와 불일치한다.

### 2.3 Application — `backend/` (⚠ 독립 실행 불가)

`backend/`는 **라이브러리·라우트·마이그레이션만 있는 패치셋**이다. 다음이 **없다**:

- `package.json` / 의존성 선언
- 서버 부트스트랩 (`app.listen`, express 앱 구성)
- DB 커넥션 모듈 (`src/config/database`)
- **인증 미들웨어** — 저장소 전체에 `*auth*` 파일이 0건

`backend/` 코드는 `require('../config/database')`, `req.user` 등으로 **cflex-v2 베이스(`/opt/cflex-v2/cflex-api`)를 전제**한다. 즉 지금 저장소만으로는 API를 띄울 수 없다.

→ **RHEL 번들을 만들려면 이 베이스를 저장소로 들여오는 작업이 선행된다.** §9-A1.

구성:

```
backend/
├── routes/      fms.routes.js(48), incidents.routes.js(13), probe.routes.js(12),
│                fms-push.routes.js(3), fms-ack.routes.js(2), integrations-slack.routes.js(2)
├── services/    21개 — alarm-notifier, fms-metrics, fms-probe-health, fms-incident,
│                fms-triage, fms-reeval, fms-rca, fms-copilot, fms-topology,
│                fms-derive-status, fms-device-control, fms-pdf-gen,
│                fms-report-{scheduler,mailer}, cflex-alert, expo-push-notifier …
├── incident/    state_machine.js (+ README, test)
├── migrations/  001~008 + 0010 + apply.js
├── seed/        KMX 원장 빌더·임포터·데모 시나리오
└── triage/      rules.json
```

### 2.4 Twin / 로컬 대시보드 — `apps/twin/`

**지금 저장소에서 유일하게 독립 실행되는 UI.** 오프라인 mock으로 백엔드 없이 뜬다.

```sh
cd apps/twin
npm ci
node mock/server.js          # 터미널 1 — mock API :3001
npm run dev                  # 터미널 2 — http://localhost:5174/twin/
```

검증: `npm test` · `npm run build` · `npm run lint`. 의존성 5개 (react, react-dom, three, maplibre-gl, lucide-react) — **네이티브 모듈 없음**.

### 2.5 Database

**현재: SQLite 단일 파일.** PostgreSQL 코드는 저장소에 0건이다.

- 드라이버: `better-sqlite3`(운영), `node:sqlite`(테스트 폴백)
- 운영 파일: `/opt/cflex-v2/cflex-api/data/cflex.db` (저장소 외부)
- 마이그레이션 실행: `node backend/migrations/apply.js --db <path> [--only 007]`
  - 멱등. `duplicate column name`만 삼키고 나머지 오류는 중단.
  - `statements()`를 export하므로 테스트에서 같은 분할기를 재사용한다.

### 2.6 외부 포털 연동

**현재 구현**: `probe-agent/src/forwarder.js` → `axios` → `cfg.cflexUrl` (기본 `https://cflex.runless.co.uk`), 인증은 **bearer 토큰 1개**(`CFLEX_TOKEN`).

**스펙 요구**: `https://cflex.fms.support` (40.114.79.164 static), **mTLS 장치 인증서**, HTTPS 프록시 경유, IP 핀.

→ 호스트명·인증방식·프록시 모두 다르다. §9-A4.

### 2.7 배포 스크립트 (현 Azure 기준 — RHEL 아님)

| 파일 | 하는 일 |
|---|---|
| `deploy/deploy-twin.sh` | twin 빌드 → rsync → nginx 검사·reload |
| `deploy/deploy-fms-backend.sh` | 서비스·라우트·마이그레이션 복사, 004 적용, KMX 임포트, pm2 재시작 |
| `deploy/s1/patch-probe-health.js` | 마커 가드 멱등 패치 — 하트비트/스윕/라우트 |
| `deploy/s1/patch-collectors.js` | 마커 가드 멱등 패치 — 객체 피드/메트릭 수신/조회 라우트 |
| `deploy/s1/snmp-reach.js` | SNMP 도달성 조사 → CSV + `snmp_reach` 테이블 |
| `deploy/auto-recovery/` | healthcheck timer·boot recover (8/24 사고의 당사자 — §8.3) |

**전부 pm2 + Azure Ubuntu 전제다.** RHEL systemd·오프라인 번들용 설치기는 없다. §9-A2.

---

## 3. 기능 구분 — 구현 완료 / 시연용 / 미구현

### 3.1 실제 구현 완료 (테스트 또는 라이브 검증됨)

| 기능 | 위치 | 검증 근거 |
|---|---|---|
| UPS SNMP 폴링 (v1/v2c/v3 authPriv) | `probe-agent/src/services/snmp-helpers.js`, `ups-metrics.js` | 운영 중 — **41대**(= Exhibit 1 중 IP 기재분) 폴링, 전부 타임아웃. 경로 없음(§9-C2) |
| 폴링 동시성 (직렬 → bounded) | `probe-agent/src/index.js` | 420s → 44s 실측 |
| 수집 성공/실패 정직 보고 | `probe-agent/src/pollers/ups.js` | `0 ok, 41 fail` (이전 `41 ok, 0 fail` 거짓보고 수정) |
| store-and-forward 큐 | `probe-agent/src/buffer.js` | SQLite enqueue/dequeue/ack/fail/purgeOld |
| PDU·NetBotz·네트워크·CRAC 수집 | `probe-agent/src/pollers/*.js` | **실 SNMP 23/23 검증** (시뮬레이터 대상) |
| OID 스케일·확신도 관리 | `probe-agent/src/services/oid-catalog.js` | 12 테스트 |
| 메트릭 저장 + 출처(provenance) | `backend/services/fms-metrics.js` | 10 테스트 |
| 프로브 헬스·10분 무신호 → P2 인시던트 | `backend/services/fms-probe-health.js` | 8 테스트, 라이브 |
| 인시던트 상태머신 | `backend/incident/state_machine.js` | 14 테스트 |
| 알람 트리아지·재평가 | `backend/services/fms-triage.js`, `fms-reeval.js` | 17 + 4 테스트 |
| 신선도 게이트 (5분) | `backend/services/fms-derive-status.js` | 16 테스트 |
| 알림 채널 9종 | `backend/services/alarm-notifier.js` | Slack 라이브, 나머지 enabled=0 |
| Twin 콘솔 (3D·인벤토리·용량) | `apps/twin/` | 11 게이트 |
| 용량 계획 (체인·N+1 냉방·증설 시뮬) | `apps/twin/src/twin/roomCapacity.js` | 포함 |

### 3.2 시연용 / 부분 구현 (실데이터 아님, 또는 한쪽만)

| 기능 | 상태 |
|---|---|
| **KMX CCR 원장·데모 시나리오** | `backend/seed/kmx_*`, `apps/twin/src/demo/kmx_ccr_topology.json` — 합성 데이터. 자기일관성은 맞췄으나 실측 아님 |
| **PDU/NetBotz/CRAC 실측** | 수집기는 검증됐으나 **실 장비 수집 0건** — 시뮬레이터에서만 흘렀다 |
| **월간 Executive Report** | `fms-pdf-gen.js`(18 KB), `fms-report-{scheduler,mailer}.js` 존재. 실데이터 발행 이력 없음 |
| **AI 코파일럿·RCA** | `fms-copilot.js`(12 테스트), `fms-rca.js` — 외부 LLM 의존, HAEA 오프라인 환경에서 동작 불가 |
| **ServiceNow eBonding** | `alarm-notifier.js`의 `dispatchServiceNow` 디스패처만. 인시던트 매핑·중복방지·테스트 티켓 기능 없음 |
| **Teams 알림** | `dispatchTeams` 구현됨. 라우트 행 자체가 없어 미사용. 프록시 경유 미지원 |
| **SNMP 도달성 조사** | `deploy/s1/snmp-reach.js` — 동작. 당시 등록 장비 **48대 전부** `no-route` (HMA 28 + KUS 7 + HQ 6 + KMX 5 + 테스트 2 — **Q3 실사 48대와 다른 집합**, 숫자만 같다) |

### 3.3 미구현 (저장소에 코드 0건)

| 기능 | 스펙 |
|---|---|
| **PostgreSQL 16** (파티셔닝·보존·백업) | §3.3 |
| **오프라인 설치 번들** (`cflex-fms-2.x-rhel8-offline.tar.gz`, SHA256SUMS, SBOM) | §5.1 |
| **`cflex-install`** (preflight / verify / netcheck / upgrade / rollback) | §5.2–5.3 |
| **SNMP trap 리스너 (UDP 162)** | §3.1 — 저장소 전체 검색 결과 0건 |
| **mTLS 포털 포워더** (`cflex-forwarder`) | §3.4 |
| **App Active/Standby** (Redis 세션·무상태화·페일오버) | §3.2, §8 |
| **SAML 2.0 SSO** | §3.2, §4.6 — `saml` 문자열 0건 |
| **Exhibit 1 XLSX 임포트** | §4.1 — `bulk-import`는 JSON rows만 |
| **배터리 EOL 90일 알림** | §4.2 — 규칙 없음. `batteryReplace` OID는 읽지만 설치일·수명 계산 없음 |
| **NMC 자동 탐지·시리얼 불일치 경고** | §4.1 |
| **APC 시리얼 YYWW → 제조일 추정** | §4.1 |
| **라이프사이클/예산 예측 내보내기** | §4.3 |
| **유지보수 모드 (PM 억제)** | §4.2 — `fms_alarm_mutes`는 장비 단위 음소거뿐 |
| **SELinux 정책 모듈 (.pp)** | §5.2 |
| **감사로그 append-only** | §7 |
| **비밀정보 암호화 저장 (마스터 키)** | §4.6 — 현재 `.env` 평문 |

---

## 4. API 계약

### 4.1 마운트 구조 (cflex-v2 베이스, `src/server.js`)

```
/v1/fms/*        verifyToken 통과 필수 (JWT)
/v1/probe/*      X-Probe-Key 헤더가 있으면 통과, 없으면 JWT (관리 엔드포인트)
/v1/incidents/*  verifyToken
```

⚠ `verifyToken`이 **라우팅보다 먼저** 돈다. 따라서 **없는 경로도 401을 반환**한다 — 401은 엔드포인트가 마운트됐다는 증거가 아니다.

### 4.2 `/v1/fms/*` (48 + S1 패치 3)

인벤토리·자산: `GET /summary` `/fleet-live` `/floor` `/sites-map` `/assets` `/assets/:id` `/devices` `/devices/:id` · `PUT /assets/:id` · `PATCH /devices/:id` · `POST /assets/bulk-import`

알람·티켓: `GET /alerts` `/tickets` `/tickets/:id` `/alerts/:id/ticket` · `POST /tickets/from-alert` `/tickets/:id/rca` · `POST /devices/:id/mute` `/unmute` · `GET /mutes` · `DELETE /mutes/:id`

임계치: `GET|PUT /assets/:id/thresholds`

토폴로지·전원체인: `GET /topology` `/topology/heat` `/topology/export` `/power-chain/:deviceId` `/power-chain/object/:objectId` · `POST /topology/import`

라우팅·채널: `GET|POST /routes` · `PUT|DELETE /routes/:id` · `POST /routes/:id/test` `/routes/simulate` · `GET /channels/health`

제어: `GET /control/actions` `/control/log` `/control/config` · `PUT /control/config` · `POST /devices/:id/action`

리포트: `GET /reports/monthly` `/reports/monthly/pdf` `/reports/monthly/history` · `POST /reports/monthly/send`

기타: `POST /copilot` · `POST /demo/kmx/start` `/demo/kmx/reset`

**S1 패치로 추가 (커밋된 `fms.routes.js`에는 없고 `deploy/s1/*.js`가 주입)**: `GET /probes` `/object/:name` `/devices/:id/metrics`

### 4.3 `/v1/probe/*` (Collector ↔ App)

`POST /heartbeat` · `GET /jobs/next` · `POST /jobs/:jobUuid/result` `/progress` · `POST /event` · `GET /devices` · 관리: `GET /list` `POST /create` `POST /:id/{disable,enable}` `DELETE /:id` `GET /:id/jobs`

**S1 패치 추가**: `GET /objects` (비-UPS 인벤토리 피드)

`POST /event`의 `kind`: `telemetry` | `alert` | `metrics`(S1 신규) | 기타는 조용히 수락.

### 4.4 `/v1/incidents/*` (13)

`GET /` `/:id` `/:id/timeline` `/:id/workbench` `/:id/verify` · `POST /:id/state` `/:id/triage/rerun` `/:id/triage/feedback` `/:id/action` `/:id/dispatch` `/:id/rca/draft` `/:id/comment` · `PATCH /:id/dispatch/:did`

---

## 5. DB 스키마·마이그레이션

### 5.1 마이그레이션

| 파일 | 내용 |
|---|---|
| `001_fms_schema.sql` | 기반: `fms_rooms` `fms_alarm_routes` `fms_alarm_dispatch_log` `fms_alarm_mutes` `fms_oncall` `fms_report_log` `fms_control_*` `fms_insights` `fms_ai_log` 등 |
| `002_fms_push_subscriptions.sql` | Expo 푸시 구독 |
| `003_alerts_ack.sql` | `alerts.acked_at` / `acked_by` |
| `004_fms_topology.sql` | `fms_rooms` 확장, `fms_racks`(=**모든 룸 객체**), `fms_devices`, `fms_power_links`, `ups_devices.{rack_id,u_pos,u_height}` |
| `005_fms_s2_workbench.sql` | 인시던트 워크벤치: `incident_alarm_links`, `fms_dispatch`, `fms_triage_feedback`, `alerts.{simulated,object_id}` |
| `006_dispatch_log_tenant.sql` | `fms_alarm_dispatch_log.tenant_id` + 경로 기반 백필 |
| `007_s1_data_provenance.sql` | `probe_status`, `fms_metrics`, `snmp_reach`, `fms_devices` 계획값/SNMP 컬럼, `fms_rooms` 전압, **`ups_devices.last_ok_polled`** |
| `008_s1_metric_provenance.sql` | `fms_metrics.{raw_value,oid,confidence,label,notes}`, `fms_racks` 폴링 컬럼, `fms_devices.{protocol,pdu_type,probe_id}` |
| `0010_incidents_layer.sql` | `cflex_tickets` 계열 — **별도 Postgres 모노레포용. SQLite 운영 DB에 미적용** |

### 5.2 알아야 할 함정

1. **`fms_racks`에 랙만 있는 게 아니다.** CRAC·PDU 캐비넷·분전반·센서·누수존 전부 `kind` 컬럼으로 구분해 들어있다. 테이블명이 004 당시 잔재다.
2. **`last_polled`는 실패해도 갱신된다.** 시도 시각이지 수집 시각이 아니다. "5분 내 신선"은 **`last_ok_polled`로만** 답할 수 있다 (007에서 추가).
3. **`fms_metrics.raw_value`는 스케일 보정용이다.** 원시 정수를 보관하므로 잘못된 스케일을 `fms-metrics.rescale()`로 제자리 수정할 수 있다. 버리고 재수집하지 않는다.
4. **마이그레이션은 SQLite 전용 문법**이다 (`AUTOINCREMENT`, `PRAGMA`). 6개 파일이 해당. PostgreSQL 전환 시 전부 재작성 대상.
5. `apply.js`는 `;`로 분할하고 `BEGIN;`/`CREATE TRIGGER`가 보이면 거부한다. 주석 안의 `;`도 과거에 사고를 냈다 (현재는 인용부호 없는 줄의 trailing 주석을 제거해 회피).

### 5.3 보존

| 데이터 | 현재 | 스펙 §3.3 |
|---|---|---|
| `ups_metrics` | **7일** (`ups-poller.js` 시간당 prune) | raw 3년 |
| `fms_metrics` | **30일** (`FMS_METRICS_KEEP_DAYS`) | raw 3년 |
| 집계 테이블 | **없음** | 시간/일 집계 10년 |
| 알람·감사 | 무제한 | 10년 |

→ 7일 보존 때문에 8월 이전 이력이 남아있지 않다. §8.2 참조.

---

## 6. 인증 구조

### 6.1 사용자 (JWT)

- 미들웨어: `auth.middleware.js` — **cflex-v2 베이스에 있고 이 저장소에 없다.**
- 흐름: `Authorization: Bearer <jwt>` → `jwt.verify(token, JWT_SECRET)` → payload의 `userId`(정수) 또는 `email`로 `users` 조회 → `is_active` 확인 → `req.user = { userId, tenantId, role, email }`
- 시크릿: `src/config/constants` (env override) — **env에만 있지 않다.** 번들화 시 정리 필요.
- 테넌트 스코프: `tenantOf(req)` — `admin`/`super_admin`은 `?tenant_id=`로 교차 조회 가능, 그 외는 자기 테넌트 고정.

### 6.2 역할

저장소 코드가 실제로 분기하는 값: `super_admin`(9회) · `admin`(9) · `fms_admin`(3) · `si_operator`(1) · `engineer`(1).

스펙 §4.6은 **Admin / Operator / Viewer 3종**을 요구한다. 현재 역할 체계와 이름·수가 다르다. 매핑 설계 필요.

### 6.3 Collector (X-Probe-Key)

`probes` 테이블의 `api_key_prefix`(앞 8자)로 후보를 좁히고 `bcrypt.compare`로 검증 → `req.probe = {id, probe_uuid, tenant_id, label, status}`. `status='disabled'`면 거부.

### 6.4 비밀정보

현재 전부 `.env` 평문 (`JWT_SECRET`, `CFLEX_ALERT_TOKEN`, SNMP community, SMTP/Slack/Teams 자격). 스펙 §4.6은 0600 + 암호화 저장 + systemd credential을 요구한다. 미구현.

---

## 7. SNMP · 재전송 큐 · 알람 · 알림 채널 구현 위치

### 7.1 SNMP

| 항목 | 위치 |
|---|---|
| 세션 생성 (v1/v2c/v3 authPriv) | `probe-agent/src/services/snmp-helpers.js:createSession` |
| get / walkTable (부분 응답 허용) | `probe-agent/src/services/snmp-read.js` |
| OID 카탈로그 (스케일·확신도·note) | `probe-agent/src/services/oid-catalog.js` |
| UPS 프로파일 — 표준 RFC 1628 | `snmp-helpers.js:OID_UPS_MIB` (12 OID) |
| UPS 프로파일 — APC PowerNet | `snmp-helpers.js:OID_APC_POWERNET` (13 OID) |
| 프로파일 선택 | `snmp-helpers.js:selectOidProfile` / `isApcVendor` |
| 도달성 조사 | `deploy/s1/snmp-reach.js` |
| **trap 리스너 (UDP 162)** | **없음** |

현재 UPS 수집 항목 (APC 프로파일): 제조사·모델·펌웨어, 배터리 상태/런타임/용량%/온도/교체표시, 배터리 사용시간, 입력전압, 출력상태/전압/부하%.

**스펙 §3.1 대비 누락**: 입·출력 **전류**, **주파수**, **kVA/kW**, 배터리 **설치일·교체권장일**, **셀프테스트 결과·일시**, **알람 상태 비트**, **내부 온도**, **시리얼**. Modular Ultra(SRYLF)·Symmetra LX(SYAF) 계열 OID 차이 흡수도 없다.

### 7.2 재전송 큐 (store-and-forward)

`probe-agent/src/buffer.js` — better-sqlite3 로컬 큐. `enqueue` / `dequeue` / `ack` / `fail` / `purgeOld` / `stats`. `BUFFER_RETENTION_DAYS` 기본 7일 (스펙과 일치). `forwarder.drain()`이 30초마다 비운다.

**미검증**: 순서 보장, 중복 제거 키(장비ID+timestamp), 40 GB 디스크 상한. 스펙 §3.1이 요구하는 무손실 검증(SAT #5)은 수행하지 않았다.

### 7.3 알람

| 단계 | 위치 |
|---|---|
| 임계 평가 (수집기측) | `probe-agent/src/pollers/ups.js:evaluateAlerts` — P1/P2 기본 임계 8종 |
| 도달불가 알람 + 백오프 | `probe-agent/src/pollers/ups.js` — 전이 1회 → 1h → 2 → 4 → 8 → 16 → 24h 상한 |
| 알람 수신·중복제거 | `backend/routes/probe.routes.js:POST /event` (`kind='alert'`, 10분/장비+메트릭+우선순위) |
| 인시던트 생성·dedup | `backend/services/fms-incident.js:ensureIncidentForAlert` (`assetType`별 dedup 공간 분리) |
| 상태머신 | `backend/incident/state_machine.js` — open→ack→in_progress→resolved→closed |
| 자동 트리아지 | `backend/services/fms-triage.js` + `backend/triage/rules.json` |
| 재평가·플래핑 | `backend/services/fms-reeval.js` |
| 음소거 | `fms_alarm_mutes` + `alarm-notifier.js:isMuted` |
| 프로브 다운 (10분) | `backend/services/fms-probe-health.js:sweep` |
| 신선도 게이트 (5분) | `backend/services/fms-derive-status.js` |

### 7.4 알림 채널

`backend/services/alarm-notifier.js` — 디스패처 9종: `line` `sms` `teams` `email` `slack` `discord` `pagerduty` `servicenow` `webhook`. 라우팅은 `fms_alarm_routes`(tenant, channel, min_priority, target, enabled, escalate_after_min, escalate_to), 발송 기록은 `fms_alarm_dispatch_log`.

별도 SMS 경로: `backend/services/cflex-alert.js` → 외부 게이트웨이 (`site|category` 10분 쿨다운). **2026-10-12 기준 일시중단 상태** — 라우트 `enabled=0`을 무시하고 발송하던 결함을 고치고, 게이트웨이 토큰도 주석 처리했다 (커밋 `6c9cb6e`).

푸시: `backend/services/expo-push-notifier.js` (모바일 앱용, HAEA 범위 외).

---

## 8. RHEL 8.10 · Node 20 호환성과 현재 테스트 결과

### 8.1 호환성 평가

| 항목 | 현재 | RHEL 8.10 / Node 20 |
|---|---|---|
| 개발 Node | **v22.22.2** (npm 10.9.7) | 타깃은 **nodejs:20** AppStream |
| `probe-agent` engines | `{"node": ">=20"}` | ✅ |
| `apps/twin` engines | **선언 없음** | Vite 8 + React 19 — Node 20에서 동작하나 **검증 안 됨** |
| `node:sqlite` | Node 22 전용 (테스트 폴백) | **Node 20에 없음** — 테스트 하네스가 RHEL에서 깨진다 |
| 네이티브 모듈 | `better-sqlite3`(prebuild 필요) · `bcryptjs`(순수 JS) · `net-snmp`(순수 JS) · `axios`·`express`·`dotenv`(순수 JS) | **better-sqlite3만 RHEL 8 glibc 사전 컴파일 필요** |
| DB | SQLite | **PostgreSQL 16 요구** → better-sqlite3 자체가 사라질 수도 있다 |
| 프로세스 관리 | pm2 | **systemd** (`probe-agent/systemd/` 1개만 존재) |
| SELinux | 미고려 | Enforcing 전제, 정책 모듈 필요 |
| 서드파티 저장소 | npm 직접 설치 | **금지** — 오프라인 번들 |

**결론**: `probe-agent`는 Node 20에서 바로 동작할 가능성이 높다 (engines 선언 + 순수 JS 의존성 + better-sqlite3 prebuild만 해결). `backend`는 베이스가 저장소에 없어 평가 자체가 불가능하다. `apps/twin`은 빌드 산출물만 nginx로 서비스하면 되므로 런타임 Node 버전 문제가 없다 (빌드는 우리 쪽에서 수행).

**Node 20 검증은 수행하지 않았다.** 로컬이 22이고, nvm 등으로 20을 설치해 재실행하는 작업은 이 문서 범위에 넣지 않았다. §9-B1.

### 8.2 실행한 테스트와 결과 (2026-10-22, Node v22.22.2, macOS)

백엔드 순수 로직 (`node <file>`, 외부 의존성 없음):

| 파일 | 결과 |
|---|---|
| `backend/incident/state_machine.test.js` | **14 pass / 0 fail** |
| `backend/services/fms-derive-status.test.js` | **16 pass / 0 fail** |
| `backend/services/fms-triage.test.js` | **17 pass / 0 fail** |
| `backend/services/fms-reeval.test.js` | **4 pass / 0 fail** |
| `backend/seed/kmx_demo_scenario.test.js` | **6 pass / 0 fail** |
| `backend/services/fms-probe-health.test.js` | **8 ok** (자체 하네스) |
| `backend/services/fms-metrics.test.js` | **10 ok** (자체 하네스) |
| `backend/services/fms-topology.test.js` | **31 passed** |
| `backend/services/fms-copilot.test.js` | **12 passed** |

수집기:

| 파일 | 결과 |
|---|---|
| `probe-agent/test/cycle.test.js` | **6 ok** — 거짓 성공 보고, 동시성, 백오프, 하트비트 |
| `probe-agent/test/collectors.test.js` | **12 ok** — 스케일·행 선별 (PDU 10분의1 A, ENTITY-SENSOR 지수·정밀도, IF-MIB 물리포트) |

Twin:

```
npm test   → 11 게이트 통과 / 0 실패
npm run build → ✓ built in 325ms
npm run lint  → 오류 0, 경고 3 (TwinScreen.jsx react-hooks/exhaustive-deps)
```

Python 수집기: **실행 못 함** — `pytest` 미설치 (`No module named pytest`). `probe/tests/`에 3개 파일 존재.

실 SNMP 통합 검증 (2026-10-11, Azure 개발 VM + 시뮬레이터): **23/23 통과**, 전 경로 (probe → `/v1/probe/event` → `fms_metrics` → `/v1/fms/object/:name`). RHEL에서는 재수행 필요.

### 8.3 운영 환경에서 알아야 할 사고 2건

1. **2026-08-24 ~ 10-09, 프로덕션 API 40,103회 재시작.** `deploy/auto-recovery/healthcheck.sh`의 복구 동작이 dev 환경 502에 반응해 **프로덕션** pm2를 재시작하도록 설정돼 있었다. 그 6주간 폴러가 한 주기도 끝내지 못했다. 패치됨. **RHEL 번들에 이 스크립트를 그대로 가져가면 안 된다.**
2. **수집기가 6주간 "41 ok, 0 fail"로 거짓 보고.** `pollDevice()`가 성공·실패 모두 `undefined`를 반환해 호출부가 "호출이 돌아옴"을 성공으로 셌다. 수정됨 (`360011e`).

관련 진단 문서: `docs/s1_data_diagnosis.md`, `docs/snmp_reach_2026-10-11.csv`.

---

## 9. 설계 스펙 대비 차이 (= 작업 목록)

### A. 구조적 차이 — 선행 작업

| # | 항목 | 현재 | 스펙 | 비고 |
|---|---|---|---|---|
| **A1** | **App 베이스 부재** | `backend/`는 패치셋. package.json·부트스트랩·DB config·인증 미들웨어 없음 | 번들에 앱 전체 포함 (§5.1 `app/`) | **최우선.** 이게 없으면 번들을 만들 수 없다 |
| **A2** | **설치기·번들 없음** | pm2 + rsync 스크립트 | 오프라인 tar.gz + SHA256SUMS + SBOM + `cflex-install` (preflight/verify/netcheck/upgrade/rollback) | §5 전체 |
| **A3** | **DB 엔진** | SQLite 단일 파일 | PostgreSQL 16, 월 네이티브 파티션, 보존 3년/10년, pg_basebackup+WAL | 마이그레이션 6개 SQLite 전용 문법 |
| **A4** | **포털 전송** | `cflex.runless.co.uk`, bearer 토큰 | `cflex.fms.support` (40.114.79.164), **mTLS 장치 인증서**, 프록시 경유, IP 핀 | §3.4 |
| **A5** | **Active/Standby** | 단일 노드, 상태 보유 | 무상태 + Redis 6 세션/큐, app01↔app02 | §3.2, §8 |
| **A6** | **프로세스 관리** | pm2 | systemd 6유닛 + 하드닝 + SELinux .pp | §5.2 |

### B. 기능 차이

| # | 항목 | 비고 |
|---|---|---|
| **B1** | **Node 20 검증** | 로컬 22. `node:sqlite` 폴백이 20에서 깨진다 |
| **B2** | **SNMP trap 리스너 (UDP 162)** | 코드 0건. 방화벽 룰 A에 포함돼 있다 |
| **B3** | **UPS 수집 항목 확장** | 전류·주파수·kVA/kW·배터리 설치일/교체권장일·셀프테스트·알람비트·내부온도·시리얼. SRYLF/SYAF OID 차이 흡수 |
| **B4** | **배터리 EOL 90일** | 규칙 없음. `batteryReplace` 표시만 읽는다 |
| **B5** | **Exhibit 1 XLSX 임포트** | 현재 JSON rows만. 시리얼 불일치 경고·프레임/MIM 2중 시리얼 없음 |
| **B6** | **NMC 자동 탐지·제조일 추정** | 없음 (APC 시리얼 YYWW) |
| **B7** | **ServiceNow eBonding** | 디스패처만. 우선순위 매핑·INC 번호 연결·테스트 티켓 없음 (**SOW 수락 기준**) |
| **B8** | **Teams 프록시 경유** | 디스패처는 있으나 프록시 미지원, 라우트 행 없음 |
| **B9** | **SAML SSO 준비** | 0건 |
| **B10** | **역할 3종 (Admin/Operator/Viewer)** | 현재 5종, 이름 다름 |
| **B11** | **유지보수 모드** | 장비 음소거만. 사이트·기간 단위 PM 억제 없음 |
| **B12** | **라이프사이클/예산 예측 내보내기** | 없음 |
| **B13** | **감사로그 append-only** | 없음 |
| **B14** | **비밀정보 암호화 저장** | `.env` 평문 |
| **B15** | **AI 코파일럿/RCA** | 외부 LLM 의존 → **오프라인 HAEA에서 동작 불가.** 비활성화 또는 제외 결정 필요 |
| **B16** | **용량 목표 검증** | 500 UPS / 50 사이트 / 10초 폴링 산정표 없음 (§4.5) |

### D. v1.1 추가분 — 3D 평면도(§4.4) · 상용 제품화(§14)

v1.0에는 없던 요구다. **`apps/twin/`이 범위 외가 아니라 필수 기능이 됐다.**

#### D-1. 3D 평면도 뷰 (§4.4) — 기존 구현 이식

| 요구 | 현재 `apps/twin/` | 차이 |
|---|---|---|
| 브라우저 WebGL | Three.js 0.169 (`src/twin/LedgerScene.js`) | ✅ 스택 일치. §13-9 "개발팀이 기재" 항목 = **Three.js 0.169 + React 19 + Vite 8**. 런타임 의존성 5개 라이선스: react·react-dom·three MIT, maplibre-gl **BSD-3-Clause**, lucide-react **ISC** — 전부 재배포 가능, SBOM 기재 필요 |
| **CDN·외부 URL 호출 0건** | ❌ **3곳 위반** (아래) | **SAT #11 즉시 실패** |
| 모델 포맷 GLB/glTF + Draco | ❌ **로더 없음.** 절차적 three.js 지오메트리 (타일 격자 + 박스 + 장비 사진 텍스처) | 로더·업로드·메타데이터 테이블 전부 신규 |
| Admin 모델 업로드 | ❌ 없음 | 신규 |
| 좌표 `(site, floor, x, y, z, rotation)` | `(col, row, w, d, face)` — 600 mm 타일 격자, **층(floor) 개념 없음** | 변환 + floor 계층 추가 |
| Admin 드래그 배치 편집기 | ❌ 없음. 좌표는 원장 JSON 수동 편집 | 신규 |
| Location 문자열 → 층/구역 초기 매핑 | ❌ 없음 | 신규 |
| 미배치 목록 | ✅ `#/devices` 트리와 랙 실장도에 있음 (`U 위치 미지정`) | 층 단위로 확장 |
| 마커 색상 = 알람 등급, 통신단절 회색 점멸 | ✅ 색상 있음 / ❌ 점멸 없음 | 부분 |
| 클릭 → 상세 패널 (현재값·트렌드·알람·배터리 교체·PM) | ✅ 상세·트렌드·알람 / ❌ 배터리 교체 예정·PM 리포트 | 부분 |
| 알람 시 해당 층 자동 포커스 | ❌ 객체 단위 `focus(name)`·`rackView(name)`은 있음. 층 개념이 없어 "층 포커스" 불가 | 부분 |
| WebSocket/SSE | ❌ **30초 폴링** (`/v1/fms/alerts` 등) | 신규 또는 요구 완화 |
| 2D 평면도 폴백 (저사양 PC) | ❌ `'top'` 카메라 프리셋은 WebGL 안에 있다. **WebGL이 없으면 아무것도 안 뜬다** | 신규 (같은 좌표의 2D 투영) |
| 모바일/태블릿 터치 | ⚠ OrbitControls 기본 터치만. 미검증 | 검증 필요 |
| 포털로 모델·좌표 동기 | ❌ 없음 | 신규 |
| 모델 파일 로그인 사용자만 (nginx auth_request) | ❌ `/twin/` 정적 서빙, 인증 없음 | 신규 |
| 민감 레이어 비공개 | ❌ 없음 | 신규 |

**외부 URL 호출 3건 (오프라인 환경에서 깨지는 지점)**

| 위치 | 호출 | 오프라인 결과 |
|---|---|---|
| `apps/twin/index.html:8-9` | `fonts.googleapis.com` (IBM Plex Sans KR) | 폰트 fallback — 화면은 뜨지만 타이포 깨짐 |
| `apps/twin/src/MapScreen.jsx:17` | `tiles.openfreemap.org` (maplibre 타일) | **`#/map` 알람 지도 화면 전체 백지** |
| `apps/twin/src/MapScreen.jsx:55` | `openfreemap.org`, `openstreetmap.org` (attribution 링크) | 링크만 죽음 |

→ 폰트는 번들에 포함, 지도는 **타일을 번들에 넣거나 `#/map`을 온프레 에디션에서 제외**해야 한다. `frontend/public/us-{states,counties}-10m.json`(주·카운티 경계)이 이미 있어 오프라인 벡터 지도로 대체하는 길이 있다.

미머지 브랜치 `fix/alarmmap-basemap-keyless`(`3edf0e1`, *replace CARTO basemap with keyless OpenFreeMap positron*)는 **HEAD의 조상이 아니다** — 그런데 HEAD의 `MapScreen.jsx`는 이미 OpenFreeMap을 쓴다. 즉 같은 변경이 다른 경로로 들어왔고, 그 브랜치는 HEAD보다 29,000줄 뒤처진 옛 상태다. **머지 대상이 아니라 정리 대상이다.**

#### D-2. 상용 제품화 (§14) — 12개 요구 대비

| # | 요구 | 현재 |
|---|---|---|
| 1 | 에디션 구조 (Cloud / On-Prem / Collector 어플라이언스) | ❌ 단일 배포. 에디션 개념·빌드 분기 없음 |
| 2 | OS 매트릭스 RHEL 8.10 / 9.x / Rocky 9 + CI 3종 | ❌ CI는 워크플로 1개 (`.github/workflows/deploy-twin.yml`). OS 컨테이너 테스트 없음 |
| 3 | **벤더 추상화 — UPS 드라이버 플러그인** | ⚠ **절반 있다.** `probe-agent/src/pollers/index.js`가 kind→collector 레지스트리이고 `oid-catalog.js`가 벤더별 OID를 분리한다. 단 UPS는 프로파일 2종(표준/APC) 하드코딩 — Eaton·Vertiv·Mitsubishi·Delta를 "드라이버 추가만으로" 넣는 구조는 아니다 |
| 4 | 멀티테넌트 `tenant_id` + 사이트/건물/층/구역 | ⚠ `tenant_id`는 전 테이블에 있다. **층·구역 계층은 없다** (room → rack 2단) |
| 5 | 설정 분리, 번들 고객 무관(동일 체크섬) | ❌ KMX 원장이 `apps/twin/src/demo/`에 **번들 내부**에 있다. `site.yaml` 개념 없음 |
| 6 | SemVer + GPG 서명 + N-2 업그레이드 + 롤백 | ❌ 번들 자체가 없음 |
| 7 | CI 오프라인 번들 재현 빌드 + SBOM + 취약점 스캔 | ❌ |
| 8 | **SNMP 시뮬레이터로 44대+ E2E** | ⚠ **기반 완성.** `probe-agent/sim/` 4종(PDU·NetBotz·CRAC·스위치) + 운영측 UPS 시뮬 3종. **trap 생성은 없고**, 44대 동시 기동 하네스도 없다 |
| 9 | 제품 문서 EN/KR 세트 | ❌ 개발 문서만 |
| 10 | 관측성 — 헬스 엔드포인트, 구조화 로그(JSON) | ⚠ `GET /v1/fms/probes`·`channels/health` 있음. **로그는 평문 console** |
| 11 | UI 다국어 EN/KR(+ES), 사이트별 TZ·단위 | ⚠ **KO/EN 완비** — 사전 663 키 / 사용 중 532 문자열, 미번역 0건을 `i18n.test.mjs` 게이트가 강제한다. ES 없음. °C 고정, TZ는 CBU 단위만 |
| 12 | 3D 평면도 제품화 | D-1 참조 |

#### D-3. v1.1이 §9-A·B에 더하는 것

- **A3(PostgreSQL)**가 §14-4(층·구역 계층)와 묶인다 — 스키마를 두 번 고치지 않으려면 함께 설계할 것.
- **A4(포털 mTLS)**에 §4.4의 "모델·좌표 포워딩"이 추가된다. 용량 상한 설정 포함.
- **B15(AI 코파일럿)** 판단이 더 급해졌다 — §14-1의 에디션 구조에서 "On-Prem은 AI 없음"으로 분리하는 것이 가장 단순하다.
- **신규 B17**: WebSocket/SSE (§4.4) — 현재 30초 폴링.
- **신규 B18**: 오프라인 자산 번들화 (폰트·지도 타일) — SAT #11 통과 조건.
- **신규 B19**: 층(floor) 계층 + 좌표 모델 전환 + Admin 배치 편집기.
- **신규 B20**: trap 생성 시뮬레이터 (§14-8) — B2(trap 리스너)와 쌍이다.

### E. v1.2/v1.3 추가분 — PM 리포트 디지털화(§4.5) + 시드 데이터 검증

#### E-1. PM 모듈 (§4.5) — 전부 미구현

분기 PM이 지금은 유닛당 4쪽 Word/PDF 수작업이다 (Q3 2026-10-02/05/06 실사: HMA 35 · KUS 7 · HAEA 6 = **48건**). v1.2/v1.3은 이 양식을 제품 기능으로 흡수하라고 한다.

| 요구 | 현재 |
|---|---|
| PM 체크리스트 데이터 모델 (헤더·System Info·Battery Info·점검 10~12항목 PASS/FAIL/N/A·전기 측정값·환경·서명) | ❌ 없음 |
| 모바일/태블릿 입력, QR·시리얼 스캔, **SNMP 값 자동 채움**, 오프라인 후 동기 | ❌ 없음. 자동 채움의 재료(모델·시리얼·펌웨어·전압·부하·배터리·셀프테스트)는 수집기가 이미 읽는다 |
| 유닛별 PDF + 사이트 합본 + 분기 Status Report 자동 생성 | ⚠ `fms-pdf-gen.js`(월간 리포트용)가 토대. PM 레이아웃·합본·인덱스는 신규 |
| 분기 이력·직전 대비 변화 하이라이트 | ❌ 없음 |
| 데이터 품질 규칙 7종 | ❌ 없음 (아래 E-2가 그 규칙으로 시드를 실제 검증한 결과) |

#### E-2. 시드 CSV 검증 — 규칙 7종을 실제로 걸어본 결과

48행을 §4.5의 규칙에 걸었다. **5개는 스펙 기술과 일치, 1개는 시드에서 확인 불가, 1개는 스펙이 틀렸다.** 그리고 **v1.3이 시드에서 보정한 것 — 제 검증이 놓친 종류**

v1.3은 `HMA-UPS-MPOE-A` 한 행을 고쳤다. **열 밀림**이었다.

| 열 | v1.2 | v1.3 |
|---|---|---|
| `mfg_date_reported` | `Manual` | (공란) |
| `firmware` | `IE INFO RACK 4 (HMA MPOE UPS 1E-A)` | (공란) |
| `note` | — | `chassis label mfg 2022-W48 (serial); Exhibit 1 lists S/N 5D2249T04846 (module)` |

**펌웨어 열에 위치 문자열이 들어 있었고 제 R5 검사는 통과시켰다.** "비어 있나"만 봤기 때문이다. 위치 문자열은 비어 있지 않다.

→ **임포트 검증기는 공란이 아니라 형태(shape)를 봐야 한다.** 그걸 넣고 다시 돌리니 5건이 더 나왔다:

| 열 | 값 | 성격 |
|---|---|---|
| `firmware` | `BMC 16.0` (KUS IDF6) | UPS가 아닌 다른 컴포넌트 버전 — 오류 아님, 값 도메인 변이 |
| `battery_strings` | `INTERNAL` ×4 (HAEA HQ 전 4대) | 내장 배터리. 숫자 열에 단어 → 타입이 `int | 'INTERNAL'`이다. 숫자로 파싱하면 한 사이트 전체가 NaN |

그리고 `firmware`는 **자유 텍스트**다. 같은 세 가지 사실(컴포넌트·버전·ID)이 최소 5가지 표기로 들어 있고 **표기가 사이트별로 뭉친다** — 리포트를 타이핑한 사람별이다.

```
HMA      'UPS 16.9 (ID:1044)'   '16.9 (ID:1044)'   'BMC 16.0'
HAEA HQ  'UPS 17.0 (ID1225)'    'UPS 16.9, ID:1044'
```

정규식으로 맞추려던 제 첫 시도는 방향이 틀렸다 — 한 표기를 고집하면 사이트 하나가 통째로 떨어진다. **정규화 파서**가 필요하고, 게이트는 "표기가 맞나"가 아니라 "(컴포넌트, 버전, ID)로 파싱되나"를 본다. 위치 문자열은 파싱되지 않으므로 같은 테스트가 v1.2의 열 밀림도 잡는다.

**스펙이 안 짚은 문제 4개**가 더 나왔다.

| 규칙 | 결과 |
|---|---|
| R1 시리얼 중복 | ✅ **1건** — KUS IDF1·IDF2가 둘 다 `AS1935371831`. 스펙 기술과 정확히 일치 |
| R2 제조일 ↔ 시리얼 YYWW 불일치 | ✅ **3건** — PG-A1(보고 2013-08 vs `AQ2431`=2024-W31), PG-B1(2013-02 vs `AS2507`=2025-W07), **TC-B(2023-08 vs `AS2533`=2025-W33 — 스펙이 안 짚은 건)**. 기본값성 날짜(1/1/YYYY)는 이 시드에 없다 |
| R3 유닛 라벨 중복 | ⚠ **2E-A ×3 확인** (시리얼은 모두 다름). 단 **스펙이 말한 "2E-B 2건"은 이 시드에 없다** — `HMA-UPS-2E-B` 1건뿐 |
| R4 날짜 포맷 | ✅ 확인. `battery_install` **14가지** (`OCT 2025`, `JUL-2025`, `10/13/2025`, `12/11/2025 OR NEWER`, `N/A` …), `battery_replace_due`는 `MON YYYY` 41 / `MON-YYYY` 4 / **날짜 범위 3** (`12/11/2035-02/12/2036`) — **범위 형식은 스펙 목록에 없다** |
| R5 필수값 누락 | ⚠ **시드에서는 0건.** 스펙이 지적한 "완료 시각·Ah 공란"은 **CSV에 그 열 자체가 없다** → 원본 PDF 쪽 문제이고 시드로는 검증 불가 |
| R6 Exhibit 1 외 장비 | ✅ **2건** — 둘 다 `HMA UPS 2E-A`, 모델 `SRT300RMXLA-NC`. 스펙 기술과 일치 |
| R7 배터리 수명 규칙 | ✅ 확인. SRT 계열 **4.2–5.2년**(스펙: 4.5~5년), SRYLF **10.0–10.2년**(스펙: 10년). **단 `SYAF16KRMT`(Symmetra LX)가 4.5년** — 스펙 규칙이 SRT·Modular Ultra만 다루므로 **Symmetra 수명 규칙이 없다** |

**스펙이 안 짚은 문제 4개**

1. **모델명 오타** — `SRT300RMXLA-NC` ×3 이 `SRT3000RMXLA-NC` ×3 과 나란히 있다. 0이 빠진 같은 기종이다 (APC에 `SRT300` 부품번호는 없다). 6대가 두 표기로 갈려 있어 카탈로그 조인·수명 규칙이 둘 다 깨진다.
2. **유닛 라벨 형식이 3가지** — 하이픈형 `HMA-UPS-1W-B` 8건 · 공백형 `HMA UPS 2E-A` 26건 · **위치를 라벨로 쓴 것 14건**(`KUS IDF1 Relay Rack 3`, `HMA FV_6F Boarding RM`). 뒤 14건은 유닛 식별자가 아니다. 라벨 유일성 규칙(R3) 이전에 **정규화 대상**이다.
3. **`battery_replace_due`에 날짜 범위** — `12/11/2035-02/12/2036` 형식 3건. R4 파서가 `precision` 외에 **범위**도 보존해야 한다.
4. **`battery_install = 'N/A'` 1건** — 그런데 `battery_replace_due`에는 값이 있다. R7(설치일+수명) 계산이 불가능한 행이므로 "교체 권장일만 있고 근거 없음"으로 분리해야 한다.

#### E-3. 시드가 드러낸 코드 결함 — **고쳤다**

시드를 제 카탈로그에 걸었더니 **48대 중 41대가 해석 실패**였다.

원인: **APC는 마케팅명이 아니라 부품번호로 표기한다.** 섀시·Exhibit 1·PM 리포트 모두 `SRT5KRMXLT`라고 쓰는데 제 매처는 `SRT 5000`만 알았다. 결과로 41대가 **랙 높이 없음 · kW 정격 없음 · 사진 없음 · 배터리 수명 패밀리 없음** 상태였다 — 3D 랙은 전부 같은 슬래브로 그리고, 용량 모듈은 사이트 대부분에 "정격 미상"을 냈다.

| 모델 | 대수 | 전 | 후 |
|---|---|---|---|
| `SRT5KRMXLT` | 20 | ❌ | SRT 5000 · 3U · 4,500 W · 사진 |
| `SRT8KRMXLT` | 17 | ❌ | SRT 8000 · 4U · 7,200 W · 사진 |
| `SRT300RMXLA-NC` | 3 | ❌ | SRT 3000 (오타 보정, 보정 사실 표시) |
| `SYAF16KRMT` | 1 | ❌ | Symmetra LX · **부품번호에서 16 kVA → 14,400 W** |
| 나머지 4종 | 7 | ✅ | 유지 |
| **합계** | **48** | **7/48 (15 %)** | **48/48 (100 %)** |

고친 내용:
- `apcCatalog.js` — SRT 1K/2.2K/3K/5K/6K/8K/10K 부품번호 패턴 추가 (`SRT10K`가 `SRT1K`로 잡히지 않게 경계 처리), Symmetra에 `SYAF\d+K` 추가
- `catalog.js` — `MODEL_TYPOS` + `normalizeModel()`. **오타를 카탈로그 매처에 넣지 않는다** — 보정은 따로 하고 `model_corrected_from`/`model_correction_why`가 엔트리에 실려 화면이 "보정된 모델명으로 해석됨"을 말할 수 있다
- `capacity.js:upsRating()` — kVA 범위 패밀리는 **부품번호에서 정격을 읽는다**. SRT/SYAF는 kVA(×0.9), SRYLF는 kW. 부품번호 없는 `Symmetra LX`는 여전히 `정격 미상` — 맞는 동작이다
- `src/twin/haea_q3_2026_fleet.csv` + `fleet.test.mjs` 7종 — **실제 플릿이 게이트다.** 고객 하드웨어를 못 읽는 카탈로그는 카탈로그가 아니다

#### E-4. §9-A·B에 더하는 것

- **신규 B21**: PM 체크리스트 모듈 (§4.5 전체). 자동 채움 재료는 수집기에 이미 있다
- **신규 B22**: 데이터 품질 규칙 7종 + E-2가 찾은 4종 + **열 형태 검증 3종**(열 밀림, 숫자 열의 `INTERNAL`, 자유텍스트 `firmware` 정규화) = **14종**을 임포트 검증기로. 공란 검사만으로는 열 밀림을 못 잡는다
- **신규 B23**: Q3 시드 48행 + PDF 48건 임포트 (Exhibit 1 IP와 **시리얼로 조인** — 라벨로 조인하면 E-2 ②번 때문에 깨진다)
- **신규 B24**: Symmetra 계열 배터리 수명 규칙 (R7이 SRT·Modular Ultra만 다룬다)
- **B5(Exhibit 1 임포트)**가 커진다 — 시리얼 조인 + 중복 경고 + 프레임/MIM 2중 시리얼 + 라벨 정규화

### C. 현장 전제 (코드 아님, 일정 리스크)

| # | 항목 | 상태 |
|---|---|---|
| **C1** | NMC SNMP | **현재 v1만 설정.** v3/v2c 현장 작업 필요 |
| **C2** | 라우팅 | 10.138.14.x → HMA/KUS NMC VLAN 미확인. 안 되면 Collector 3대 |
| **C3** | 방화벽 룰 B (포털 아웃바운드) | 승인 대기. 거절 시 로컬 모드(SMTP) 필수 |
| **C4** | GMDM 코드·핸드오버 | 대기 |
| **C5** | HMA 수량 | Exhibit 1 31대 vs 실사 35대. PG-A2·PG-B2·6F Boardroom IP 없음 |

C1~C5는 스펙 §10·§13과 동일하며 이 문서가 추가할 정보는 없다.

---

## 10. 공동 작업 규칙 (제안)

1. **분기 기준은 `feat/twin-rack-elevation`(`6c9cb6e`)**. `codex/bootstrap`은 `23576fd`라 S1 작업이 빠져 있다.
2. **담당 분리 제안** — 충돌면이 거의 없다:
   - Codex: **A1**(App 베이스 들여오기) → **A2**(설치기·번들) → **A6**(systemd·SELinux)
   - Claude Code: **A3**(PostgreSQL 전환) → **B2**(trap) → **B3**(OID 확장) → **B4**(배터리 EOL)
   - 공통 합의 필요: **A4**(포털 mTLS 프로토콜 — 양쪽 코드에 걸친다), **A5**(무상태화)
3. 기존 작업 경로에서 `checkout`/`reset`/`stash` 하지 않는다 (10-11 규칙 유지).
4. **운영 서버·고객 VM 변경 금지**는 이 단계 내내 유효하다. 검증은 시뮬레이터(`probe-agent/sim/`)와 로컬 DB로 한다.
5. 운영 `/opt` 파일은 Git 정본과 다를 수 있다. S1 패치가 `deploy/s1/*.js`로 주입된 라우트가 그 예다. **번들을 만들기 전에 파일 해시와 DB 스키마를 대조**해야 한다.

---

## 부록. 이 문서에 들어가지 않은 것

- 비밀번호·토큰·인증서 개인키·SNMP community 값·webhook URL — 의도적으로 제외
- 운영 서버·고객 VM 상태 — 이 문서는 저장소만 보고 썼다
- `cflex-shell/` `sentinel-api/` `ringonservice-net/` — HAEA 범위 외
- `apps/twin/` 내부 상세 (카탈로그·용량 모듈의 모듈별 설명) — 분량 때문에 생략했다. **범위 판단은 §9-D에 있다**: v1.1 §4.4가 3D 평면도 뷰를 필수로 지정했으므로 twin은 범위 외가 아니다.
