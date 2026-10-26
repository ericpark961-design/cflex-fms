# 진행 보고 (STATUS) — 에이전트가 세션 종료 시 자기 블록에 **추가**한다. 관리자는 읽고 TASKS.md를 갱신한다.

## Claude Code 블록
### 2026-10-25 — 관리자 초기화
- 기준 커밋 88870a7. WO-INT-001 배정.

### 2026-10-25 — Claude Code
- WO-INT-001: **검토요청** | 브랜치 `wo/INT-001-scope-correction` (base `2bfe9a3`) | 커밋 `b087445`
  - 완료 기준 ①②③ 충족: 정정판 `docs/handoff/HAEA_SCOPE_CONFIRMATION_v2.md` 저장소 md로 커밋(아티팩트 링크 아님) · 잘린 §7.2 복원(v2 §0·§1·§4.4b) · `HAEA_CURRENT_STATE.md` §10을 A/B 작업단위 제안 폐기 → 시스템 경계(내부/포털) 분리로 교체
  - 지시된 5개 절 정정 완료: §0(내부 5요소 + 알람 1차 분류가 내부) · §7.1(01 §2.2로 확정) · §7.2(판정 위치 반전) · §4.3(구현완료 → 계약 00 대비 교체 대상, 11항목 1:1 대조표) · §4.4(무인 자동적용·WireGuard 철회 → D-04)
  - §5 권고: 1·2·7 채택 / 3·5 수정 / 4 보류 / 6 미확정(01 §6-1)로 반영
  - v2 §9에 v1 오류 10건을 원인과 함께 기록
  - 테스트: 문서 변경만, 코드 영향 없음. 회귀 확인으로 전체 재실행 — **174 통과 / 0 실패**
    · backend 139 — topology 31 · triage 17 · derive-status 16 · state_machine 14 · copilot 12 · metrics 10 · **control-policy 9** · probe-health 8 · kmx_demo 6 · pdf-gen 6 · notify-adapter 6 · reeval 4
    · packages/notify 15 · probe-agent 20 (collectors 13 · cycle 7)
- 질문 2건: `Q-2026-10-25-01` (WO 브랜치 base — main에 control plane·기준커밋 88870a7 없음, 18커밋 뒤, origin 미푸시) · `Q-2026-10-25-02` (운영 DB 시뮬레이터 장비 4대 유지/삭제)
- 블로커: 없음. 단 Q-01 답이 없으면 이후 WO도 같은 base 문제를 반복한다.
- 다음 세션 계획: WO-INT-002 (Forwarder → 계약서 00). 먼저 `docs/spec/schemas/*.json`(계약 부록 C 8종) 생성 → payload 검증 테스트 → 프록시 더미 → 자체 목으로 E2E. 포털 `/_mock`(WO-PTL-001)이 먼저 올라오면 그쪽으로 전환.

### 2026-10-25 — Claude Code (2차)
- WO-INT-000: **검토요청** | `feat/twin-rack-elevation`→`wo/INT-001`→`tools/control-mcp`(cbb4f49)가 `a0db8e4` 위에 일직선이라 **fast-forward**, 머지 커밋 없음 | `git push origin main` 완료
  - **origin/main = main = `cbb4f490f5e236ae2d9f061ce6887066605fed84`** (`a0db8e4..cbb4f49`, 22커밋)
  - `gh pr list` 동작 확인(종료코드 0, 당시 열린 PR 0건). 푸시 전 diff에서 비밀값 패턴 검사 — 해당 없음. 미추적 `scripts/`·`.runtime/`은 커밋하지 않음
  - wo/INT-001·tools/control-mcp는 이미 main에 포함돼 별도 PR 불필요
- WO-INT-002: **검토요청** | 브랜치 `wo/INT-002-forwarder-contract` (base main `cbb4f49`) | 커밋 `46706f2` | **PR #1** https://github.com/ericpark961-design/cflex-fms/pull/1
  - 완료 기준 ① 스키마 8종 `docs/spec/schemas/*.json` ② payload 스키마 검증 테스트(`test/contract.test.js` 8건) ③ 프록시 경유 테스트(로컬 CONNECT 프록시 + Basic, 407, NO_PROXY, 터널 종료) ④ 자체 목 E2E(mTLS 필수·헤더·멱등키·스키마 검증 목에 inventory→telemetry→events→heartbeat 통과) — 전부 충족
  - 구현: `/api/v1/*` + mTLS + `X-CFlex-Tenant/Node` + 큐 적재 시 고정되는 Idempotency-Key + 백오프 1s~5분 ±20% / 429 Retry-After / 409 재시도 / 기타 4xx 폐기 + heartbeat 60s + telemetry 60s·500포인트 배치 + CLOCK_DRIFT. 구 `/v1/probe/event`는 `CFLEX_LEGACY_FORWARD=1`일 때만(기본 off). axios 제거, 신규 의존성 0
  - 작업 중 발견·수정: 프록시 경유 요청 뒤 CONNECT 터널 소켓이 닫히지 않아 요청마다 소켓이 남던 문제 → 응답 후 종료 + 회귀 테스트
  - 테스트: `node --test probe-agent/test/*.test.js` → **22/22 통과** (collectors·cycle 기존 2파일 + contract 8 + E2E 12), 0.6초
  - 범위 밖으로 남긴 것: 명령 큐 §3.6·config §3.7(heartbeat의 `commands_pending`만 기록), 정식 알람 분류(WO-INT-003). Codex `/_mock`이 나오면 E2E를 그쪽으로 한 번 더 돌릴 것
  - 미확인: 실제 `index.js` 기동 스모크는 못 함(이 Mac에 `node_modules` 없음 — better-sqlite3). forwarder는 E2E로 검증
- 질문: `Q-2026-10-25-04`(프록시 NTLM) · `Q-2026-10-25-05`(시리얼 없는 장비 device_id) · `Q-2026-10-25-06`(스키마 위치 vs `cflex-contract`)
- 참고: control-mcp 쓰기 도구(`control_claim`/`control_report`)는 이번 세션에 권한 승인이 안 돼 파일을 직접 편집함(Q-03 조건 ⑤에 따라 같은 형식)
- 블로커: 없음
- 다음 세션 계획: WO-INT-003 (알람 1차 분류 + 로컬 알림). Q-05 답에 따라 adapt.js의 device_id 규칙 조정

### 2026-10-25 — Claude Code (3차)
- WO-INT-003: **검토요청** | 브랜치 `wo/INT-003-alarm-local-notify` (base main `f9f00dd`) | 커밋 `3d5dd6a` | **PR #2** https://github.com/ericpark961-design/cflex-fms/pull/2
  - 완료 기준 ① 단위 테스트(분류·억제) `probe-agent/test/alarms.test.js` 9건 — 부록 B 사전 = 스키마 enum, 심각도는 코드 기준, 중복 억제(update 최대 15분 1회), 플래핑(15분 내 3회 → 유지, 15분 조용하면 clear), 유지보수 모드, COMM_LOST 30분 홀드
  - ② ServiceNow·SMTP 더미 서버 E2E `test/local-notify.e2e.test.js` 8건 — 폴러 알람 → 엔진 → 더미 SMTP(AUTH)·Teams·더미 ServiceNow(생성/작업노트/해결, alarm_id↔INC 파일 저장, 재시작 후 해결) → mTLS 목 포털. **테스트 티켓** `bin/cflex-test-ticket.js`(생성→작업노트→해결, INC 출력, exit 0/1/2) + `testTicket()` 함수(콘솔 버튼은 WO-INT-004)
  - ③ `local_notified` 계약 테스트 — 알림기 출력 전 형태 스키마 통과·잘못된 타입 거부, 포털 수신 본문 포함 확인. 값은 **실제 전달 결과**(메일 거부·SN 503 → false/null)
  - Q-05 반영: inventory `provisional:true`/`id_basis:"ledger"`, 시리얼 확인 시 구 ID `replaced_by` 1회 전송. `inventory.schema.json`에 두 필드 추가(Codex 수신 검증에 영향, 태그 1.0 유지)
  - `packages/notify` 의존성 0 유지 — SMTP 클라이언트(STARTTLS·AUTH PLAIN/LOGIN) + ServiceNow create/update/resolve
  - 테스트: `node --test probe-agent/test/*.test.js` **42/42** · `packages/notify` npm test 14종 ok + 5/5 · backend notify-adapter ok
  - 동작 변화: 배터리 용량 경고(60% 미만)는 부록 B 코드가 없어 포털로 보내지 않음(Q-07). update는 매 사이클 → 최대 15분 1회
  - 미확인: 실 HAEA 릴레이·ServiceNow 미시험(금지 범위). STARTTLS 업그레이드·https SN 프록시 경로는 테스트로 돌려보지 않음(더미는 평문). 열린 알람 상태는 메모리(재시작 시 재-raise, INC 매핑은 유지)
- 질문: `Q-2026-10-25-07`(배터리 용량 경고 코드 없음) · `Q-2026-10-25-08`(스키마 v1.1 필드 vs 태그 1.0)
- 블로커: 없음
- 다음 세션 계획: PR #2 검토 반영 → WO-INT-004 (Local Console: 알람 목록/ACK·유지보수 설정·테스트 티켓 버튼이 이번 엔진/알림기를 사용)

### 2026-10-25 — Claude Code (4차)
- WO-INT-004b: **검토요청** | 브랜치 `wo/INT-004b-contract-1.1` (base main `e59f6b9`) | 커밋 `e6c6947` | **PR #3** https://github.com/ericpark961-design/cflex-fms/pull/3
  - `UPS_BATTERY_CAPACITY_LOW`(P3) 매핑: 60% 미만(30% 미만은 `UPS_LOW_BATTERY` P1 유지). 방전 중, 그리고 방전 복귀(UPS_ON_BATTERY clear) 후 2시간 동안 억제. 억제 시각은 재시작해도 유지
  - 계약 테스트의 버전 검사를 1.1로 올림. Probe 요청 헤더 `X-CFlex-API-Version: 1.1`
  - **열린 알람 재시작 유지**: 버퍼 SQLite에 `state` 테이블을 두고 같은 alarm_id로 update/clear를 이어 감. 플랩 이력과 통신두절 30분 카운트는 저장하지 않음(재시작하면 0부터)
  - **관리자 확인**: `events.schema.json` 코드 enum에 `UPS_BATTERY_CAPACITY_LOW`가 빠져 있어 추가함(e59f6b9는 태그만 1.1로 올림). UPS 폴러가 내는 경고 순서를 바꿈(output_source를 battery_pct보다 먼저)
  - 테스트: `cd probe-agent && npm test` **48/48** (신규 alarm-state 6건)
- WO-INT-004: **검토요청** | 브랜치 `wo/INT-004-local-console` (base main `e59f6b9`) | 커밋 `c133b60`·`9634919`·`c4c0d14` | **PR #4** https://github.com/ericpark961-design/cflex-fms/pull/4
  - `apps/console`(cflex-app): 의존성 0, node:http, Redis는 RESP 직접 구현, SQLite(better-sqlite3 우선, 없으면 node:sqlite)
  - 완료 기준 ① app01/app02 동일 이미지: 프로세스 상태 없음. 통합 테스트로 두 인스턴스를 띄워 확인함 — app01에서 만든 세션이 app02에서 통하고, app01을 중지해도 app02가 계속 응답(SAT 6), 잠금은 두 노드 공통
  - ② 세션 Redis: 토큰은 SHA-256만 저장, Redis 장애 시 503
  - ③ 통합 테스트 `cd apps/console && npm test` **22/22**
  - ④ 외부 CDN 0건:
    - 모든 응답에 CSP `default-src 'self'`
    - twin 콘솔 빌드 `npm run build:console`에서 Google Fonts·OpenFreeMap 제거
    - 번들 스캔 테스트 + 스캐너 자가검증
  - 범위:
    - 로컬 계정과 역할 3종: scrypt, 비밀번호 정책, 최초 변경 강제, 5회 실패 시 15분 잠금, 감사로그 append-only
    - 알람: 목록/상세/ACK/코멘트
    - 장비: 현황, 트렌드 1h~30d
    - 설정 `/settings`: 사이트·장비·CSV 임포트(§2.2 경고 5종)·SNMP 크리덴셜(AES-GCM)·임계치·알림 채널·**테스트 티켓 버튼**·유지보수·사용자·collector 키·상태(포털 링크)
    - nginx 443 설정, 0.0.0.0 바인딩
  - collector API(수신은 계약 스키마로 검증, devices/config pull)는 만들어 둠. **probe-agent가 콘솔로 보내고 받아 오도록 바꾸는 작업은 아직**
  - 한계:
    - app01/app02 실제 VM 분리는 WO-INT-008(PostgreSQL)이 끝나야 가능(SQLite 파일은 VM 간 공유 불가)
    - XLSX 임포트 없음(CSV만), SAML은 플래그만 있음
    - 브라우저로 육안 확인은 못 함. 스모크로 twin이 로드 시 부르는 엔드포인트를 전부 호출해 봄(포털 범위만 404/빈 목록)
  - probe-agent는 이 브랜치에서 41/42 — 실패 1건은 v1.1 버전 검사이고 PR #3에서 고침
- 질문: `Q-2026-10-25-09` (기존 UI = `apps/twin`인지, 포털 범위 화면 처리 — A/B/C)
- 블로커: 없음
- 다음 세션 계획: PR #3·#4 검토 반영 → probe-agent의 콘솔 연동(장비 pull, telemetry/events 두 번째 목적지, 지시가 있으면) → WO-INT-005

### 2026-10-25 15:36 PDT — Claude Code (5차)
- WO-INT-005: **검토요청 (일부 미수행)** | 브랜치 `wo/INT-005-rhel-container` (base main `91a2080`, 작업 트리 `../cflex-fms-wt-int005`) | 커밋 `25906b7` | **PR #5** https://github.com/ericpark961-design/cflex-fms/pull/5
  - 만든 것:
    - `images/{collector,app,web}/Containerfile`: ubi8/nodejs-20, ubi8/nginx-122, UID 1001, 읽기 전용 루트 전제, HEALTHCHECK
    - redis/postgres는 rhel8 이미지 참조만(`images/base-images.env`)
    - Quadlet `.container` 5종 + `.pod`: 전 볼륨 `:Z`, `Pull=never`
    - `cflex-install`: preflight/install/verify/netcheck/upgrade/rollback/render, 베어 프로파일 포함
    - `install.sh` RHEL 전용 교체
    - `build-bundle`: podman save + SHA256SUMS + SBOM 스텁 + MANIFEST.json
    - 운영 문서 `docs/install/CONTAINER_PROFILE.md`
  - trap 162 결정: forward(firewalld 162→1162)가 기본이고, firewalld가 없으면 sysctl(`ip_unprivileged_port_start=161`). 문서 §2
  - netcheck: 01 §1 8행을 `install/netmatrix.json`에 글자 그대로 옮겼다. 정적 테스트가 §1 표와 대조하고, 출력도 같은 표 형식
  - 설계상 발견:
    - RHEL 8.10의 Podman 4.9에는 Quadlet `.pod`가 없다 → web이 네트워크 네임스페이스를 소유하는 방식으로 렌더하고, Podman ≥5에서는 `.pod`를 쓴다
    - 콘솔 노드 간 대체 경로는 v3대로 443으로 만들었다(8080 아님)
  - 테스트:
    - `node --test install/test/static.test.js` **11/11**
    - probe-agent 기존 7파일 + health **52/52**
    - apps/console **22/22**
    - `bash -n` 스크립트 4개 OK
  - **미수행 (추측으로 통과 처리하지 않음)**:
    - ① `podman build`·컨테이너 기동·`podman healthcheck`: 이 Mac에 Podman 없음
    - ② RHEL 8.10/UBI8에서 Node 20 테스트: 같은 이유
    - ③ 설치기 Python 단위 테스트 8파일(`python3 -m unittest discover -s install/test`): 작성만 했다. 이 세션은 Python 실행 권한이 없다. 대신 별도 리뷰 1회로 실제 결함 6건을 찾아 고쳤다(PyYAML 3.12 비호환, /opt/app/cflex 권한, secret 개행, Podman 5 `UserNS`+`Pod`, 예외 처리, 로케일)
    - ④ `nginx -t`: 실행 승인이 안 됨
    - ⑤ redis/postgres를 읽기 전용 루트에서 기동하는 것
    - ⑥ 취약점 스캔과 정식 SBOM(스텁만 있음)
  - 범위 밖으로 남긴 것: 베어용 SELinux .pp 모듈, DB 마이그레이션 실행기(WO-INT-008), trap 리스너 자체(WO-INT-006)
  - collector 장비 pull은 아직 구 클라우드 경로다(WO-INT-004c). env에 `CFLEX_URL=https://<active app>`를 넣어 v3 밖으로 나가지 않게만 했다
- 작업 트리 사고 대응: 이 세션 도중 다른 세션이 메인 트리를 `wo/INT-portal-integration`로 바꿈
  - 내 미커밋 변경을 새 규칙대로 `../cflex-fms-wt-int005` 워크트리로 옮겨 커밋했다
  - 메인 트리에서는 내 파일만 되돌리고 지웠다(`git restore`·`git clean`, 경로 지정). 그 세션의 커밋·파일은 건드리지 않음
- WO-INT-004c: **미착수** (시간 부족 — 005 이전·재검증에 소요)
- 질문: `Q-2026-10-25-10`(로컬 알림 발송 위치 collector vs v3 FW-8 app) · `Q-2026-10-25-11`(Redis 단일 노드 → app01 VM 장애 시 app02 로그인 불가, SAT 6)
- 블로커: 없음. 관리자 확인 요청 — Python 실행이 가능한 곳에서 `python3 -m unittest discover -s install/test` 1회
- 다음 세션 계획: Podman이 있는 RHEL/UBI 호스트가 생기면 ①②⑤ 확인 → WO-INT-004c(Q-10 답에 따라 알림 발송 이전 포함)

### 2026-10-25 18:10 PDT — Claude Code (6차)
- WO-INT-004c: **검토요청** | 브랜치 `wo/INT-004c-internal-console` (base main `e7ea8dc`, 작업 트리 `../cflex-fms-wt-int004c`) | 커밋 `ee6476e`·`19bc15c`·`c161098`(+질문) | **PR #6** https://github.com/ericpark961-design/cflex-fms/pull/6
  - ① Q-10=(A) **알림 발송을 콘솔로 이전**:
    - Collector는 알림 채널이 없다. `CFLEX_NOTIFY_CONFIG`만 있으면 경고 후 무시한다. `CFLEX_COLLECTOR_NOTIFY=1`일 때만 구 경로를 쓴다.
    - 콘솔 `POST /collector/v1/events`가 저장 → SMTP/Teams/ServiceNow 발송(`apps/console/src/notify.js`, local-notify 재사용) → `event_id → local_notified`로 응답한다. Collector가 이것을 포털 events에 싣는다(계약 00 v1.1 그대로).
    - alarm_id↔INC 매핑은 `itsm_map` 테이블에 둔다. 그래서 app01에서 연 INC를 app02가 해결한다.
    - 같은 이벤트를 다시 받으면 저장된 답을 돌려준다(두 번 알리지 않음).
    - 억제: 콘솔에서 연 유지보수 창, 15분 넘게 늦은 replay.
    - `/collector/v1/config`에서 알림 비밀값을 뺐다(이제 콘솔 밖으로 나가지 않음).
  - ② **probe-agent↔콘솔 실제 연동** (`probe-agent/src/console/client.js`):
    - 인벤토리 pull: 장비 + SNMP 크리덴셜 + 임계치(콘솔→폴러 형식) + 유지보수 창 → 엔진.
    - telemetry/events/heartbeat push.
    - 콘솔 전용 큐 `q_console`과 백오프를 따로 둔다. 콘솔이 불통이어도 포털은 막히지 않는다. 그 사이 이벤트는 포털에 `local_notified` 없이 즉시 가고, 콘솔에는 나중에 `X-CFlex-Replay`로 간다.
    - `CFLEX_CONSOLE_URL`에 두 앱 노드를 넣으면, 한쪽이 접속 불가일 때 다른 노드로 넘어간다(SAT 6, VIP 없음).
  - **E2E 1회 — mock 없이 두 프로세스**: `probe-agent/test/console.e2e.test.js` **4/4**.
    - 프로세스 3개: `node apps/console/src/server.js`, `node probe-agent/src/index.js`, UPS SNMP 시뮬 `sim/sim-ups.js`(신규).
    - 흐름: 콘솔 인벤토리 pull(community 포함) → SNMP 폴링 → onBattery P1 → 콘솔이 메일·ServiceNow 발송 → 포털 raise 이벤트의 `local_notified` = 콘솔 기록 → online 복귀 → clear, INC 해결 → heartbeat에 포털 링크 상태.
    - 대역(이 Mac에 없는 것): nginx=TLS 프런트, Redis=mini-redis, HAEA SMTP/SN=dummy, 포털=mTLS mock(실 포털 /api/v1 없음).
  - ③ **`CONSOLE_PROFILE=internal` 빌드** (Q-09 B):
    - `npm run build:console`의 기본값이 internal이다. app 이미지 빌드에도 명시했다.
    - 3D·NOC·파워체인·지도·Copilot의 라우트·메뉴 링크·API 호출이 **0**이고, three/maplibre가 빠졌다(1.9 MB → 0.89 MB).
    - 코드는 지우지 않았다. 포털 화면은 `portalScreens.jsx`로 모았고, 내부 빌드는 스텁으로 해석한다. 템플릿 링크는 빌드 시 제거된다. WallScreen은 App.jsx에서 파일로 이동만 했다.
    - 콘솔 API: internal에서 routes·control/actions 미등록(404).
    - 빌드 검사: `apps/twin/src/profile.test.mjs`가 두 프로파일을 실제로 빌드해 비교한다. portal 빌드에서는 검출되므로 검사가 동작함이 확인된다. 콘솔 테스트는 배포될 `dist-console`을 검사한다.
  - ④ Q-11=(A) **Redis replica + promote**:
    - 두 앱 노드에 Redis를 둔다. `install.redis_host`가 primary, 다른 노드는 `replicaof`(읽기 전용)이다.
    - `auth.conf`에 requirepass와 masterauth를 둔다. 6379는 피어 /32만, 양 노드에서 연다.
    - `cflex-install promote --role app`: 옛 primary가 6379에 응답하면 거부한다(`--force` 예외). 이어서 `REPLICAOF NO ONE` → redis.conf·app.env 재렌더 → 콘솔 재시작 → state 기록.
    - site.yaml이 바뀔 때까지 install/upgrade/rollback은 승격을 되돌리지 않는다. verify에 replication 점검을 넣었다.
    - 운영 절차 `docs/install/REDIS_FAILOVER.md`: SAT 6 판정 절차, 복귀, 원복, 베어 수동 절차.
  - ⑤ **노드 간 443 통일, netcheck·verify 정리**:
    - 베어 nginx 참조본(`deploy/console`)을 설치기 bare 렌더 결과로 교체했다(로컬 127.0.0.1:8080, 피어 443). 정적 테스트로 두 프로파일 모두 노드 간 8080이 없음을 확인한다.
    - netcheck: cap01의 FW-8은 **"해당 없음 — 로컬 알림은 Local Console(app)이 발송"**.
    - verify: 알림 경로 점검은 app만 한다. `--send-test`는 app에서 콘솔 CLI `test-ticket`(신규)을 돌린다. collector 키 존재도 확인한다.
    - collector.env에 콘솔 URL(두 노드)·키·CA를 넣었다.
  - 테스트(이 세션 실행, 전부 통과):
    ```
    probe-agent        npm test                                       62/62   (기존 52 + console-link 6 + console.e2e 4)
    apps/console       npm test                                       27/27   skip 0 (dist-console 빌드 있음 → CDN·라우트 검사 실행)
    apps/twin          npm test                                       13/13 스크립트 (profile.test.mjs 신규)
    install            python3 -m unittest discover -s install/test   51/51
    install            node --test install/test/static.test.js        12/12
    packages/notify    npm test                                       5/5
    ```
  - **미수행 (통과로 치지 않음)**:
    - ① Redis 복제·`promote`의 실제 동작: Podman이 없어 확인하지 못했다. 단위 테스트는 명령·파일·상태만 본다. SAT 항목(D-11과 같음).
    - ② 내부 빌드 화면을 브라우저로 육안 확인하지 않았다. 산출물 스캔만 했다.
    - ③ 실 HAEA 릴레이·ServiceNow는 시험하지 않았다(금지 범위).
  - 로컬 전용(커밋 안 함): `probe-agent`, `apps/twin`에 `npm install` → node_modules. `.runtime/` 미추적.
- 질문 3건: `Q-2026-10-26-01`(콘솔 복구 후 replay 이벤트 알림 — 15분 기본) · `Q-2026-10-26-02`(내부 빌드에 남긴 워크벤치/티켓, "FMS 1.x"→"설정" 링크) · `Q-2026-10-26-03`(베어 Redis 미관리) — 모두 권고안으로 진행
- 블로커: 없음
- 다음 세션 계획: PR #6 검토 반영 → WO-INT-006(SNMP trap 162) 또는 관리자 지시 순서

### 2026-10-25 19:40 PDT — Claude Code (7차)
- WO-INT-006: **검토요청** | 브랜치 `wo/INT-006-snmp-trap` (base main `0a398e6`, 작업 트리 `../cflex-fms-wt-int006`) | 커밋 `9cd0d1d`(+STATUS 커밋) | **PR #7** https://github.com/ericpark961-design/cflex-fms/pull/7
  - ① **trap 리스너** `probe-agent/src/trap/listener.js`:
    - v1·v2c·v3(authPriv까지)를 받는다. inform은 프로토콜상 응답만 한다. 장비 쓰기(SET)는 없다(D-05).
    - 바인드는 `CFLEX_TRAP_PORT`(기본 1162)·`CFLEX_TRAP_BIND`(0.0.0.0)이고, `CFLEX_TRAP_ENABLED=0`이면 끈다(`config.js`).
    - 162→1162는 설치기(firewalld forward/sysctl, WO-INT-005)가 맡는다. 코드는 권한을 요구하지 않는다.
    - 크리덴셜은 **콘솔 인벤토리의 장비별 SNMP 크리덴셜을 재사용**한다(community, v3 user·auth·priv). trap 전용 설정은 없다. 인벤토리를 pull할 때마다 갱신된다.
  - ② **분류** `src/trap/handler.js`:
    - 발신 IP → 콘솔 인벤토리 장비. **그 장비 자신의** community/v3 user여야 받는다. 다른 장비의 크리덴셜이면 폐기하고 카운트한다.
    - 매핑은 `src/trap/apc-mib.js`(PowerNet-MIB specific → 부록 B)다. 다음 8개 코드를 raise/clear 쌍으로 다룬다: onBattery/powerRestored, lowBattery/returnFromLowBattery, overload/overloadCleared, commLost/Established, batteryNeedsReplacement/Replaced, diagnosticsFailed/Passed, turnedOff/On, bypass 3종/returnFromBypass.
  - ③ **기존 엔진 투입**:
    - `forwarder.alarms`·`forwarder.emitAlarms`를 쓴다. 폴링과 같은 (device, code) 키라서 **같은 alarm_id**가 되고, 중복 억제·플래핑·유지보수가 그대로 적용된다. 콘솔 → 포털 경로도 그대로다.
    - 엔진 변경은 최소로 했다: `latched`와 `clear()`·`isOpen()`.
      - 폴러가 보는 코드(onBattery 등)는 폴링이 "아직 있음"을 계속 판정한다.
      - trap으로만 아는 코드(`UPS_SELFTEST_FAIL`, `UPS_COMM_LOST`)는 latched다. 폴 주기에 풀리지 않고 clear trap으로만 해제된다.
    - communicationLost는 부록 B 30분 규칙을 지킨다: 30분 안에 Established가 오면 알람이 없다.
  - ④ **모르는 trap**:
    - 모르는 발신 IP·OID는 `SNMP_TRAP_UNKNOWN`으로 **기록만** 한다(카운트 + 로그 + 최근 200건). 부록 B·스키마 enum에 없는 코드라 이벤트로 보내지 않는다 → Q-04.
    - 환경·NetBotz·PDU trap은 부록 B에 코드가 없어 매핑하지 않았다 → Q-05. 새 코드도 만들지 않았다.
    - 잘못된 community·v3 인증 실패(모르는 user·틀린 digest)·해석 불가 패킷은 폐기하고 카운트한다.
  - ⑤ **시뮬레이터** `sim/sim-trap.js`: 15건(APC 13종 + 코드 없는 2종: NetBotz형 OID, coldStart)을 v1 4·v2c 8·v3 3으로 보낸다. CLI 또는 모듈로 쓴다. v3 키는 env로만 받는다.
  - ⑥ 문서: `probe-agent/README.md`에 "SNMP traps (WO-INT-006)" 절(포트·v3 설정·매핑표·unknown·테스트 방법)을 넣었다. `install/netmatrix.json`·netcheck는 이미 162/1162가 있어 **바꾸지 않았다**.
  - 테스트(이 세션 실행):
    ```
    probe-agent        npm test                                  74/74   (기존 62 + trap.test.js 12)
    apps/console       npm test                                  27 중 pass 25, fail 0, skip 2
    install            node --test install/test/static.test.js   12/12
    ```
    - trap.test.js 12건: 매핑표 = 부록 B만·raise마다 clear 있음 / RFC 3584 decode / 크리덴셜 집합 / **시나리오 15건 실 UDP(v1·v2c·v3 authPriv) → 알람 11건, 스키마 유효** / 잘못된 community·v3 auth 실패·모르는 user 폐기+카운트 / 다른 장비 크리덴셜 폐기 / 모르는 발신 IP → UNKNOWN 기록만 / commLost 30분 hold / latched / **폴링+trap 같은 장애 = 같은 alarm_id, 포털 raise 1건(양쪽 순서)** / 유지보수 창.
    - console skip 2건은 `apps/twin` 콘솔 빌드(`dist-console`)가 이 새 작업 트리에 없어서다(CDN·라우트 검사). 이번 변경과 무관하고, apps/console은 고치지 않았다. 6차의 27/27은 빌드가 있던 트리 기준이다.
  - **미수행 (통과로 치지 않음)**:
    - ① 실제 APC NMC의 trap 수신, PowerNet-MIB 원본과의 trap 번호 대조 → Q-06, SAT 항목.
    - ② 컨테이너(rootless Podman, slirp4netns)에서 발신 IP가 보존되는지 실측하지 못했다. Podman이 없다(D-11과 같음).
    - ③ install Python unittest·apps/twin 테스트는 이번 지시 목록에 없어 실행하지 않았다(해당 코드 변경 없음).
  - 로컬 전용(커밋 안 함): `.runtime/`, `probe-agent/package-lock.json`, node_modules.
- 질문 3건, 모두 권고안 (A)로 진행했다:
  - `Q-2026-10-26-04`: SNMP_TRAP_UNKNOWN이 부록 B 밖이라 기록만 한다.
  - `Q-2026-10-26-05`: 환경·NetBotz·PDU용 부록 B 코드가 없다.
  - `Q-2026-10-26-06`: APC trap 번호를 SAT에서 MIB와 대조한다.
- 블로커: 없음
- 다음 세션 계획: PR 검토 반영 → 관리자 지시 순서(Q-05가 (B)면 계약 v1.2 코드 추가 후 apc-mib 표 확장)

### 2026-10-25 21:40 PDT — Claude Code (8차)
- WO-INT-007: **검토요청** | 브랜치 `wo/INT-007-node20-sqlite` (base main `5e2e954`, 작업 트리 `../cflex-fms-wt-int007`) | 커밋 `a8a60e8`(코드) + control 커밋 | **PR #8** https://github.com/ericpark961-design/cflex-fms/pull/8
  - Node: **v20.20.2**(`npx -y node@20 -v`, ABI 115) / **v22.22.2**(시스템, ABI 127)
  - ① **`node:sqlite` 폴백 제거**:
    - `apps/console/src/db.js`는 better-sqlite3 단일 경로다. better-sqlite3를 `optionalDependencies`에서 `dependencies`로 옮겼다.
    - node:sqlite를 쓰던 테스트 3곳을 better-sqlite3로 바꿨다: `alarm-state.test.js`, `console.e2e.test.js`의 읽기 핸들, console `cli test-ticket`의 감사 확인.
    - `persist.js` 주석과 console README를 정리했다.
    - 정적 테스트가 probe-agent/console의 src·test·bin에 `node:sqlite`/`DatabaseSync`가 없는지 검사한다.
    - **main(=PR #7) 그대로 Node 20에서 돌리면 깨진다** — 이번 수정 전 상태다:
      - probe **64/69**: alarm-state 파일 + console.e2e 4건, `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`.
      - console **24/27** + 2 skip: test-ticket 1건.
  - ② **better-sqlite3 prebuild/ABI**:
    - 개발 Mac(darwin-arm64)의 `npm install`/`npm rebuild`는 Node 22에서 `node-v127-darwin-arm64`, Node 20에서 `node-v115-darwin-arm64` prebuild를 받았다
      (`prebuild-install ... Successfully installed prebuilt binary!`). 소스 빌드로 떨어지지 않았다.
    - **RHEL 8 대상은 다르다:**
      - linux-x64 prebuild 9.6/10.1/11.0/11.10(v115·v127)이 **전부 `GLIBC_2.29`를 요구**한다. RHEL 8 / UBI8는 2.28이다(바이너리 심볼 실측).
      - 그래서 UBI8에서는 prebuild가 로드되지 않는다. 이미지 안 소스 빌드가 유일한 경로다.
    - 고친 것:
      - Containerfile collector·app의 deps 단계: `npm_config_build_from_source=true` 명시, 빌드 직후 `require('better-sqlite3')(':memory:')` 로드 검사.
      - `install/build-bundle`(bundle.py): `podman save` 전에 두 이미지에서 `podman run --network=none --entrypoint node`로 better-sqlite3 로드 + `process.versions.modules == 115`를 검사한다. 아니면 번들 거부.
        `MANIFEST.json`에 `node:{major:20, abi:"115"}`와 이미지별 `node:{version, abi}`를 남긴다.
      - 베어 `preflight`: nodejs **정확히 20**만 PASS. 전에는 `>= 20`이어서 22에 115 트리를 깔 수 있었다 — 불일치 수정.
      - 문서: `docs/install/CONTAINER_PROFILE.md` §1.2. 이미지·베어 모두 Node 20 = NODE_MODULE_VERSION 115, 22 = 127은 로드 불가, prebuild를 쓰지 않는 이유, 미검증 항목.
    - 소스 빌드 경로 확인: 이 Mac에서 Node 20 + `--build-from-source` → node-gyp 컴파일 → Node 20에서 로드(ABI 115, SQLite 3.49.2).
    - `ubi8/nodejs-20` 이미지 history(레지스트리 API, pull 없음): `make gcc gcc-c++`, `python3 → platform-python` 확인.
  - ③ **index.js 실기동 스모크** `probe-agent/test/smoke.test.js` (`npm run smoke`, `npm test`에도 포함). 관리자 검토 로그 3차 미해결 항목.
    - 구성: `node src/index.js`(실프로세스) + `sim/sim-ups.js`(on battery) + 127.0.0.1 HTTPS 인벤토리 스텁(구 클라우드 pull, 테스트 CA는 `NODE_EXTRA_CA_CERTS`) + Portal URL = 닫힌 127.0.0.1 포트.
      env는 PATH + 지정값뿐이다(프록시 없음). trap 포트·바인드도 127.0.0.1 임의 포트다. 외부 네트워크·실장비 0, SNMP 읽기 전용.
    - 확인: ⓐ HEALTHCHECK(`bin/cflex-healthcheck.js`) 기동 전 unhealthy ⓑ 인벤토리 pull → 폴링 2주기 `1 ok, 0 fail`
      ⓒ HEALTHCHECK healthy ⓓ 버퍼에 inventory·events(UPS_ON_BATTERY raise)·telemetry 행이 쌓이고 `ECONNREFUSED`로 재시도 기록, 같은 파일 `state`에 열린 알람
      ⓔ SIGTERM → exit 0(<5 s), DB `integrity_check = ok`, 행 보존.
    - "헬스 엔드포인트": Collector에는 HTTP 리스너가 없다. 헬스는 주기 스탬프 파일 + `cflex-healthcheck.js`(컨테이너 HEALTHCHECK)이고, 그것을 검사했다(엔드포인트 추가 없음).
  - 테스트(이 세션 실행, 숫자 그대로):
    ```
                                                       Node 20.20.2        Node 22.22.2
    probe-agent      npm test                         67/67 skip 0        67/67 skip 0     (기존 62 + smoke 5)
    probe-agent      npm run smoke                     5/5                 5/5
    apps/console     npm test                         27/27 skip 0        27/27 skip 0     (twin build:console 후)
    packages/notify  npm test                         14 ok + 5/5         14 ok + 5/5
    install          node --test install/test/static.test.js   13/13      13/13            (기존 12 + better-sqlite3 1)
    apps/twin        npm test                         13/13 스크립트       13/13 스크립트
    install          python3 -m unittest discover -s install/test   54/54 (Python 3, Node 무관; 기존 51 + bundle ABI 2 + preflight 1)
    ```
    - **PR #7 브랜치 Node 20** (임시 트리 `../cflex-fms-wt-int007-tmp006`, 커밋 없음, 끝나고 `worktree remove --force`):
      - 그대로: probe 64/69, console 24/27 + 2 skip(실패 원인 ①).
      - **이 브랜치를 `--no-commit` 머지 미리보기**: probe **79/79**(74 + smoke 5, trap 리스너 포함 기동), console 25/27 + 2 skip(그 트리에 dist-console 없음), static 13/13.
  - **미수행 (통과로 치지 않음)**:
    - ① `podman build`로 UBI8 안 node-gyp 소스 빌드 → Q-2026-10-26-07.
    - ② 번들 ABI 검사의 실제 podman 실행. 단위 테스트는 fake podman이다.
    - ③ RHEL 8.10 실호스트 Node 20(AppStream) 실행. 이 Mac의 Node 20은 nodejs.org darwin-arm64 빌드다.
  - 범위 밖으로 남긴 것(수정 안 함): `node:sqlite`가 `apps/twin/mock/server.js`(개발용 목, 미배포), `backend/**`·`deploy/s1/snmp-reach.js`(내부 Probe 런타임 아님)에 남아 있다.
  - 로컬 전용(커밋 안 함): probe-agent·apps/console·apps/twin `node_modules`, `apps/twin/dist-console`, `.runtime/int007/`(로그·러너).
    lockfile을 새로 만들지 않았다(`--no-package-lock`).
- 질문: `Q-2026-10-26-07`(RHEL 8 glibc 2.28 → prebuild 불가, 이미지 소스 빌드 검증 시점) — 권고안 (A)로 진행
- 블로커: 없음
- 다음 세션 계획: PR 검토 반영 → WO-INT-008(PostgreSQL 16) 또는 관리자 지시 순서

### 2026-10-26 08:12 PDT — Claude Code (9차)
- WO-INT-008: **검토요청** | 브랜치 `wo/INT-008-postgres` (base main `ffdae05`, 작업 트리 `../cflex-fms-wt-int008`, origin/main `ffbe386` 머지 — 충돌 없음) | 코드 커밋 `c4e49cb` + 머지 `1cef8ef` + control 커밋 | **PR #9** https://github.com/ericpark961-design/cflex-fms/pull/9
  - ① **콘솔 저장소 → PostgreSQL 16** (`apps/console/src/db.js`):
    - 드라이버는 `pg`(순수 JS) 1개만 추가했다. 접속은 `CFLEX_DB_URL`(비밀번호 포함 URL은 거부) 또는 `CFLEX_DB_HOST/PORT/NAME/USER`이고, 비밀번호는 `CFLEX_DB_PASSWORD_FILE` 파일로만 받는다.
    - 호출부 `ingest·settings·views·notify·server·cli`를 async로 바꿨다.
      SQL은 `?` 자리표시자를 유지한다(따옴표·주석 밖에서만 `$n`으로 변환). BIGINT·NUMERIC은 JS number로 받는다.
    - 동작·화면·API는 그대로다. 정렬도 같다: 정렬에 쓰는 열은 `COLLATE "C"`(SQLite BINARY와 같은 순서), 사용자는 `lower(username)`(NOCASE와 같은 순서), NULL 먼저.
    - 로그인은 SQLite NOCASE처럼 대소문자를 구분하지 않는다.
    - `local-notify`(probe-agent, D-12a 동결)는 손대지 않았다. 동기 store 인터페이스는 콘솔 쪽에서 이벤트마다 읽고 쓰는 방식으로 맞췄다(요청별 사본, 노드 간 공유 없음).
    - 동작이 바뀐 곳 1건: `credentials`에 `UNIQUE NULLS NOT DISTINCT (site_id, device_id)`를 걸었다.
      SQLite에서는 같은 사이트 기본 크리덴셜을 두 번 PUT하면 행이 2개 생겼다(NULL은 서로 다르다고 봄). 이제는 갱신된다 — 버그 수정이다.
  - ② **마이그레이션** (`apps/console/migrations/0001_init.sql`):
    - `schema_migrations`(version·name·sha256·applied_at), 번호 순 적용, 파일 1개당 트랜잭션 1개.
    - 기동할 때 advisory lock을 잡고 적용한다. 두·세 인스턴스가 동시에 기동해도 각 파일은 1회만 적용된다(테스트).
    - 적용 후 내용이 바뀐 파일이 있으면 기동을 거부한다.
    - 그 밖: `GENERATED BY DEFAULT AS IDENTITY`, `citext` 대신 `lower(username)` 유니크 인덱스, epoch ms는 BIGINT 유지, 확장은 0개(plpgsql 기본만).
    - SQLite `schema.sql`은 삭제했다. 원본은 이관 테스트 픽스처(`test/fixtures/sqlite-schema-pre008.sql`)로만 남겼다.
  - ③ **월 파티션·보존** (`src/partitions.js`):
    - 대상: `telemetry`, `alarm_events`, `audit_log` — `PARTITION BY RANGE (ts)` + DEFAULT 파티션, 이름 `<표>_pYYYYMM`(UTC 월초 ms).
    - 기동할 때와 6시간마다 이번 달 + 3개월을 만든다. 두 노드 중 lock을 잡은 쪽만 하고, 다른 쪽은 그 회차를 건너뛴다(테스트).
    - 보존 만료분은 `DETACH` 후 `DROP`한다. 보존은 raw 3년, 이벤트·감사 10년이고 집계 10년은 설정 자리만 있다(Q-08). DEFAULT 파티션의 만료 행도 지운다.
    - DEFAULT에 들어간 행은 그 달 파티션을 만들 때 같은 트랜잭션으로 옮긴다.
      `audit_log`의 append-only 트리거는 이 이동의 DELETE만 허용한다. UPDATE는 그때도 거부한다(테스트).
    - `alarm_events`의 PK는 `(event_id, ts)`다(파티션 키 포함 규칙). 재전송 중복은 이벤트 ingest 트랜잭션의 advisory xact lock + event_id 조회로 막는다.
      SQLite의 `BEGIN IMMEDIATE`와 같은 직렬화다.
    - D-13(WO-INT-012의 FMS 7일 재전송 버퍼) 표는 만들지 않았다. `0002_*.sql` 하나와 `partitions.TABLES` 한 줄로 붙일 수 있게 뒀다.
  - ④ **SQLite → PG 이관** `apps/console/bin/cflex-migrate-sqlite.js`:
    - 옮기는 것: 사용자·설정·collector·장비·크리덴셜(봉인 그대로)·진행 중 유지보수 창·열린 알람(+코멘트·ServiceNow 매핑)·최근 90일 이벤트·감사로그 전부.
    - id를 유지하고 시퀀스를 그 뒤로 옮긴다. 텔레메트리는 옮기지 않는다.
    - `--dry-run`은 같은 트랜잭션을 ROLLBACK하므로 정확한 행 수가 나온다. 재실행하면 0건 추가, 전부 skipped다.
    - 이관 후 콘솔에서 기존 비밀번호 로그인, 열린 알람 목록, 봉인된 community 복호화를 확인했다(테스트).
    - 업그레이드 문서 1줄: `docs/install/CONTAINER_PROFILE.md` §8, 상세는 `PG_BACKUP_RESTORE.md` §5.
  - ⑤ **백업/복구**:
    - `install/scripts/cflex-pg-backup.sh`:
      - `pg_basebackup -X stream -F tar -z --checkpoint=fast` → `/opt/data/backup/base-YYYYMMDD`(완성 표시 `CFLEX_BACKUP_OK`). WAL 아카이브는 `/opt/data/backup/wal`.
      - 14일 지난 세트를 지우되 최신 완성 세트는 지우지 않는다. WAL은 가장 오래 남은 세트보다 앞선 것만 정리한다.
      - 종료 0/1/2, journald + `backup.log`.
    - systemd `cflex-pg-backup.{service,timer}`(매일 02:30, Persistent). 컨테이너는 cflex user 유닛(`podman exec cflex-postgres`), 베어는 system 유닛(User=postgres).
    - `cflex-postgresql.conf` 조각(`wal_level=replica`·`archive_mode=on`·`archive_command`·`archive_timeout=900`)을 렌더한다.
      `cflex-postgres.container`에 `/opt/app-root/src/postgresql-cfg:ro,Z`로 마운트한다.
    - `docs/install/PG_BACKUP_RESTORE.md`: 구성표, 매일 확인할 것, 기준 복구, PITR, SQLite 이관, **SAT 판정 B1~B11**.
  - ⑥ **설치기**:
    - preflight db: `/opt/data` 읽기 전용 마운트면 FAIL, `/opt/data/pgsql`·`backup` 소유·모드 확인, 5432 피어가 app 2대 `/32`만인지.
    - verify app: `app → db 5432`가 WARN에서 **FAIL 기준**으로 바뀌었다. 콘솔 CLI `db-status`로 schema_migrations 버전·이번/다음 달 파티션·WAL 아카이브 실패 수를 본다.
    - verify db: 마지막 백업이 1일 이내면 PASS, 14일 이내면 WARN, 그 밖은 FAIL. `wal_level/archive_mode = replica on`.
    - app.env: `CFLEX_DB_*`, `CFLEX_RETENTION_*`(site.yaml `retention`, 1 미만은 렌더 거부), `CFLEX_DB_PASSWORD_FILE`.
    - app `pg.pass`는 db01 값을 복사하게 했다. 없으면 설치가 멈추고, dry-run에서는 MISSING으로 표시만 한다.
    - db 디렉터리에 `backup/wal`·`bin`·`config/db`를 추가했다. db restart 때 타이머를 enable한다.
    - `run_migrations`는 "cflex-app이 기동 시 적용 / rollback은 schema 유지"를 출력한다(Q-12).
    - bundle: `db/migrations/*.sql`을 복사하고 MANIFEST에 sha256을 남긴다. app 이미지 검사에 `require('pg')`를 추가했다.
    - Containerfile app: `migrations/`·`bin/` COPY, deps 단계에서 `require('pg')` 확인, 이미지 ENV `CONSOLE_DB` 제거.
    - netcheck: app→db 5432는 FW-7(`collector → app 443, app → db 5432, …`)에 이미 있어서 바꾸지 않았다. **방화벽 요청서 v3는 변경하지 않았다** — 같은 세그먼트(10.138.14.66~69) 내부 통신이라 요청서 범위 밖이다.
  - 테스트 (이 세션 실행, 숫자 그대로):
    ```
                                                         Node 22.22.2              Node 20.20.2
    apps/console     npm test (PG 16.14 embedded)        40/40 skip 0              40/40 skip 0   (통합 27 + db 8 + SQLite 이관 5)
                     origin/main 머지 후 재실행           40/40 skip 0              —
    probe-agent      npm test                            79/79 skip 0 (console.e2e 4/4 — 실프로세스 콘솔 → embedded PG)
    packages/notify  npm test                            14 ok + 5/5
    install          node --test install/test/static.test.js    14/14 (기존 13 + PostgreSQL 1)
    install          python3 -m unittest discover -s install/test   76/76 (기존 54 + test_pg 22; test_bundle에 migrations·pg 검사 추가)
    bash -n          install/scripts/cflex-pg-backup.sh  OK (test_pg에서도 실행)
    ```
    - 통합 테스트 기존 27건은 그대로 PG에서 돈다. app01·app02가 같은 PG를 **동시에** open하고, 세션 Redis·SAT 6(app01 중지)·Redis 다운도 포함한다.
      PostgreSQL이 없으면 DB 테스트는 skip으로 이유와 함께 나오고 통과로 세지 않는다.
    - 기존 테스트 1건 수정: `device detail` 24h 버킷 수 `>= 2`를 `1~2`로 바꾸고 1h 버킷 10개 정확 비교를 추가했다.
      10분치 점이 15분 버킷 경계에 따라 1개 버킷이 될 수 있어 약 1/3 확률로 실패하던 기존 비결정 테스트였다.
    - Node 20: better-sqlite3를 ABI 115로 rebuild해 실행하고 22로 되돌렸다(`.runtime/int008/node20.sh`).
  - **미수행 (통과로 치지 않음)**:
    - ① `podman build`·컨테이너 기동(rhel8/postgresql-16이 `postgresql-cfg/` 조각을 읽는지 포함).
    - ② 실제 `pg_basebackup`, 기준 복구·PITR 실행 — SAT 7(`PG_BACKUP_RESTORE.md` §6 B1~B11). 컨테이너 안 로컬 replication 연결 허용 여부(B11)도 미확인.
    - ③ RHEL 8.10 실호스트, 베어 db01 initdb·계정·pg_hba(수동 절차만, Q-10).
    - ④ 실데이터 SQLite 파일 이관(픽스처로만 시험).
    - ⑤ probe-agent·console을 Node 20으로 함께 돌린 E2E(console 단독 Node 20은 수행).
  - 비밀값: 커밋 0. 테스트 비밀번호는 `not-a-secret`·픽스처 값뿐이다. 렌더 산출물에 `PASSWORD=값` 0건(test_render 검사).
    Docker 0, 장비 SET 0, 포털 코드 수정 0, 부록 B 밖 알람 코드 0, `probe-agent/src/buffer.js` 변경 0.
  - 로컬 전용(커밋 안 함): `node_modules`(console·probe-agent·twin), `apps/twin/dist-console`, `.runtime/int008/`, embedded-postgres 바이너리·데이터(테스트 후 삭제). lockfile 없음(`--no-package-lock`).
- 질문: `Q-2026-10-26-08`(집계 표), `-09`(파티션 선행 3개월·6h), `-10`(베어 db 자동화), `-11`(pg 번들), `-12`(롤백 스크립트 대신 추가형 마이그레이션 + 복구), `-13`(이관 원본 경로·범위) — 모두 권고안 (A)로 진행
- 블로커: 없음
- 다음 세션 계획: PR 검토 반영 → WO-INT-013(데이터 사전) 또는 WO-INT-012(D-13 분산 구조, 008 후속) — 관리자 지시 순서

## Codex 블록
### 2026-10-25 — 관리자 초기화
- 기준: cflex-fms-codex/.worktrees/production-data-foundation. WO-PTL-001 배정.

## 관리자 검토 로그
- 2026-10-25: 역할 분리 명세(docs/spec/00·01·02) 배포, 확인서 검토 의견 전달(§0·§7.1·§7.2·§4.3·§4.4), 계약 3종 → 1종 통일 지시.
- 2026-10-25 (2차): WO-INT-001 **완료** 승인(v2 확인서 md·§7.2 복원·§10 역할분리 확인, 174/0 테스트). Q-01 → (A) main 정상화는 WO-INT-000으로 Claude Code 수행. Q-03 → (A) control-mcp 채택(조건부), WO-INT-009 등록. Q-02 → Eric 결정 대기(관리자 의견: 삭제). 프로브 코드(WO-INT-002 forwarder)는 아직 착수 전 — 다음 세션 1순위.
- 2026-10-25 (3차): WO-INT-000 **완료**(origin/main=cbb4f49→7766313). WO-INT-002 **완료** — PR #1 관리자 머지(7766313), 테스트 22/22 관리자 재실행 확인, 비밀값 없음. Q-04=(A) Basic만, Q-05=임시 ID+provisional 표시(계약 v1.1 예정), Q-06=(A) docs/spec/schemas 정본(D-08). 다음: WO-INT-003 진행 지시. 미해결: index.js 실기동 스모크(node_modules 없음) → WO-INT-007에서 같이.
- 2026-10-25 (4차): WO-INT-003 **완료** — PR #2 머지, 테스트 42/42 + notify 6/6 재실행, 비밀값 없음. Q-07=(B) 새 코드 UPS_BATTERY_CAPACITY_LOW(P3), Q-08=계약 v1.1 승격(스키마 태그 1.1). WO-INT-004(Local Console) 진행 지시, WO-INT-004b(v1.1 반영) 등록. 미시험: 실제 HAEA 릴레이/ServiceNow, STARTTLS — 현장 SAT 항목.
- 2026-10-25 (5차): WO-INT-004b **완료**(PR #3, 48/48), WO-INT-004 **완료**(PR #4, console 22/22, CSP self-only·CDN 0, Redis 세션·2인스턴스 페일오버 테스트). Q-09=(B) 내부 콘솔 프로파일 → WO-INT-004c 등록. 한계 기록: app01/02 실분리는 WO-INT-008(PostgreSQL) 선행, XLSX 임포트 미구현(CSV만), 브라우저 실화면 미확인(SAT). 다음: WO-INT-005(RHEL 컨테이너) 기동.
- 2026-10-25 (6차): 사고 기록 — 대화형 세션과 헤드리스 세션이 **한 작업 트리를 공유**해 브랜치가 서로 바뀌고(고아 커밋 7c0b010→복구), control_report가 완료 WO-INT-002를 진행으로 되돌림(가드 추가 97a808d), TASKS 행 재배열(원복, 822207d와 바이트 동일 확인). 데이터 손실 없음. 재발 방지: CLAUDE.md '세션 하나=작업 트리 하나' 규칙. 포털 연동 1단계 작업에 WO-INT-011 번호 부여(검토요청). 실측: cflex.fms.support는 현재 'Review Login' 웹앱만 떠 있고 /api/v1·mTLS 없음 → Codex WO-PTL-001/002가 선행.
- 2026-10-26 (7차): WO-INT-005 PR #5 **머지**(2ab2da9) — 정적 검증만(Podman 없음), 설치기 Python 44/44(관리자 재실행; `test_smtp_banner` 교착은 테스트 서버가 클라이언트 요청을 기다리던 문제 → 서버가 먼저 배너 송신으로 수정 49ef019), probe 52/52·console 22/22, 비밀값 0. 상태 '머지(정적 검증만)', 완료는 SAT(D-11). Q-10=(A) 알림 발송 app 이전, Q-11=(A) app02 Redis replica+promote. WO-INT-004c **진행** 지시(별도 워크트리 `../cflex-fms-wt-int004c`). 대화형 세션은 `wo/INT-portal-integration` 2단계(dea4db4) 진행 중 — 메인 트리 점유, 검토는 다음 회차.

- 2026-10-26 (8차): WO-INT-004c PR #6 **머지**(649622b) — 관리자 재실행 probe 62/62(두 프로세스 E2E 4 포함)·console 27/27·twin 내부 프로파일 빌드 검사 통과·설치기 Python 51/51·static 12/12·notify 5/5, `bash -n` OK, 비밀값 0, Docker 0, 노드 간 8080 0, 장비 SET 0, 역할 침범 없음. 상태 **완료**(Redis replica/promote 실동작·내부 빌드 육안 확인은 SAT, D-11 기준). Q-2026-10-26-01/02/03 모두 **(A)** 권고안 채택. WO-INT-006(SNMP trap 162) **진행** 지시 — TASKS 행에 포트 1162·콘솔 인벤토리 매핑·기존 분류 엔진 경유·중복 억제·부록 B 밖 코드 금지를 명시, 워크트리 `../cflex-fms-wt-int006`. 머지된 004c/005 워크트리 정리. Codex: 진척 없음(마지막 커밋 a8b097c 10-25 09:25) → codex 워크트리에 `docs/control/TASKS.md`(WO-PTL-001/002 완료 기준 구체화, cflex-portal-check 기준) + AGENTS.md 지시 커밋(1173d7a, push 안 함) — **실행은 법인장**. 대화형 세션 `wo/INT-portal-integration`(1805359)은 메인 트리 점유 중, 검토는 PR 생성 후.
- 2026-10-26 (9차): WO-INT-006 PR #7 **검토 통과(PM approved, 머지 대기)** — 관리자 재실행 probe 74/74(trap.test.js 12 포함: 실 UDP v1/v2c/v3 authPriv 15건·폴링+trap 동일 alarm_id·commLost 30분·latched·유지보수 창)·console 25 pass/2 skip(dist-console 없음, 무관)·설치기 Python 51/51, 비밀값 0(테스트 픽스처만), Docker 0, 장비 SET 0, 역할 침범 없음, 엔진 변경 최소(latched/clear/isOpen). **머지는 이 PM 세션의 도구 권한(자동 머지 차단)으로 실행 못 함** → 법인장이 PR #7 머지 버튼 1회, 또는 다음 회차 재시도. PR에 리뷰 코멘트 기록. Q-2026-10-26-04/05/06 → 모두 **(A)** 채택(기록은 PR #7 머지 후 DECISIONS에 적음 — 충돌 회피): 04 SNMP_TRAP_UNKNOWN 기록만, 05 환경·NetBotz·PDU 코드는 계약 v1.2 결정 후 별도 WO(법인장 판단 필요: HAEA에 도어·누수·PDU 알람을 줄지), 06 MIB 대조는 SAT 체크리스트. TASKS WO-INT-006 행·WO-INT-007 행 갱신도 PR #7 머지 후(인접 행 충돌 회피). WO-INT-007(Node 20 검증 + better-sqlite3 prebuild/node:sqlite 폴백 정리 + index.js 실기동 스모크) **진행** 지시 — 워크트리 `../cflex-fms-wt-int007`, base main 0a398e6; 이 Mac은 Node 22만 있어 Node 20은 `npx -y node@20`으로 실행. Codex: 진척 없음(법인장 실행 대기).
- 2026-10-26 (Eric 지시): D-12 Probe 범위 동결 — 내부는 현재 개발 수준 유지, 알림 엔진은 포털. 004c 범위 축소(ServiceNow 최소만). 다음 회차부터 포털(Codex WO-PTL-001/002) 지시 구체화가 1순위.
- 2026-10-26 (Eric 지시 2): D-12a — Probe는 수집·표시만, 알림 처리 전부 포털. 004c는 이미 머지됨(PR #6) → 콘솔의 로컬 알림 발송 코드는 **기본 비활성**으로 두고 추가 개발 금지. WO-INT-006 PR #7 관리자 머지 완료(review 9 승인분). 내부 Probe는 007·008 후 기능 완료 선언, 이후 포털(Codex) 1순위.
- 2026-10-26 (Eric 지시 3): D-13 분산 구조 확정 — 컬렉터 N대(수집만, 외부 경로 0) → FMS(표시·취합·포털 송신) → 포털. HAEA 1차는 컬렉터 1대. WO-INT-012 등록(007·008 이후).
- 2026-10-26 (10차): WO-INT-007 PR #8 **머지**(2fae9fe) — 브랜치 base가 PR #7 이전(5e2e954)이라 control 문서 3종 충돌 → PM이 origin/main을 브랜치에 머지(337491c, TASKS는 main 채택·STATUS/DECISIONS 양쪽 보존) 후 머지. 관리자 재실행: probe 67/67(브랜치)·**79/79(main 머지 후, trap 12 + smoke 5 포함)**·console 27/27·static 13/13·설치기 Python 54/54, 비밀값 0(스모크 토큰은 더미), Docker 0, 장비 SET 0, 포털 코드 침범 0. Node 20 로그는 에이전트 `.runtime/int007/results-v20.20.2.txt`로 확인(관리자 트리는 ABI 127이라 Node 20 재실행 불가 — 설계 의도와 일치). 상태 **완료**(UBI8 소스 빌드·번들 ABI 검사 실동작은 SAT). Q-2026-10-26-04/05/06/07 → 모두 **(A)** DECISIONS에 기록(05는 계약 v1.2 코드 결정 시 WO-INT-012의 v1.2와 묶음 — 법인장 반대 시 변경). WO-INT-008(PostgreSQL 16) **진행** 지시 — 워크트리 `../cflex-fms-wt-int008`, base main 2fae9fe. 007 워크트리 정리. Codex: 코드 진척 없음(마지막 a8b097c 10-25 09:25); 지시 커밋 fe16f24(10-26 07:23, 명세 03·WO-PTL-008~010) 있음 — 실행은 법인장. 대화형 `wo/INT-portal-integration`(bff4faf) PR 미생성, 검토 보류.
- 2026-10-26 (11차): WO-INT-008 PR #9 **머지**(7ef9701) — 관리자 재실행 console 40/40(embedded PG 16.14: 통합 27·db 8·SQLite 이관 5)·probe 79/79·static 14/14·설치기 Python 76/76·notify 5/5, `bash -n` OK, 비밀값 0, Docker 0, 장비 SET 0, 역할 침범 0, 수량 혼용 0, 방화벽 요청서 v3 변경 0(app→db 5432는 FW-7 기존). 동작 변경 1건(credentials UNIQUE NULLS NOT DISTINCT)은 버그 수정으로 승인. 상태 **완료**(실 백업/PITR·podman 기동·베어 db01은 SAT). Q-2026-10-26-08~13 → 모두 **(A)** 채택(12: 추가형 마이그레이션 + 복구 문서로 명세 §3.3 롤백 요건 충족 — 공학 판단; 13: 이관 기본 경로 `/opt/app/cflex/data/console.db`). **내부 Probe 기능 완료 선언(D-12a: 007·008 종료)** — 이후 Claude Code는 WO-INT-013(데이터 사전, 코드 변경 0) → WO-INT-012(D-13) 순. WO-INT-013 **진행** 지시(워크트리 `../cflex-fms-wt-int013`, base 7ef9701). 008 워크트리 정리. Codex: 코드 진척 없음(마지막 a8b097c 10-25 09:25; 지시 커밋 1173d7a·fe16f24 대기) — 실행은 법인장. 대화형 `wo/INT-portal-integration`(6efd50b, WO-INT-004 콘솔 접두사 격리 작업) PR 미생성, 검토 보류.
