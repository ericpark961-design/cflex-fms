# C-Flex FMS 2.x — Probe ↔ Managed Service Portal 인터페이스 계약 v1.0

- 문서번호: IFC-CFLEX-2026-1023 v1.0 — **양쪽 팀(Claude Code = 내부 Probe/On-Prem, Codex = 외부 Portal)이 공유하는 유일한 계약서.** 변경은 반드시 이 문서의 버전을 올리고 양쪽에 동시에 반영한다.
- 원칙: **Probe가 항상 먼저 연결한다(아웃바운드 전용).** Portal은 Probe로 인바운드 연결을 열지 않는다. Portal → Probe 방향의 요청은 Probe가 폴링하는 "command queue"로만 전달한다.

---

## 1. 전송·보안
| 항목 | 값 |
|---|---|
| 엔드포인트 | `https://cflex.fms.support` (공인 IP 40.114.79.164, static). 경로 prefix `/api/v1` |
| 전송 | HTTPS, TLS 1.2+ (1.3 권장), HTTP/1.1 (프록시 호환), gzip 요청 본문 허용(`Content-Encoding: gzip`) |
| 인증 | **mTLS 장치 인증서**(Probe/App 노드별 1장, RingOn 사설 CA 발급, 2년 유효, CN=`<tenant>.<node-id>`) + 헤더 `X-CFlex-Tenant: HAEA` + `X-CFlex-Node: cap01` . 인증서 만료 60일 전 Portal이 갱신 명령(§6) 발행 |
| 프록시 | Probe는 `HTTPS_PROXY`(basic/NTLM 인증 포함) 지원, 프록시 CA 신뢰 추가 가능. Portal은 프록시 뒤 Probe를 전제(Keep-Alive 짧게, 요청당 ≤ 5 MB) |
| 시간 | 모든 타임스탬프 **UTC ISO-8601 밀리초**(`2026-10-23T18:05:12.345Z`). Probe는 NTP 동기; Portal은 `Date` 응답 헤더로 drift 보고, 60초 초과 시 Probe가 경고 이벤트 생성 |
| 멱등성 | 모든 POST는 `Idempotency-Key`(UUIDv4) 헤더 필수. Portal은 24시간 내 동일 키 재수신 시 200 + 동일 응답 |
| 재시도 | 5xx/네트워크 오류: 지수 백오프 1s→2s→…→최대 5분, 지터 ±20%. 4xx는 재시도 금지(409 제외). Probe 로컬 큐 보존 기본 7일 |
| 레이트 | 노드당 60 req/min. 초과 시 429 + `Retry-After` |
| 버전 | 경로 `/api/v1`; 응답 헤더 `X-CFlex-API-Version: 1.0`. 하위호환 변경은 minor, 비호환은 `/api/v2` |
| 응답 포맷 | JSON. 오류: `{ "error": { "code": "string", "message": "string", "details": {} } }` |

## 2. 공통 식별자
- `tenant` : 고객 코드 (`HAEA`). Portal 발급, 불변.
- `site_id` : 테넌트 내 사이트 코드 (`HMA-FV`, `KUS-IRV`, `HAEA-HQ`).
- `device_id` : **Probe가 생성하는 안정 ID** = `sha1(tenant|site_id|serial)[:16]`. 시리얼 변경 시 새 device_id + `replaced_by` 링크.
- `node_id` : Probe/App 노드 (`cap01`, `app01`).
- `alarm_id` : Probe 생성 UUID, 알람 생애(raise→update→clear) 동안 불변.

## 3. 엔드포인트 (Probe → Portal)

### 3.1 `POST /api/v1/heartbeat`  (매 60초, 노드별)
```json
{ "node_id":"cap01","role":"collector","version":"2.1.0","uptime_s":86400,
  "queue_depth":0,"last_poll_ok_ratio":0.998,"devices_total":48,"devices_unreachable":1,
  "clock":"2026-10-23T18:05:12.345Z","profile":"container|bare","os":"RHEL 8.10" }
```
응답 200 `{ "ack":true, "commands_pending": 2, "config_version": 17 }`

### 3.2 `PUT /api/v1/inventory`  (변경 시 + 일 1회 전체)
```json
{ "full":true, "devices":[ { "device_id":"3f9c…","site_id":"HMA-FV","label":"MPOE UPS 1E-A",
   "vendor":"APC","model":"SYAF16KRMT","serial":"AD2248220154","serial_alt":["5D2249T04846"],
   "nmc_ip":"10.112.5.34","location":{"building":"HMA FV","floor":"1E","room":"IE Info Room","rack":"4"},
   "in_sow":true,"mfg_date":"2022-11","mfg_date_source":"serial|nmc|manual","firmware":"…",
   "battery":{"installed":"2022-11","due":"2027-05","strings":4},"tags":["symmetra"] } ] }
```
응답 200 `{ "accepted":48, "rejected":[{"device_id":"…","reason":"duplicate_serial"}] }`

### 3.3 `POST /api/v1/telemetry`  (배치, 기본 60초마다 또는 500포인트)
```json
{ "node_id":"cap01","points":[ { "device_id":"3f9c…","ts":"2026-10-23T18:05:00.000Z",
   "m":{ "in_v":[124.5,121.9],"out_v":[120.2,119.4],"out_a":[20,19],"load_pct":37,"load_kw":4.7,
         "bat_pct":100,"runtime_s":1500,"bat_temp_c":21.0,"bat_v":138,"status":"online|on_battery|bypass|off",
         "selftest":"ok|fail|none","alarm_bits":"0x0000" } } ] }
```
- 메트릭 키는 **부록 A 메트릭 사전**에 등록된 것만. 미등록 키는 Portal이 `m_ext`로 보관하고 경고.
- 응답 200 `{ "accepted":500, "dropped":0 }`

### 3.4 `POST /api/v1/events`  (알람·이벤트, 즉시 전송)
```json
{ "events":[ { "event_id":"uuid","alarm_id":"uuid","device_id":"3f9c…","site_id":"HMA-FV",
   "ts":"2026-10-23T18:05:12.345Z","kind":"alarm_raise|alarm_update|alarm_clear|info",
   "severity":"P1|P2|P3|P4","code":"UPS_ON_BATTERY","title":"UPS on battery",
   "detail":{"runtime_s":420,"bat_pct":62},"source":"trap|poll|rule|system",
   "local_notified":{"email":true,"teams":false,"itsm":"INC0012345"} } ] }
```
- `code`는 **부록 B 알람 코드 사전**(Probe 룰엔진이 분류). Portal은 코드 기준으로 라우팅/에스컬레이션.
- `local_notified`: Probe가 HAEA 내부(SMTP/Teams/ServiceNow)로 이미 보낸 알림 — Portal의 **중복 발송 억제** 입력.
- 응답 200 `{ "accepted":1, "routing":[{"alarm_id":"uuid","policy":"HAEA-P1","notified":3}] }`

### 3.5 `POST /api/v1/files`  (multipart; PM 리포트 PDF·사진·로그 번들, ≤ 25 MB)
필드: `kind=pm_report|photo|log|config_backup`, `device_id?`, `site_id`, `ts`, `sha256`, `file`. 응답 `{ "file_id":"…" }`

### 3.6 `GET /api/v1/commands?node_id=cap01`  (heartbeat에서 `commands_pending>0`일 때)
응답:
```json
{ "commands":[ { "cmd_id":"uuid","type":"config_update|cert_renew|request_inventory|poll_now|set_maintenance|collect_diag",
   "issued":"…","expires":"…","payload":{ "config_version":18,"config":{…} } } ] }
```
Probe는 실행 후 `POST /api/v1/commands/{cmd_id}/result` `{ "status":"ok|failed|rejected","detail":{} }`.
**허용 명령은 위 6종으로 고정**(원격 셸·임의 스크립트 금지 — HAEA Security 설명용).

### 3.7 `GET /api/v1/config?node_id=cap01&since=17`
Portal이 관리하는 **선택적** 중앙 설정(알람 임계치, 폴링 주기, 유지보수 창). Probe 로컬 `site.yaml`이 우선순위 높음(로컬 override), 충돌 시 Probe가 `config_conflict` 이벤트.

## 4. Portal → Probe 방향으로 필요한 것은 전부 §3.6 명령 큐로만
라우팅 결과·ACK·티켓 번호를 Probe 로컬 콘솔에 표시하려면 Probe가 `GET /api/v1/alarms/{alarm_id}/status` 로 조회(선택 기능, 인터넷 불가 시 비활성).

## 5. 데이터 최소화 (HAEA Security 약속과 동일)
전송 허용 필드 = 이 문서 §3의 스키마 전부. **사용자 계정·이메일·이름·IP(사용자) 금지.** 지정 담당자 연락처는 Portal에서 RingOn이 관리(Probe는 모름). Probe는 전송 전 스키마 화이트리스트로 필터링하고, 차단된 키를 로컬 로그에 카운트.

## 6. 인증서 수명주기
1. 설치 시 Probe가 CSR 생성(키는 노드 밖으로 나가지 않음) → 설치 엔지니어가 CSR을 Portal에 등록 → 서명된 인증서를 설치기에 투입(오프라인) 또는 `cert_renew` 명령으로 온라인 교체.
2. Portal은 노드별 인증서 상태(만료·폐기) 관리, 폐기 시 즉시 401.

## 7. 호환성 테스트 (양 팀 공통 CI)
- 이 문서의 JSON Schema(`schemas/*.json`, 부록 C에 파일명)로 **계약 테스트**: Probe 측은 생성 payload 검증, Portal 측은 수신 검증. 스키마 파일은 공용 레포 `cflex-contract`에 두고 두 팀이 서브모듈로 참조.
- Portal은 `https://cflex.fms.support/api/v1/_mock` 네임스페이스로 **목 서버**를 제공(Probe 개발·SAT용, 테넌트 `TEST`).

## 부록 A. 메트릭 사전 (v1)
`in_v[]` V, `in_a[]` A, `in_hz` Hz, `out_v[]` V, `out_a[]` A, `out_hz` Hz, `load_pct` %, `load_kva`, `load_kw`, `bat_pct` %, `bat_v` V, `bat_a` A, `bat_temp_c` °C, `runtime_s` s, `status` enum, `bypass` bool, `selftest` enum, `selftest_ts`, `alarm_bits` hex, `int_temp_c`, `fan_ok` bool, `bat_replace_flag` bool, `bat_installed` YYYY-MM, `bat_due` YYYY-MM, `fw` string, `comm_ok` bool, `poll_latency_ms`.

## 부록 B. 알람 코드 사전 (v1, 기본 심각도)
P1: `UPS_ON_BATTERY`, `UPS_LOW_BATTERY`, `UPS_OUTPUT_OFF`, `UPS_BATTERY_FAILED`, `UPS_OVERLOAD_SHUTDOWN_IMMINENT` · P2: `UPS_OVERLOAD`, `UPS_ON_BYPASS`, `UPS_HIGH_TEMP`, `UPS_BATTERY_REPLACE`, `UPS_FAN_FAIL`, `COLLECTOR_DOWN` · P3: `UPS_SELFTEST_FAIL`, `UPS_COMM_LOST`(30분), `UPS_RUNTIME_LOW_WARN`, `PORTAL_LINK_DOWN` · P4: `UPS_SELFTEST_OK`, `UPS_RETURN_FROM_BATTERY`, `UPS_CONFIG_CHANGED`, `BATTERY_EOL_90D`, `CLOCK_DRIFT`, `CONFIG_CONFLICT`. 사이트별 심각도 오버라이드는 Portal 정책.

## 부록 C. 스키마 파일
`heartbeat.schema.json`, `inventory.schema.json`, `telemetry.schema.json`, `events.schema.json`, `files.schema.json`, `commands.schema.json`, `config.schema.json`, `error.schema.json` — 모두 JSON Schema draft 2020-12, 이 문서와 동일 버전 태그.
