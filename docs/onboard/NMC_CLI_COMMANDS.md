# NMC CLI 명령표 — `cflex-onboard`가 보내는 줄 전부 (WO-INT-014, 명세 04 §4.1·§4.3·§6)

> **⚠ 실장비에서 확인되지 않음.** 아래 구문과 출력 형식은 APC(Schneider Electric) **NMC2(AP9630/AP9631/AP9635)·NMC3(AP9640/AP9641/AP9643) CLI 가이드(공개 문서)** 를 근거로 정리했고, 시뮬레이터(`probe-agent/test/sim/nmc-cli-sim.js`)는 이 표를 재현한 것이지 실카드 캡처가 아니다.
> **SAT 전 현장 검증 항목**: 펌웨어별(AOS v6.x NMC2, v1.x~v3.x NMC3) 실제 구문·출력 라벨·오류 코드를 카드 1대(유지보수 창, 법인장 승인)에서 `read`로 먼저 확인하고 이 표의 "현장 확인" 열을 채운다. 확인 전에는 `apply`를 실장비에 쓰지 않는다.

코드상 정본: `probe-agent/src/onboard/commands.js` (`READ`·`WRITE`·`DENY`). 이 표와 코드가 다르면 코드가 맞고 이 표를 고친다. 모든 줄은 `commands.check()`를 통과해야만 SSH 채널에 쓰인다(`transport-ssh.js run()`).

## 1. 읽기 (read 세션에서 허용 — 인수 없는 정확한 줄만)

| 명령 | 읽는 것 | 파서(`reader.js`) | NMC2 / NMC3 차이(가이드 기준) | 현장 확인 |
|---|---|---|---|---|
| `about` | NMC 모델·시리얼·HW rev·제조일·MAC·AOS/앱 버전 | `parseAbout` | NMC2 `Model Number:` / NMC3 `Model:` 둘 다 수용 | 미확인 |
| `upsabout` | UPS 모델·SKU·시리얼·제조일·UPS 펌웨어 | `parseUpsAbout` | `Firmware Revision:` / `Firmware:` | 미확인 |
| `tcpip` | IPv4 주소·마스크·GW·호스트명·도메인 | `parseTcpip` | `Active IPv4 …` / `System IP:` | 미확인 |
| `date` | 날짜·시각·형식·시간대 | `parseDate` | 동일 | 미확인 |
| `ntp` | NTP 사용 여부·1차/2차 서버 | `parseNtp` | 라벨 `NTP status:` 가정 | 미확인 |
| `snmp` | SNMPv1(v1/v2c 커뮤니티 접근) 사용 여부·접근 제어 4행 | `parseSnmp` | `SNMPv1:` / `SNMPv1 Access:` · **커뮤니티 값은 저장하지 않음**(설정 여부·길이·공장값 여부만) | 미확인 |
| `snmpv3` | v3 사용 여부·사용자 프로파일 4개(이름·인증/암호 방식, 키 없음)·접근 제어 4행 | `parseSnmpv3` | `Encryption:` / `Privacy:` · 구형 펌웨어는 `E101` → v3 불가로 보고 | 미확인 |
| `snmptrap` | trap 수신자 6행(IP·유형·생성·인증 trap·프로파일) | `parseSnmptrap` | 동일 · 커뮤니티 값 미저장 | 미확인 |
| `web` | HTTP/HTTPS 사용·포트 | `parseWeb` | 동일 | 미확인 |
| `console` | Telnet/SSH 사용·포트 | `parseConsole` | 명세 04 §4.1은 `ssh`로 적었으나 가이드의 조회 명령은 `console`(NMC3 일부 빌드는 `ssh` 별도 존재 가능) — 현장 확인 | 미확인 |
| `user -n <로그인 계정>` | 로그인 계정의 권한(Super User 등) | `parseUser` | `-n` 외 인수는 거부(계정 변경 경로 없음) | 미확인 |
| `scp -f config.ini` (exec) | 전체 설정 백업(0600) | `transport-ssh.js scpGet` | NMC2/NMC3 모두 SCP 지원(가이드) · SFTP 미사용 | 미확인 |

기본 계정 감지: 로그인 자격증명이 공장값(`apc`/공장 비밀번호)인지 **메모리에서 비교**만 하고 리포트에 "factory account in use" 권고로 남긴다. 계정은 바꾸지 않는다(명세 04 §2).

## 2. 쓰기 (apply 세션에서만, 고정 범위 — 명세 04 §4.3)

`<n>` 사용자 프로파일/접근 제어 1–4, `<r>` trap 수신자 1–6, `<ip>` IPv4, `<name>` `[A-Za-z0-9_.-]{1,32}`(롤백 시 공장 이름 `"apc snmp profile<n>"` 따옴표 허용), `<phrase>` 15–32자 출력 가능 문자(공백·따옴표 제외).

| id | 줄(형식) | 언제 | 되돌리는 줄(undo) | 조건 | 현장 확인 |
|---|---|---|---|---|---|
| `snmpv3_enable` | `snmpv3 -S enable` | v3가 꺼져 있을 때 | `snmpv3 -S disable` | — | 미확인 |
| `snmpv3_user` | `snmpv3 -u<n> <name> -a<n> <phrase> -c<n> <phrase> -ap<n> sha -pp<n> aes` | 사용자·방식이 다르거나, 같아도 v3 GET이 실패할 때(키는 읽을 수 없으므로 GET으로 판정) | `snmpv3 -u<n> <이전 이름> -ap<n> <이전> -pp<n> <이전>` (이전 키는 복원 불가 — 아래 §4) | — | 미확인 |
| `snmpv3_access` | `snmpv3 -ac<n> enable -au<n> <name> -n<n> <컬렉터 IP>` | 접근 제어가 다를 때 | 이전 enable/이름/NMS로 | — | 미확인 |
| `snmptrap_receiver` | `snmptrap -r<r> <컬렉터 IP> -t<r> snmpV3 -g<r> enable -a<r> enable -u<r> profile<n>` | 수신자가 없거나 다를 때 | 이전 IP/유형/생성/인증 trap으로 | — | 미확인 |
| `legacy_snmp` | `snmp -S disable` | **v3 검증 성공 직후에만** | `snmp -S enable` | `--disable-legacy` | 미확인 |
| `ntp` | `ntp -OM enable -p <ip> [-s <ip>]` | site.yaml `onboard.ntp.servers`와 다를 때 | 이전 상태로 | `--set-ntp`(없으면 경고만) | 미확인 |

결과 코드(가이드): `E000 Success`·`E001 Successfully Issued`만 성공. `E002`(재부팅 필요)는 성공으로 치지 않는다 — 이 범위의 명령은 재부팅을 요구하지 않아야 하며, 요구하면 실패로 보고 롤백한다. `E100` 명령 없음, `E101` 미지원, `E102` 인수 오류.

## 3. 거부 (코드에 있어도 실행 경로 없음 — `DENY` + 화이트리스트 밖 전부)

| 범주 | 예 | 이유 |
|---|---|---|
| UPS 출력 제어·셀프테스트 | `ups -c off`, `ups -s`, `ups -o …` | 부하 정전 위험(D-05) |
| 재부팅·초기화·포맷 | `reboot`, `resetToDef`, `clrrst`, `format`, `boot` | 카드 재기동 |
| 계정 | `user -n x -pw …`, `userdflt`, `radius`, `session` | 고객 보안팀 소관(명세 04 §2) |
| 네트워크·서비스 | `tcpip -i …`, `dns …`, `web -h …`, `console -S …`, `ftp`, `smtp`, `email`, `system`, `prompt`, `portspeed`, `eapol` | 범위 밖 |
| 펌웨어·파일 | `firmware`, `upload`, `xferINI`, `xferStatus`, `delete`, `logzip` · `scp -t` (업로드) | 범위 밖 · config.ini 복원 업로드 없음 |
| 전원 설정 | `cfgshutdn`, `cfgpower`, `bypass`, `outlet`, `olOn/olOff/olReboot` | 범위 밖 |
| SNMP 커뮤니티 변경 | `snmp -c<n> …`, `snmp -a<n> …`, `snmptrap -c<r> …` | 레거시는 끄기만(`-S disable`) |
| 줄 주입 | `\r`·`\n`·NUL 포함, 앞뒤 공백, `about; reboot` | 한 줄 = 한 명령 |

`SNMP SET`은 cflex-onboard 어디에도 없다(검증은 v3 GET만 — `verifier.js`, 테스트 `no SNMP SET code path`).

## 4. 알려진 한계 (현장 확인 대상)

1. **키 복원 불가**: v3 사용자 롤백은 이름·방식만 되돌린다. 카드에서 이전 pass phrase를 읽을 수 없기 때문이다. 공장 상태(`apc snmp profile<n>`, None/None)에서 시작한 카드는 완전히 원상 복구된다.
2. **config.ini 업로드 복원 없음**: 백업은 받지만 되올리지 않는다(업로드는 계정·네트워크까지 덮어쓰는 범위 밖 쓰기). 수동 복원은 엔지니어가 `scp config.ini apc@<ip>:config.ini`(가이드) — 이 도구 밖.
3. **테스트 trap 명령 없음**: CLI 가이드에서 테스트 trap 송신 명령을 확인하지 못했다. `verify --trap-test`는 수신기만 열고 기다린다(카드 웹 UI의 테스트 기능 등 운영자 조작).
4. **HTTPS 경로**: `/Forms/login1`(`login_username`·`login_password`), `/config.ini`, `/logout.htm` — 가이드·웹 UI 관례 기준, 미확인.
5. **SSH 알고리즘**: 구형 AOS는 CBC 암호·SHA1 kex만 제공할 수 있다 → `--ssh-legacy-algorithms`(추가만, 우선순위 하위).
6. **한 SSH 연결에 셸 + SCP 채널**: 읽기(셸)를 연 채로 같은 연결에 `scp -f config.ini` exec 채널을 연다(카드당 로그인 1회 — 인증 실패 계수·잠금 위험 최소화). 실카드가 한 연결 다채널을 거부하면 백업만 별도 연결로 나눈다(코드 수정 필요).
