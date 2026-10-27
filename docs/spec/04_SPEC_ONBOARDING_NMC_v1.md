# C-Flex FMS 2.x — NMC 온보딩 도구(`cflex-onboard`) 명세서 v1.0

- 문서번호: SPEC-CFLEX-ONBOARD-2026-1027 v1.0
- 담당: Claude Code (내부 Probe 팀) · 작업지시 WO-INT-014
- 근거 결정: D-12a(프로브 런타임은 수집·표시만), D-15(온보딩 도구는 운영자 실행 유틸리티 — 아래)
- 상태: **개발 착수용.** 실제 장비(HAEA/HMA/KUS NMC)에 대한 어떤 접속·스캔·설정도 **이 WO에서는 수행하지 않는다.** 시뮬레이터와 단위/통합 테스트로만 검증한다. 실장비 적용은 별도 승인(법인장)과 유지보수 창에서만.

---

## 0. 목적

프로브(컬렉터)를 설치한 뒤, 장비(UPS 네트워크 관리 카드, NMC)의 **현재 설정을 읽어 오고(read)**, **SNMP 수집에 필요한 설정(v3 사용자, trap 수신자, 레거시 프로토콜 정리)을 넣는(write-limited)** 작업을 엔지니어가 카드 하나씩 웹 UI에서 손으로 하지 않게 한다. 레퍼런스 장비군은 현재 SNMP v1만 설정되어 있고 카드 41개(+미기재 3개)이므로, 이 도구가 없으면 온보딩이 하루 이상 걸린다(가이드 15.2절).

이 도구는 **프로브 런타임의 일부가 아니다.** 프로브 서비스는 D-12a대로 수집·표시만 한다. `cflex-onboard`는 운영자가 명시적으로 실행하는 CLI 유틸리티이며, 실행 중에만 장비 관리 인터페이스에 접속한다.

## 1. 대상 선택 — 옵션 1이 기본, 옵션 2는 선택

| 옵션 | 이름 | 동작 | 기본 |
|---|---|---|---|
| **1** | **인벤토리 기반(target list)** | 이미 확보한 장비 목록(Exhibit 1 NMC IP 41개 + 콘솔 인벤토리)의 IP로만 접속. 목록 밖 주소에는 어떤 패킷도 보내지 않는다. | **예** |
| 2 | 탐색(discovery scan) | 운영자가 지정한 CIDR/범위 안에서 NMC 후보를 찾는다(ICMP → TCP 443/22 배너 → SNMP sysObjectID로 APC 확인). 명시적 플래그 `--scan <cidr>` + 확인 프롬프트가 있어야만 동작. 속도 제한(초당 ≤ 20 호스트), 재시도 1회, 결과는 "후보 목록"일 뿐 자동으로 설정하지 않는다. | 아니오 |

옵션 2로 찾은 후보는 운영자가 인벤토리에 추가(라벨·사이트 지정)한 뒤에야 옵션 1의 대상이 된다. 스캔 결과에는 IP, 응답 포트, sysDescr/모델/시리얼(SNMP로 읽힌 경우), HTTPS 인증서 CN만 기록한다.

## 2. 접속 자격증명

- **운영자가 실행 시 제공한다**(법인장이 전달 예정). 전부 같을 수도, 장비마다 다를 수도 있다 → **기본 세트 + 장비별 오버라이드** 구조.
- 저장: `/opt/app/cflex/config/onboard-credentials.yaml`(모드 0600, `cflex` 소유) 또는 실행 시 프롬프트(`--ask`). site.yaml에 인라인 금지. 로그·리포트·STATUS에 값 출력 금지(테스트로 강제).
- 형식(예):
  ```yaml
  defaults: { user: apc, password: ref:ONBOARD_DEFAULT_PW, transport: ssh }
  overrides:
    10.112.5.34: { user: apc, password: ref:MPOE_A_PW }
    10.119.141.25: { transport: https }
  ```
- 인증 실패 시: 해당 장비를 `auth_failed`로 표시하고 다음 장비로 진행(중단하지 않음). 같은 자격증명으로 3회 연속 실패하면 계정 잠금을 피하기 위해 그 자격증명으로의 시도를 멈추고 운영자에게 묻는다.
- 카드의 기본 계정(apc/apc)은 **감지해서 경고**하되 바꾸지는 않는다(계정·비밀번호 변경은 고객 보안팀 소관 — 리포트에 권고만).

## 3. 전송(transport)과 방화벽

| 우선순위 | 방식 | 용도 | 비고 |
|---|---|---|---|
| 1 | **SSH(22) CLI** | 설정 읽기·쓰기 전부 | NMC2(AP9631/AP9641)·NMC3 공통 CLI. 가장 안정적. **방화벽 요청서 v3 Form A에는 collector→NMC 22가 없다** → 도구는 (a) 컬렉터에서 실행하거나 (b) **엔지니어 노트북에서 사이트 LAN에 접속해 실행**할 수 있어야 한다(같은 바이너리, 같은 설정). (a)를 쓰려면 방화벽 v4에 "collector → NMC TCP 22, 온보딩·PM 기간 한정" 추가 — 관리자가 별도 처리. |
| 2 | HTTPS(443) | 읽기 전용 폴백(config.ini 내려받기, 상태 페이지 파싱) | v3 Form A에 이미 포함. 쓰기는 웹 폼 자동화가 되어 취약 → v1에서는 **읽기만**. |
| 3 | SCP/FTP config.ini | 전체 설정 백업·복원 | NMC의 `config.ini`는 전체 설정의 정본. 변경 전 백업은 이 파일로 받는다(SCP 우선, FTP는 운영자가 명시할 때만). |
| — | SNMP(161) | 검증 전용 | 설정 후 v3 GET으로 확인. SNMP SET은 **금지**. |

## 4. 기능

### 4.1 `cflex-onboard read` — 설정 수집(읽기만)
- 대상 장비마다: 모델·시리얼(프레임/모듈)·펌웨어·호스트명·IP/마스크/GW·NTP·날짜/시각·SNMP v1/v2c 상태와 커뮤니티 이름(값은 마스킹)·SNMP v3 상태와 사용자 목록(인증/암호 방식만, 키 없음)·trap 수신자 목록·HTTPS/SSH 활성 여부·기본 계정 사용 여부·`config.ini` 전체(백업 디렉터리에 저장).
- 출력: `onboard/<site>/<ip>/read-<ts>.json` + 전체 요약 표(터미널, CSV). 인벤토리(콘솔 또는 Exhibit 1 CSV)와 **대조**: 시리얼·모델·펌웨어 불일치, 인벤토리에 없는 응답 장비, 응답 없는 인벤토리 장비.
- 어떤 설정도 바꾸지 않는다. 명령 목록은 읽기 명령 화이트리스트로 고정(`about`, `upsabout`, `tcpip`, `ntp`, `date`, `snmp`, `snmpv3`, `snmptrap`, `web`, `ssh`, `user` 조회형 — NMC CLI 가이드로 정확한 구문을 확인하고 표로 남길 것).

### 4.2 `cflex-onboard plan` — 원하는 상태(desired state)와 차이
- 입력: site.yaml의 사이트별 SNMP v3 프로파일(사용자명, 인증 SHA/암호 AES 방식 — 키는 자격증명 저장소), 컬렉터(trap 수신자) IP, 정책 플래그(v1 비활성 여부, v2c 유지 여부, NTP 서버).
- 출력: 장비별 **diff**(현재 → 원하는 상태)와 실행될 CLI 명령 목록. `--dry-run`이 기본. 아무것도 쓰지 않는다.

### 4.3 `cflex-onboard apply` — 적용(쓰기, 범위 제한)
- 허용 쓰기 범위 **고정**: SNMP v3 활성/사용자 생성·수정, SNMP v3 접근 제어(NMS IP = 컬렉터), trap 수신자 추가·수정(v3, 컬렉터 IP, 포트 162), SNMP v1/v2c 비활성(검증 후, 플래그로), NTP 서버 설정(선택). **그 외 어떤 설정(출력 제어, 셀프테스트, 재부팅, 계정, 네트워크, 펌웨어)도 금지** — 코드에서 명령 화이트리스트로 강제하고 테스트로 증명.
- 순서(장비당): 백업(config.ini) → 적용 → **검증**(SNMP v3 GET sysDescr/upsBasicIdentModel 성공, 테스트 trap 수신 — NMC `snmptrap` 테스트 기능 또는 컬렉터 trap 리스너에서 확인) → 검증 성공 시에만 v1/v2c 비활성(`--disable-legacy`) → 결과 기록. 검증 실패 시 **자동 롤백**(백업 config 또는 역명령) 후 `failed`로 표시.
- 기본은 **장비마다 확인 프롬프트**(`--yes-all`은 운영자가 명시). 동시성 1(순차). 사이트 단위로 유지보수 창을 콘솔에 자동 설정(`set_maintenance`)하고 끝나면 해제.
- 멱등: 이미 원하는 상태면 건너뛴다.

### 4.4 `cflex-onboard verify` — 검증만
- 인벤토리 전 장비에 SNMP v3 폴링 1회 + trap 테스트(가능한 경우) → PASS/FAIL 표. SAT 2번 항목의 증빙 출력 형식.

### 4.5 `cflex-onboard scan` — 옵션 2
- §1의 규칙대로. 결과는 `onboard/scan-<ts>.json`. 자동 설정 없음.

### 4.6 리포트
- 실행마다 `onboard/report-<ts>.md|csv`: 장비별 결과(ok/skipped/auth_failed/unreachable/failed+사유), 변경 전후 diff 요약, 인벤토리 대조 결과, 권고(기본 계정 사용, 구형 펌웨어로 v3 불가 등). 비밀값 없음.

## 5. 안전 규칙(코드로 강제)
1. 쓰기 명령 화이트리스트 외 명령은 실행 경로 자체가 없다(테스트: 금지 명령 주입 시 거부).
2. 대상은 옵션 1 목록 또는 `--scan` 결과 중 운영자가 인벤토리에 넣은 것만.
3. 모든 쓰기는 백업 → 적용 → 검증 → (실패 시) 롤백.
4. 자격증명·커뮤니티·키는 로그/리포트/예외 메시지에 절대 출력되지 않는다(테스트).
5. 동시 접속 1, 장비당 타임아웃 30초, 전체 실행에 `--max-devices` 상한.
6. 실행 기록은 콘솔 감사 로그(가능하면)와 로컬 `onboard/audit.log`(append-only)에 남는다.
7. **이 WO 기간 중 실장비 접속 금지.** 테스트는 NMC CLI 시뮬레이터(§6)로만.

## 6. 시뮬레이터와 테스트
- `probe-agent/test/sim/nmc-cli-sim.js`: SSH 서버(테스트용 호스트 키)로 NMC2/NMC3 CLI 프롬프트와 명령 응답을 흉내 낸다(모델 2종 이상, 펌웨어 구/신, v1만 설정된 상태, v3 이미 설정된 상태, 기본 계정 상태, 인증 실패 상태, 느린 응답). `config.ini` SCP 응답 포함.
- 테스트: read 파싱(모델별 응답 포맷), plan diff, apply 순서(백업→적용→검증→롤백), 화이트리스트 거부, 자격증명 마스킹, 인증 실패 3회 정지, 옵션 2 스캔 속도 제한, 인벤토리 대조, 리포트 생성. 기존 테스트 전부 통과.
- NMC CLI 구문은 APC NMC2/NMC3 CLI 가이드(공개 문서)를 근거로 표(`docs/onboard/NMC_CLI_COMMANDS.md`)에 정리하고, **실장비에서 확인되지 않았음**을 표에 명시한다(실장비 확인은 SAT 전 현장 검증 항목).

## 7. 산출물
- `probe-agent/bin/cflex-onboard.js` + `src/onboard/{targets,credentials,transport-ssh,transport-https,reader,planner,applier,verifier,scanner,report}.js`
- `docs/onboard/README.md`(사용법, 옵션 1/2, 자격증명 파일, 방화벽 주의), `docs/onboard/NMC_CLI_COMMANDS.md`
- 시뮬레이터와 테스트, STATUS 보고, PR.

## 8. 미확정(관리자/법인장)
1. 접속 자격증명(기본 세트, 장비별 예외) — 법인장이 전달 예정. 코드는 값 없이 구조만.
2. 컬렉터에서 NMC로 SSH 22 허용(방화벽 v4) vs 엔지니어 노트북 실행 — 둘 다 지원하고 기본은 노트북 실행 안내.
3. v1/v2c 비활성 시점(즉시 vs 전 장비 v3 검증 후 일괄) — 기본: 장비별 검증 직후, `--disable-legacy` 플래그로만.
4. NTP 설정을 이 도구가 할지(권고: 읽기·경고만, 쓰기는 플래그).
