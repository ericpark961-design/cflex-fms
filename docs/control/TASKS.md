# 작업지시서 (TASKS) — 관리자: Cowork Claude · 갱신 2026-10-26 (PM 검토 8차)

상태: `대기` → `진행` → `검토요청` → `완료` / `보류`. 에이전트는 `대기/진행`만 집어 간다. `검토요청`은 관리자가 확인 후 `완료` 처리한다.
완료 기준(Acceptance)은 전부 충족해야 한다. 테스트 명령이 적힌 항목은 결과를 STATUS에 붙인다.

## A. Claude Code — 내부 (WO-INT)

| 우선 | ID | 상태 | 작업 | 완료 기준 |
|---|---|---|---|---|
| 0 | WO-INT-000 | 완료 | **Git 정리** — `main`이 17커밋 뒤처져 있음. `feat/twin-rack-elevation`(현재 HEAD, [CTRL] 포함)을 `main`에 fast-forward 머지하고 `git push origin main`. 이후 모든 작업은 `wo/*` 브랜치 + PR. (PM 세션은 SSH 키가 없어 push 불가 — Claude Code가 수행) | `origin/main == HEAD`, `gh pr list` 동작 확인, STATUS에 기록 |
| 1 | WO-INT-001 | 완료 | **확인서·현재상태 문서 정정** — 확인서 §0·§7.1·§7.2·§4.3·§4.4를 docs/spec/00·01 기준으로 수정(내부 = Probe + Local Console + 로컬 알림; 알람 1차 분류는 내부, 라우팅은 포털; 계약은 00 하나; 업그레이드 pull은 cflex.fms.support:443 경유, 자동 적용 아님; WireGuard 보류). §5는 1·2·7 권고 채택. `docs/handoff/HAEA_CURRENT_STATE.md` §10 분담을 역할 분리로 갱신 | 수정본이 `docs/handoff/`에 md로 커밋(아티팩트 링크 아님), 잘린 §7.2 복원, 관리자 검토요청 |
| 2 | WO-INT-002 | 완료 | **Forwarder를 계약서 00으로 교체** — `probe-agent/src/forwarder.js`: 목적지 `https://cflex.fms.support/api/v1/*`, mTLS 장치 인증서(키 파일 경로 설정), `X-CFlex-Tenant/Node`, `Idempotency-Key`, 지수 백오프·429 처리, `HTTPS_PROXY`(인증 프록시 포함) 에이전트, heartbeat 60s, 스키마 화이트리스트(계약 §5). 기존 `/v1/probe/event` 경로는 설정으로만 남김(기본 off) | `docs/spec/schemas/*.json`(계약 부록 C) 생성 + 전송 payload 스키마 검증 테스트, 프록시 경유 테스트(로컬 프록시 더미), Codex 목 서버(`/_mock`) 또는 자체 목으로 E2E 1회 통과 |
| 3 | WO-INT-003 | 완료 | **알람 1차 분류 + 로컬 알림** — 계약 부록 B 코드 사전으로 P1–P4 분류(중복 억제·플래핑 방지·유지보수 모드), `packages/notify`로 SMTP(HAEA 릴레이)·ServiceNow(생성/업데이트/종료, alarm_id↔INC 저장) 발송, 결과를 이벤트 `local_notified`에 포함. **테스트 티켓 버튼/명령**(SOW 수락 기준) | 단위 테스트(분류·억제), ServiceNow 더미 서버 E2E, `local_notified` 필드가 events payload에 들어가는 계약 테스트 |
| 4 | WO-INT-004 | 완료 | **Local Console 범위 확정 구현** — 기존 UI 유지, nginx 443 뒤 `0.0.0.0` 바인딩(127.0.0.1 전용 해제), 로컬 계정+역할 3종, 알람 목록/상세/ACK, 장비 현황/트렌드, 설정. 기능 추가 금지 | app01/app02 동일 이미지로 기동, 세션 Redis, 통합 테스트 통과, 외부 CDN 호출 0건 |
| 5 | WO-INT-005 | 머지(정적 검증만) | **RHEL 설치 — 컨테이너 프로파일** — `images/collector/Containerfile`(ubi8/nodejs-20), `images/app`, `images/web`, Quadlet 템플릿, `cflex-install --role --profile container` preflight/verify/netcheck, `install.sh` RHEL 전용으로 교체(apt/nodesource 제거), SELinux `:Z`, trap 162 포트 처리 | RHEL 8.10 컨테이너(또는 UBI8)에서 Node 20으로 테스트 통과, `podman build` 성공, `netcheck`가 방화벽 요청서 v3와 1:1 일치 출력. **관리자 메모(2026-10-26):** PR #5 머지(2ab2da9). Mac에 Podman 없음 → podman build·컨테이너 기동·UBI8 Node20 미검증. 정적 테스트 11/11, 설치기 Python 44/44(관리자 재실행, 테스트 1건 교착 수정), probe 52/52, console 22/22. **완료 처리는 RHEL/UBI 호스트에서 SAT 때.** |
| 6 | WO-INT-006 | 검토요청 | **SNMP trap 리스너 UDP 162** (v1/v2c/v3, APC MIB 매핑 → 이벤트) — probe-agent 안에 리스너(`src/trap/`), 기본 바인드 포트는 WO-INT-005 결정대로 **1162**(firewalld 162→1162 forward, 설정 `CFLEX_TRAP_PORT`). 발신 IP→장비 매핑은 콘솔 인벤토리(WO-INT-004c client)로, v3 사용자/키·v2c community는 콘솔 SNMP 크리덴셜 재사용. APC PowerNet MIB trap OID(최소 UPS onBattery/offBattery/lowBattery/commLost/overload/온도·습도/NetBotz 도어·누수/PDU 분기 과전류) → 계약 부록 B 코드 → **기존 분류 엔진**(WO-INT-003)으로 들어가 폴링 알람과 같은 alarm_id로 중복 억제. 모르는 trap은 `SNMP_TRAP_UNKNOWN`(P4)로 기록만. 장비 쓰기(SET) 없음, 새 알람 코드 추가 금지(부록 B 밖이면 DECISIONS에 Q) | 시뮬레이터(`sim/sim-trap.js`) trap 10종 수신·분류 테스트, v1/v2c/v3 각 1건 이상, 폴링 알람과 trap 동일 장애의 중복 억제 테스트, `npm test` 전체 통과, STATUS 보고 |
| 7 | WO-INT-007 | 대기 | **Node 20 검증 + better-sqlite3 prebuild / `node:sqlite` 폴백 제거** | Node 20.x에서 전체 테스트 통과 로그 |
| 8 | WO-INT-008 | 대기 | **PostgreSQL 16 전환(Local Console 저장소)** — 월 파티션, 보존, 백업 스크립트. Collector 버퍼는 SQLite 유지 | 마이그레이션 + 통합 테스트, 백업/복구 리허설 문서 |
| 9 | WO-INT-009 | 대기 | **control-mcp 정식화** (Q-03 채택) — `tools/control-mcp` README에 설치·신분(CFLEX_AGENT) 설정, Codex 워크트리 AGENTS.md에 연결 방법 추가, 왕복 테스트를 CI에 포함. WO-INT-002보다 뒤 | Codex가 같은 서버로 STATUS 보고 1회 성공, 테스트 통과 |
| 4b | WO-INT-004b | 완료 | **계약 v1.1 반영 소작업** — `UPS_BATTERY_CAPACITY_LOW` 매핑(60%/2h 억제), 계약 테스트 버전 검사 1.1, 열린 알람 상태를 재시작 후에도 유지(파일/SQLite) | 테스트 통과, STATUS 보고 |
| 4c | WO-INT-004c | 완료 | **내부 콘솔 프로파일** (Q-09=(B)) — `CONSOLE_PROFILE=internal` 빌드에서 포털 범위 화면(3D·NOC·파워체인·지도·Copilot) 숨김(코드 삭제 금지), 메뉴/라우트/API 노출 제거, 빌드 검사 테스트. probe-agent → 콘솔 collector API 실제 연동(인벤토리 pull·이벤트 push) 포함. **Q-10=(A) 반영:** 로컬 알림(SMTP/Teams/ServiceNow) 발송을 Collector에서 **app(Local Console)** 으로 이전 — Collector는 이벤트를 콘솔 collector API(443)로만 보내고 콘솔이 발송(`local_notified` 결과는 콘솔→collector 응답으로 회수해 포털 events에 실어 보냄), 베어용 nginx 노드 간 8080 → 443. **Q-11=(A) 반영:** app02 Redis replica(6379) + 설치기 `promote` 명령·문서 | 내부 빌드에 포털 화면 라우트 0, 테스트 통과, probe-agent↔콘솔 E2E 1회. **관리자 메모(2026-10-26):** PR #6 머지(649622b). 관리자 재실행 probe 62/62(E2E 4 포함)·console 27/27·twin 프로파일 빌드 검사 통과·설치기 Python 51/51·static 12/12·notify 5/5, 비밀값 0, 노드 간 8080 0, 장비 쓰기 0. Q-01/02/03=(A). **Redis replica·promote 실동작과 내부 빌드 육안 확인은 SAT 항목**(D-11과 같은 기준). |
| 11 | WO-INT-011 | 검토요청 | **포털 연동 1단계** (Eric 직접 지시, 사후 번호 부여) — `bin/cflex-csr.js`(장치 CSR, 키 노드 밖 불출), `bin/cflex-portal-check.js`(DNS/TCP/TLS/mTLS/API/버전/목 판정 — spec 01 §3.3 verify의 포털 절반), `docs/handoff/PORTAL_INTEGRATION_REQUIREMENTS.md`(포털이 켜야 할 6개 + nginx mTLS 설정), control-mcp 파서 충실성·완료 재개 금지 수정. 브랜치 `wo/INT-portal-integration` | 테스트(probe-agent 58/58, control-mcp 30/30) 관리자 재실행, PR, 실측 결과(3 FAIL: mTLS/CERT/API)가 Codex WO-PTL-001/002 입력으로 전달 |
| 10 | WO-INT-010 | 대기 | **운영 DB 시뮬레이터 장비 4대 삭제** (Q-02 승인) — PDU·NetBotz·CRAC·스위치 시뮬 장비와 그 메트릭/알람 행. 사전 백업(export) → 삭제 스크립트 커밋 → 삭제 전후 행 수 STATUS 기록. `probe-agent/sim/` 코드는 유지. 운영 DB 접근은 이 WO에 한해 허용, 다른 데이터는 건드리지 않음 | 백업 파일 존재, 전후 행 수 보고, S1 '샘플 데이터 제거' 항목 닫힘 |

## B. Codex — 포털 (WO-PTL)

| 우선 | ID | 상태 | 작업 | 완료 기준 |
|---|---|---|---|---|
| 1 | WO-PTL-001 | 진행 | **Ingest를 계약서 00으로 수렴** — `/api/v1/{heartbeat,inventory,telemetry,events,files,commands,config}`, 멱등 캐시, 429, 버전 헤더, 테넌트 격리. 기존 `/probe/v1/*` Bearer 경로는 호환 레이어로 유지하되 기본은 계약 경로 | cflex-fms `docs/spec/schemas/*.json`(D-08)으로 수신 검증 테스트, `/_mock` 목 서버(테넌트 TEST) 기동 문서, Probe E2E(probe-agent/test/forwarder.e2e.test.js)를 `/_mock` 대상으로 1회 통과 |
| 2 | WO-PTL-002 | 대기 | **mTLS 장치 인증** — 사설 CA(오프라인 루트+중간), 노드 인증서 발급·폐기·`cert_renew` 명령, 401 동작 | CSR→발급→접속→폐기 E2E 테스트 |
| 3 | WO-PTL-003 | 대기 | **알람 라우팅·에스컬레이션 엔진** — 테넌트/사이트/심각도 정책, 지정 담당자+당직, e-mail/SMS/Teams, ACK·단계 에스컬레이션, `local_notified` 중복 억제, PROBE_OFFLINE(heartbeat 5분) | 정책 테스트 + 더미 채널 E2E |
| 4 | WO-PTL-004 | 대기 | **NOC 콘솔 최소 기능** — 테넌트 보드, 알람 큐, Probe 헬스, 명령 발행 6종 | 화면 + 권한 테스트 |
| 5 | WO-PTL-005 | 대기 | **이미지 레지스트리를 cflex.fms.support:443 뒤에** (Probe 아웃바운드 풀용, 서명 검증) | `podman pull` 서명 검증 E2E |
| 6 | WO-PTL-006 | 대기 | 월간 Executive Report + 라이프사이클 예산표(HAEA 시드) | PDF/XLSX 생성 테스트 |
| 7 | WO-PTL-007 | 대기 | PM 디지털화 + 3D 평면도 이식 (apps/twin → 포털) | 02 §6·§7 수락 항목 |

## C. 보류 / 결정 대기
- WireGuard(Probe 발신 VPN) — HAEA 방화벽 양식 C 결과 후 결정
- SMS 게이트웨이 — 포털 WO-PTL-003에서 처리, Probe 범위 아님
- keepalived VIP — HAEA 회신 대기(docs/spec/01 §6-2)
