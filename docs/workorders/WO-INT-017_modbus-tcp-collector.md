# 작업 지시서: WO-INT-017(가칭) — Probe Modbus TCP 수집기

> 본 문서는 Claude Code(내부 Probe 담당)에 전달하는 개발 작업 지시서입니다.
> 대상: `cflex-fms` 저장소 `probe-agent/` · 첫 적용 현장: KMX CCR (Stulz 항온항습기 3대, 소방 접점)
> 작성: 관리자(Cowork Claude) · 2026-11-20 · 상태: **초안 — 법인장 승인 후 `docs/control/TASKS.md`에 등록**
> 번호는 가칭입니다. 015·016이 사후 번호 부여 대기 중이므로 등록 시 확정합니다.

---

## 1. 왜 하는가

운영 프로브(`probe-agent`)는 SNMP만 읽는다. `README.md`는 "SNMP/Modbus/REST"라고 적고 있지만 `src/`에 Modbus 코드는 없고, `pollers/crac.js`는 Liebert iCOM SNMP 외의 프로토콜에 `unsupported`를 돌려준다.

KMX CCR은 이 상태로는 두 가지를 읽지 못한다.

- **Stulz 항온항습기 3대.** 컨트롤러가 내주는 통신은 Modbus(TCP 직접, 또는 RS-485를 게이트웨이로 TCP 변환)가 유력하다. 현재 `crac.js`의 iCOM OID는 Stulz에 맞지 않는다.
- **FM-200 소방 패널과 연기감지기.** 패널 릴레이 건접점을 Modbus TCP I/O 모듈로 받는 설계다(설치 계획서 IP-KMX-2026-1110 §3).

Modbus TCP 읽기 코드 자체는 Codex 저장소에 이미 있다(`cflex-fms-codex/services/probe/collectors/modbus.mjs`, 커밋 53b8c00, 2026-10-11). 다만 로컬 JSON만 출력하고 운영 프로브의 수집 주기·forwarder·콘솔과 연결되어 있지 않다(`DEVICE_INTEGRATIONS.md`가 그렇게 명시). 이 WO는 그 기능을 운영 프로브의 수집기 구조 안에 정식으로 넣는다.

KMX 일정상 **개발 코드와 격리 시험은 2026-12-04(설계 승인일)까지** 끝나야 1월 11~22일 현장 설치에 쓸 수 있다.

## 2. 범위

### 포함

1. Modbus TCP 읽기 클라이언트 (`probe-agent/src/services/modbus-read.js`)
2. 레지스터 맵 프로파일 형식과 로더 (`probe-agent/profiles/modbus/*.json`, `src/services/modbus-profiles.js`)
3. 항온항습기 Modbus 수집 경로 (`src/pollers/crac-modbus.js`, `crac.js`의 프로토콜 분기)
4. 접점 입력 모듈 수집기 (`src/pollers/dio.js`, 장비 종류 `dio`)
5. Modbus TCP 시뮬레이터 (`probe-agent/sim/sim-modbus.js`)
6. 단위·통합 시험 (`probe-agent/test/modbus.test.js`, 기존 E2E에 1건 추가)
7. 문서: `probe-agent/README.md`, `docs/knowledge/PROBE_DATA_DICTIONARY.md` Modbus 절, 설치기 `netcheck` 표에 TCP 502 행

### 제외 (이 WO에서 하지 않는다)

- **쓰기.** Function code 5, 6, 15, 16, 22, 23은 요청 생성 단계에서 거부한다. 장비 설정을 바꾸는 경로는 만들지 않는다(D-12a: Probe는 수집하고 보여주는 것만 한다).
- **Modbus RTU 직결(시리얼 포트).** RS-485 장비는 RTU→TCP 게이트웨이 뒤에서 unit ID로 읽는다. 프로브 VM에 시리얼 장치를 붙이지 않는다.
- **BACnet.** 지금처럼 `unsupported`를 유지한다.
- **새 알람 코드.** 계약 00 부록 B에 항온항습기·소방·환경 코드가 없다(Q-2026-10-26-05 답 (A)). 이 WO는 값을 수집해 `metrics` 이벤트로 올리는 데까지다. 알람은 §8의 결정 후 별도 WO.
- **화면 추가.** Local Console은 기존 장비 현황·트렌드 화면에 값이 나오는지만 확인한다.
- **Codex 소유 경로 수정.** `cflex-fms-codex/**`는 읽기 참고만 한다.
- **실장비 접속.** 시뮬레이터로만 시험한다. KMX 장비 IP에 패킷을 보내지 않는다.

## 3. 설계 지시

### 3.1 읽기 클라이언트 `services/modbus-read.js`

Codex의 `modbus.mjs`를 참고해 CommonJS로 다시 작성한다. **npm 의존성을 추가하지 않는다**(`node:net`만 사용). RHEL Satellite 환경에서 외부 패키지 추가는 보안 심의 대상이다.

- 허용 function code: **1(coil), 2(discrete input), 3(holding), 4(input)**. Codex 코드는 3·4만 지원하므로 1·2를 추가한다. 접점 모듈이 DI를 coil/discrete로 내주기 때문이다.
- 요청 한 건의 한도: 레지스터 125개, 비트 2000개. 넘으면 나눠서 보낸다.
- 응답 검증: transaction ID, protocol ID 0, unit ID, 길이, function code, byte count. 하나라도 어긋나면 값을 버리고 오류로 처리한다.
- 예외 응답(function | 0x80)은 코드별 문구로 돌려준다: 01 지원하지 않는 기능, 02 없는 주소, 03 잘못된 값, 04 장비 고장, 06 장비 사용 중, 0A·0B 게이트웨이 경로 없음/대상 무응답. 02는 "레지스터 맵이 이 모델과 다르다"는 뜻이므로 통신 장애와 구분해 보고한다.
- 타임아웃 기본 3000 ms, 재시도 1회. 환경변수 `MODBUS_TIMEOUT_MS`, `MODBUS_RETRIES`, `MODBUS_PORT`(기본 502)를 `config.js`의 `modbus` 블록으로 추가한다.
- **호스트당 연결 1개, 요청은 순차.** 컨트롤러와 게이트웨이는 동시 세션을 1~2개만 받는 경우가 많다. 같은 host:port를 쓰는 장비(게이트웨이 뒤 unit ID 여러 개)는 한 주기에 한 연결을 공유하고, 주기가 끝나면 닫는다. `pollConcurrency`(기본 12)가 같은 호스트에 병렬 연결을 만들지 않게 한다.
- 접속 대상은 **인벤토리에 등록된 장비 IP뿐**이다. 프로파일이나 설정 값으로 임의 호스트에 연결되는 경로를 두지 않는다.
- 값 변환: `uint16`, `int16`, `uint32`, `int32`, `float32`, `bit`(레지스터의 n번째 비트). 32비트 값은 `word_order`(`ABCD` 또는 `CDAB`)를 **명시한 경우에만** 변환한다. `scale`, `unit`도 명시 필수. 기본값으로 추측하지 않는다.

### 3.2 레지스터 맵 프로파일

장비별 주소를 코드에 넣지 않는다. 프로파일 JSON 한 개가 한 모델(또는 컨트롤러 계열)이다.

```json
{
  "id": "stulz-<controller>",
  "vendor": "Stulz",
  "model_scope": "설문·명판으로 확인된 컨트롤러 계열",
  "source_doc": { "title": "제조사 Modbus 포인트 리스트", "revision": "…", "page": "…" },
  "address_base": 0,
  "points": [
    { "metric": "supply_temp_c", "type": "input", "address": 0, "data": "int16",
      "scale": 0.1, "unit": "°C", "confidence": "documented" }
  ]
}
```

- `address_base`는 0 또는 1을 반드시 적는다. 제조사 문서의 "40001"식 표기와 PDU 주소(0부터)의 차이가 현장 오류의 가장 흔한 원인이다. 로더가 PDU 주소로 환산한다.
- `type`: `holding` | `input` | `coil` | `discrete`. `enum`(값→문자열)과 `label`은 선택.
- 모든 포인트는 `confidence: "documented"`로 시작한다. 현장에서 장비 디스플레이와 대조한 뒤에만 `"verified"`로 올린다(`crac.js`의 iCOM 배율과 같은 원칙). 원시 정수는 `raw_value`로 항상 함께 저장한다.
- 로더는 프로파일을 검증하고, 잘못된 프로파일은 프로세스를 죽이지 않고 해당 장비를 `unsupported`(사유 포함)로 돌려준다.
- **주소를 지어내지 않는다.** Stulz 프로파일은 실사에서 확인된 컨트롤러 모델의 **제조사 공식 포인트 리스트가 손에 있을 때만** 작성하고 `source_doc`에 출처를 적는다. 문서가 없으면 Stulz 프로파일은 만들지 말고 `DECISIONS.md`에 Q를 남긴 뒤, 나머지를 시뮬레이터용 프로파일(`profiles/modbus/sim-crac.json`)로 완료한다.

### 3.3 항온항습기: `pollers/crac.js` 분기와 `crac-modbus.js`

- `crac.js`의 iCOM SNMP 경로는 건드리지 않는다. `attrs.protocol`이 `modbus` 또는 `modbus-tcp`이면 `pollCracModbus`로 넘긴다. `bacnet`은 기존 `unsupported` 유지(문구에서 "iCOM SNMP only"만 사실에 맞게 고친다).
- 장비 원장 속성: `attrs.protocol`, `attrs.modbus = { port, unit_id, profile }`. `fms_devices.protocol` 컬럼은 이미 `modbus` 값을 허용한다(마이그레이션 008).
- 메트릭 이름은 SNMP 경로와 **같은 이름**을 쓴다: `supply_temp_c`, `return_temp_c`, `state_system`, `state_cooling`, `alarm_count`. 그래야 `coolingState()`(→ `cooling_available`)와 `delta_t_c` 파생이 그대로 동작한다. 대기(standby) 중인 유닛이 냉방 가용으로 계산되면 안 된다는 기존 원칙을 Modbus 경로에서도 시험으로 고정한다.
- 프로파일에 있는 그 밖의 포인트(습도, 설정온도, 팬 속도, 개별 알람 비트 등)는 프로파일의 `metric` 이름대로 추가로 올린다.
- 반환 형식은 수집기 공통 계약 `{ ok, metrics[], error?, notes?, unsupported? }` 그대로. 일부만 읽힌 경우 읽힌 것만 돌려주고 `notes`에 빠진 포인트를 적는다.

### 3.4 접점 입력 모듈: `pollers/dio.js` (종류 `dio`)

소방 패널 릴레이를 받는 Modbus TCP I/O 모듈용 수집기다. 어느 채널에 무엇을 결선했는지는 현장마다 다르므로 **프로파일이 아니라 장비 속성**에 둔다.

```json
"attrs": {
  "protocol": "modbus-tcp",
  "modbus": { "port": 502, "unit_id": 1, "type": "discrete", "address_base": 0 },
  "inputs": [
    { "channel": 0, "metric": "fire_alarm",        "active_state": "closed", "label": "FM-200 Alarm" },
    { "channel": 1, "metric": "fire_trouble",      "active_state": "closed" },
    { "channel": 2, "metric": "fire_predischarge", "active_state": "closed" },
    { "channel": 3, "metric": "fire_discharge",    "active_state": "closed" }
  ]
}
```

- 메트릭 값: `value` 0(정상)/1(동작), `str_value` `normal`/`active`, `raw_value`는 읽은 비트 그대로, `unit: "state"`.
- `active_state`(`closed`|`open`)로 NO/NC 접점을 뒤집는다. 생략하면 변환하지 않고 그 채널을 `notes`에 "active_state 미지정"으로 보고한다. 추측한 극성으로 화재 신호를 뒤집어 보여주는 일이 없어야 한다.
- 허용 메트릭 이름: `fire_alarm`, `fire_trouble`, `fire_supervisory`, `fire_predischarge`, `fire_discharge`, `smoke_zone_<n>`, `leak_alarm`, `contact_<n>`. 목록 밖 이름은 거부한다.
- **통신 두절과 "정상"을 구분한다.** 모듈이 응답하지 않으면 `ok:false`로 보고하고 마지막 값을 0으로 채우지 않는다. 소방 접점에서 "못 읽음"이 "정상"으로 보이면 안 된다.
- `pollers/index.js`의 `COLLECTORS`에 `dio: pollDio`를 등록한다.

### 3.5 출처 표기

메트릭의 `oid` 자리는 SNMP 전용이다. Modbus 값은 `oid`에 `modbus:<unit_id>:<type>:<pdu_address>` 문자열(예: `modbus:1:input:12`)을 넣어 어느 레지스터에서 온 값인지 남긴다. 버퍼·콘솔 저장 스키마가 이 문자열을 거부하면 스키마를 바꾸지 말고 `DECISIONS.md`에 Q를 남긴다.

### 3.6 시뮬레이터 `sim/sim-modbus.js`

`node:net` Modbus TCP 서버. 개발 전용.

- holding/input/coil/discrete 테이블을 환경변수 또는 JSON으로 설정
- 응답 분할(fragmentation), 지연, 예외 코드 주입, 연결 끊기 옵션
- 쓰기 function code를 받으면 예외 01을 돌려주고 수신 사실을 기록(프로브가 쓰기를 보내지 않는다는 시험에 사용)
- 사용 예를 파일 머리 주석에 적는다(`sim-crac.js` 형식)

## 4. 금지 사항 (위반 시 PR 반려)

1. 장비 쓰기 0건. 코드 어디에도 쓰기 function code 경로가 없어야 한다.
2. 실장비·운영 서버·고객 VM 접속 0건. 시험은 루프백과 시뮬레이터만.
3. 새 npm 의존성 0건.
4. 계약 00 부록 B 밖의 알람 코드 추가 0건.
5. 비밀값(계정·키·community·실제 고객 IP)을 파일·로그·STATUS·시험 픽스처에 쓰지 않는다. 시험 IP는 `127.0.0.1`과 문서용 대역만.
6. `cflex-fms-codex/**`와 포털 코드 수정 0건.
7. 제조사 문서 없이 작성한 레지스터 주소 0건.
8. 기존 SNMP 수집기(UPS, PDU, NetBotz, 네트워크, iCOM CRAC)의 동작 변경 0건. 기존 시험은 전부 그대로 통과해야 한다.

## 5. 완료 기준 (CLAUDE.md의 네 축으로 보고)

### 개발 코드

- §2 포함 항목 1~7의 파일이 브랜치에 있고 PR이 열려 있다.
- `grep`으로 쓰기 function code 경로 0, 새 의존성 0(`package.json` diff 없음)을 PR 본문에 붙인다.

### 격리 시험

`probe-agent/test/modbus.test.js`에 아래가 각각 1건 이상 있고, `npm test` 전체가 통과한다(통과 수를 STATUS에 기록).

- 요청 생성이 function code 5·6·15·16을 거부한다
- transaction ID·unit ID·길이 불일치 응답을 버린다
- 예외 응답 02와 04가 서로 다른 오류 문구로 구분된다
- 분할 응답, 타임아웃, 연결 거부를 각각 처리한다
- `int16` 음수, `uint32`/`float32`의 `ABCD`·`CDAB`, `bit` 변환이 맞다
- `word_order`·`scale`·`unit`이 없는 포인트는 변환을 거부한다
- `address_base` 1 프로파일이 PDU 주소로 정확히 환산된다
- 125 레지스터를 넘는 연속 구간이 여러 요청으로 나뉜다
- 같은 호스트의 unit ID 두 개가 한 연결을 순차로 쓴다(동시 연결 1개)
- 항온항습기 Modbus 경로에서 `cooling_available`과 `delta_t_c`가 파생되고, standby 유닛은 0이다
- `dio`: NO/NC 반전, `active_state` 미지정 채널 보고, 모듈 무응답 시 `ok:false`(값 0으로 채우지 않음)
- 잘못된 프로파일은 `unsupported`와 사유를 돌려주고 주기를 멈추지 않는다
- 레지스트리가 `crac`+`modbus-tcp`와 `dio`를 올바른 수집기로 보낸다
- 시뮬레이터가 쓰기 요청을 한 건도 받지 않았다

E2E 1건: `sim-modbus`(CRAC 1대 + DIO 1대) → 프로브 수집 주기 → 콘솔 collector API가 두 장비의 `metrics` 이벤트를 받는다(기존 `console.e2e.test.js` 하니스 사용).

### 실제 배포

해당 없음. KMX 설치 번들에 포함되는 것은 별도 WO에서 다룬다. STATUS에는 "미실시"로 적는다.

### 실제 Probe 연결

해당 없음. KMX 현장 연결과 `documented → verified` 전환은 1월 11~22일 커미셔닝에서 한다. STATUS에는 "미실시"로 적는다.

## 6. Git과 보고

- 워크트리: `git worktree add ../cflex-fms-wt-int017 -b wo/INT-017-modbus-tcp main`. 다른 트리에서 작업하지 않는다.
- 커밋 접두어 `[WO-INT-017]`, 커밋 본문에 충족한 완료 기준을 적는다.
- 완료 시 `gh pr create --base main --title "[WO-INT-017] Probe Modbus TCP 수집기"`. 본문: 완료 기준 체크리스트, 시험 출력, §4 금지 사항 확인 결과. 머지는 관리자가 한다.
- 세션 종료 시 `docs/control/STATUS.md` Claude Code 블록에 네 축으로 보고하고 push한다.
- 모호한 점은 추측하지 말고 `DECISIONS.md`에 `Q-날짜-번호`로 남긴 뒤, 막히지 않는 부분을 계속한다.

## 7. 일정

| 시점 | 내용 |
|---|---|
| 승인 즉시 | TASKS 등록, 워크트리 생성, §3.1·3.6(클라이언트·시뮬레이터)부터 착수 |
| 2026-12-04 | 개발 코드·격리 시험 완료, PR 검토요청 (KMX 설계 승인일) |
| 2027-01-08 | 실사 결과로 Stulz 프로파일·DIO 채널 표 확정, 랩에서 시뮬레이터로 재검증 |
| 2027-01-11 ~ 01-22 | KMX 현장 연결, 디스플레이 대조 후 `verified` 전환 (별도 WO) |

## 8. 법인장 결정이 필요한 사항

이 WO의 착수를 막지는 않지만, KMX 운영 개시(2027-02-15) 전에 정해져야 한다.

1. **KMX 알람 코드.** 이 WO가 끝나도 항온항습기 고장과 소방 접점은 "값으로 보이기만" 하고 알람·통보로는 이어지지 않는다. 계약 00 부록 B에 코드를 추가하는 개정(Probe와 포털 양쪽 작업)이 필요하다. 관리자 권고: 승인하고 후속 WO(Probe 1건, 포털 1건)를 2월 8일 검수 전에 끝낸다.
2. **Stulz 통신 경로.** 실사에서 확인된 컨트롤러 모델과 통신 방식(Modbus TCP 직접 / RS-485 + 게이트웨이 / WIB SNMP)에 따라 프로파일과 구매 품목이 달라진다. 제조사 포인트 리스트를 확보해 저장소 `reference/`에 넣어야 Stulz 프로파일을 쓸 수 있다.
3. **I/O 모듈 기종.** 설계 패키지에서 정한 모델과 DI 주소 방식(coil / discrete)이 필요하다. 모르는 동안은 시뮬레이터 기본값으로 개발한다.
4. **D-12a 적용 범위.** 수집기 추가는 "수집하고 보여주는 것"에 해당해 동결 범위 안이라고 관리자는 판단한다. HAEA 번들에는 영향이 없다(Modbus 장비가 원장에 없으면 코드가 실행되지 않는다). 이 해석에 동의하시는지 확인이 필요하다.

## 9. TASKS.md 등록용 행 (승인 후 관리자가 붙여 넣음)

```
| 17 | WO-INT-017 | 대기 | **Probe Modbus TCP 수집기** (지시서 `docs/workorders/WO-INT-017_modbus-tcp-collector.md`) — `services/modbus-read.js`(읽기 전용 FC 1–4, node:net, 의존성 추가 금지, 호스트당 연결 1개), 레지스터 맵 프로파일 로더, `pollers/crac.js` 프로토콜 분기 + `crac-modbus.js`(SNMP 경로와 같은 메트릭 이름, `cooling_available`·`delta_t_c` 재사용), `pollers/dio.js`(접점 모듈, NO/NC 명시), `sim/sim-modbus.js`. 쓰기·RTU 직결·BACnet·새 알람 코드·화면 추가·실장비 접속 금지. 제조사 문서 없는 레지스터 주소 금지 | `test/modbus.test.js` 지시서 §5 항목 전부 + E2E 1건, `npm test` 전체 통과, 쓰기 FC 경로 0·새 의존성 0 확인, PR, STATUS 네 축 보고(실제 배포·실제 Probe 연결은 미실시로 기록) |
```
