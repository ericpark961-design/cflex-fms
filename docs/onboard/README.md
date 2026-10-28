# cflex-onboard — NMC 온보딩 도구 사용법 (명세 04, D-15, WO-INT-014)

프로브 설치 뒤 UPS 네트워크 관리 카드(NMC)의 **설정을 읽고(read)**, SNMP 수집에 필요한 것(SNMPv3 사용자·접근 제어, trap 수신자 = 컬렉터, 레거시 v1/v2c 정리, NTP)을 **정해진 범위 안에서만** 넣는다(apply). 카드마다 웹 UI를 손으로 여는 일을 없애는 것이 목적이다.

- **프로브 런타임이 아니다**(D-12a). 운영자가 명시적으로 실행할 때만, 실행되는 동안만 카드에 접속한다. 수집기·forwarder·콘솔과 코드·프로세스를 공유하지 않는다(콘솔의 기존 유지보수 창 API만 호출).
- **⚠ WO-INT-014에서는 실장비에 접속·스캔·설정하지 않았다.** 시뮬레이터로만 검증했다. 실장비 적용은 법인장 승인 + 유지보수 창에서 별도 WO로 한다. CLI 구문은 실카드 미확인 — [`NMC_CLI_COMMANDS.md`](NMC_CLI_COMMANDS.md).

## 1. 어디서 실행하나 — 기본은 엔지니어 노트북

| 실행 위치 | 조건 | 비고 |
|---|---|---|
| **엔지니어 노트북(사이트 LAN 접속)** — **기본 안내** | 노트북에서 NMC로 TCP 22(SSH), 필요 시 443·161/udp가 열려 있을 것 | 방화벽 요청서 v3 Form A에는 **collector → NMC 22가 없다.** 노트북 실행은 방화벽 변경이 필요 없다. |
| 컬렉터 VM(cap01) | 방화벽 v4에 "collector → NMC TCP 22, 온보딩·PM 기간 한정" 추가(관리자 별도 처리) | 같은 코드·같은 설정 파일. v4 반영 전에는 22가 막혀 `unreachable`로 끝난다. |

필요한 것: Node.js 20 이상, `probe-agent` 디렉터리, `npm install`(의존성 `ssh2` 1.17.0 고정 — 순수 JS, 선택 네이티브 모듈 `cpu-features`는 빌드 실패해도 동작). 노트북에서는 저장소 체크아웃 밖의 작업 폴더에서 `--out`을 지정해 실행하는 것을 권한다.

```bash
cd probe-agent && npm install
node bin/cflex-onboard.js --help        # 또는 npm run onboard -- --help
```

## 2. 대상 — 옵션 1(인벤토리)이 기본, 옵션 2(스캔)는 선택

### 옵션 1: 인벤토리 기반 (기본)
이미 확보한 장비 목록의 IP로만 접속한다. **목록 밖 주소에는 어떤 패킷도 보내지 않는다** — 모든 전송 계층이 소켓을 열기 전에 인벤토리 게이트를 확인한다.

| 소스 | 옵션 | 형식 |
|---|---|---|
| NMC 대상 목록 | `--targets <file>` 또는 site.yaml `nmc.targets_file` | 한 줄에 IP 하나(`install/nmc-targets.example.txt` 형식, `#` 주석) |
| 인벤토리 CSV | `--inventory <csv>` | 콘솔 가져오기 열 이름·Q3 시드 CSV·Exhibit 1 별칭: `nmc_ip`/`ip`/`ip address`, `site`, `label`/`unit`, `model`, `serial`, `firmware` |
| Local Console | `--console https://<app>/ [--console-ca <pem>]` | `GET /v1/console/devices`의 `nmc_ip` (자격증명 파일 `console:` 필요) |

여러 소스를 함께 주면 IP로 합친다(콘솔이 사이트·라벨 우선). `--site <SITE>`·`--ip a,b`는 **좁히기만** 한다 — 인벤토리에 없는 `--ip`는 오류. `--max-devices`(기본 64)를 넘으면 실행하지 않는다.

### 옵션 2: 탐색 스캔 (선택)
```bash
node bin/cflex-onboard.js scan --scan 192.0.2.0/24 [--credentials f]   # 확인 프롬프트 후 실행
```
- `--scan <cidr>` 명시 + 확인 프롬프트(`y`)가 있어야만 동작. 범위는 /22~/32, **초당 20 호스트 이하**, 재시도 1회.
- 호스트당 TCP 22(SSH 배너)·443(인증서 CN), 자격증명 파일에 `scan.community`가 있으면 SNMP GET 1회(sysObjectID — APC `1.3.6.1.4.1.318.*` 판별). ICMP는 보내지 않는다(raw 소켓·root 필요 — TCP 응답이 생존 판정).
- 결과는 `onboard/scan-<ts>.json` **후보 목록일 뿐**이다. 로그인·설정하지 않는다. 후보는 운영자가 인벤토리(콘솔 또는 CSV)에 라벨·사이트와 함께 넣은 뒤에야 옵션 1의 대상이 된다.

## 3. 자격증명 — 실행 시 운영자가 제공

- 파일: [`probe-agent/onboard-credentials.example.yaml`](../../probe-agent/onboard-credentials.example.yaml)을 복사해 채운다. **모드 0600이 아니면 거부한다.** 컬렉터에서는 `/opt/app/cflex/config/onboard-credentials.yaml`(`cflex` 소유). site.yaml에 인라인 금지.
- 또는 `--ask`: 파일 없이 실행 시 프롬프트(입력 비표시).
- 값은 파일에 직접 쓰거나 `ref:NAME`(환경 변수 `NAME`에서 읽음). **기본 세트(`defaults`) + 장비별 오버라이드(`overrides`)**.
- 값은 로그·리포트·감사 로그·예외 메시지에 나오지 않는다(리댁터 + 테스트로 강제). 커뮤니티 이름도 저장하지 않는다(설정 여부·길이·공장값 여부만).
- **인증 실패**: 그 카드는 `auth_failed`로 두고 다음으로 진행. **같은 자격증명 세트로 3회 연속 실패하면** 계정 잠금을 피하려고 그 세트 사용을 멈추고 운영자에게 묻는다(비대화형이면 "아니오"). 성공 1회면 계수는 0으로.
- **공장 기본 계정**(apc) 사용은 감지해 리포트에 권고만 남긴다. 계정·비밀번호는 바꾸지 않는다(고객 보안팀 소관).

## 4. 원하는 상태 — site.yaml `onboard:` 블록 (키는 자격증명 파일에만)

```yaml
onboard:
  snmpv3: { user: cflex-ro, auth: sha, priv: aes }   # 사용자 이름에 공백 금지
  # trap_receiver: <컬렉터 IP>   # 생략 시 hosts.collectors 중 그 사이트를 맡은 컬렉터의 ip
  # ntp: { servers: [<ip>, <ip>] }   # 다르면 경고, --set-ntp일 때만 씀
  # sites: { HMA-FV: { snmpv3: { user: … } } }
```
설치기(`cflex-install`)는 이 블록을 쓰지 않는다(무시). 정책 플래그: `--disable-legacy`(v3 검증 성공 직후 v1/v2c 끄기), `--set-ntp`, `--v3-profile <1-4>`(빈 프로파일 지정), `--trap-receiver <ip>`.

## 5. 명령

| 명령 | 하는 일 | 쓰기 |
|---|---|---|
| `read` | 카드별 모델·시리얼(NMC/UPS)·펌웨어·호스트명·IP/마스크/GW·NTP·날짜·SNMP v1/v3 상태·v3 사용자(방식만)·trap 수신자·HTTPS/SSH·기본 계정 여부 + **config.ini 백업**. 인벤토리와 대조(시리얼·모델·펌웨어 불일치, 응답 없는 장비). | 없음 |
| `plan` | `read` + 원하는 상태와의 **diff**와 실행될 CLI 줄(비밀값은 `***`). 항상 dry-run. `apply --dry-run`도 같다. | 없음 |
| `apply` | 카드마다 **확인 프롬프트** → 백업(config.ini) → 적용 → **검증**(설정 재조회 + SNMPv3 GET sysDescr/upsBasicIdentModel + `--trap-test` 시 trap) → (성공 시에만) `--disable-legacy` → 재검증. 실패 시 **자동 롤백**(되돌리는 줄) 후 `failed`. 이미 원하는 상태면 건너뜀(멱등). 순차(동시성 1). `--console`이면 사이트별 유지보수 창을 열고 끝나면 닫는다. `--yes-all`은 운영자가 명시할 때만. | 고정 범위만 |
| `verify` | 인벤토리 전 장비 SNMPv3 GET 1회 + trap 테스트(선택) → PASS/FAIL 표. **SAT 2번 항목 증빙 형식.** | 없음 |
| `scan` | 옵션 2 (위 §2). | 없음 |

예 (노트북, 사이트 하나):
```bash
export ONBOARD_DEFAULT_PW=… ONBOARD_V3_AUTH=… ONBOARD_V3_PRIV=…    # 셸 기록에 남지 않게 --ask도 가능
node bin/cflex-onboard.js read  --site-yaml site.yaml --inventory exhibit1.csv --credentials ~/onb/creds.yaml --site HMA-FV --out ~/onb/run1
node bin/cflex-onboard.js plan  --site-yaml site.yaml --inventory exhibit1.csv --credentials ~/onb/creds.yaml --site HMA-FV --out ~/onb/run1 --disable-legacy
node bin/cflex-onboard.js apply --site-yaml site.yaml --inventory exhibit1.csv --credentials ~/onb/creds.yaml --site HMA-FV --out ~/onb/run1 --ip <한 대>   # 첫 카드는 한 대만
node bin/cflex-onboard.js verify --site-yaml site.yaml --inventory exhibit1.csv --credentials ~/onb/creds.yaml --site HMA-FV --out ~/onb/run1
```
종료 코드: 0 정상, 1 `failed` 카드 있음, 2 사용법·설정 오류.

## 6. 남는 파일 (`--out`, 기본 `./onboard`)

| 파일 | 내용 | 모드 |
|---|---|---|
| `<site>/<ip>/read-<ts>.json` | 카드별 읽은 설정(비밀값 없음) | 0600 |
| `<site>/<ip>/config-<ts>.ini` | **카드의 config.ini 원본 백업** — 카드가 넣어 둔 커뮤니티 등이 들어 있을 수 있다. 공유·커밋 금지. | 0600 |
| `report-<ts>.md` / `.csv` | 장비별 결과(ok/skipped/auth_failed/unreachable/failed+사유), 변경 전후 diff, 인벤토리 대조, 권고 | 0600 |
| `scan-<ts>.json` | 옵션 2 후보 | 0600 |
| `audit.log` | 실행·명령(마스킹)·백업·적용·검증·롤백 기록, **추가만**(JSON 한 줄씩) | 0600 |
| `known_hosts.json` | 카드 SSH 호스트 키·HTTPS 인증서 지문(최초 사용 시 고정). 바뀌면 거부 — 카드 교체 시 그 줄을 운영자가 지운다. | 0600 |

## 7. 안전 규칙 (코드로 강제, 테스트로 증명)

1. 쓰기는 SNMPv3 사용자/접근 제어, trap 수신자, v1/v2c 끄기(플래그), NTP(플래그)뿐. **UPS 출력 제어·셀프테스트·재부팅·계정·네트워크·펌웨어 명령은 거부 목록** — 화이트리스트 밖 줄은 채널에 쓰이지 않는다(`commands.js`). SNMP SET 없음.
2. 대상은 인벤토리(옵션 1) 또는 운영자가 인벤토리에 넣은 스캔 후보뿐.
3. 모든 쓰기: 백업 → 적용 → 검증 → (실패 시) 롤백. 백업이 안 되면 쓰지 않는다. config.ini 되올리기(업로드)는 하지 않는다 — 수동 복원용으로 보관.
4. 자격증명·커뮤니티·키는 어떤 출력에도 없다.
5. 동시 접속 1, 단계별 타임아웃 30초(`--timeout`), `--max-devices` 상한.
6. 감사 로그: 로컬 `audit.log`(추가만). 콘솔 감사 로그에는 유지보수 창 설정·해제가 콘솔 자체 기록으로 남는다.

## 8. 시뮬레이터와 테스트

`probe-agent/test/sim/nmc-cli-sim.js` — 127.0.0.1에서 SSH CLI(NMC2·NMC3), SCP config.ini, SNMPv3 에이전트, HTTPS 웹 UI. 상태 변형: v1-only / v3 이미 설정 / 공장 계정 / 인증 실패 / 느린 응답 / 구형 펌웨어(v3 없음), 장애: 특정 쓰기 E102, SNMP 검증 실패. 호스트 키는 시작할 때 메모리에서 생성(파일·커밋 없음). 테스트 픽스처 주소는 192.0.2.x(문서용)이고 시뮬레이터 포트로 매핑된다(`--sim-map`은 127.0.0.1만 허용).

```bash
cd probe-agent && node --test test/onboard.test.js
```
