# C-Flex 장비 연동 실행 가이드

2026-10-11. 상태: 실행 가능한 읽기 전용 수집 런타임과 분석·패키지 검증 라이브러리. 현대 실장비 인증, Azure 배포, 기존 운영 Probe 통합은 아직 수행하지 않았다.

## 배치 경계

현대 내부 VMware에 수집 런타임을 둔다. SNMP·Modbus·제조사 API 접근과 장비 비밀정보는 내부에서 관리한다. 고객 운영자는 내부 FMS에서 장비 상태·알람·이력을 볼 수 있어야 한다. WAN 단절 중에도 이 기능이 유지되도록 기존 FMS·SQLite 버퍼에 통합한다.

외부 Azure 플랫폼은 다고객 NOC, 계약·티켓·SLA, AI 분석·지식·고객 통신과 배포 카탈로그를 담당한다. Probe가 외부 HTTPS 연결을 시작한다. 외부 플랫폼이나 AI가 내부 장비에 직접 연결하는 구조로 만들지 않는다. 이번 collector는 로컬 JSON만 출력한다. 기존 forwarder와 자동으로 연결된 상태가 아니다.

## 코드와 지원 수준

| 항목 | 구현한 것 | 적용 전 필요한 것 |
|---|---|---|
| SNMP | net-snmp 3.29.2, v3 authPriv, GET·subtree, 명시적으로 허용한 v2c | 승인 IP, 장비 읽기 계정, 모델·MIB 확인 |
| 표준 UPS | RFC1628 배터리·런타임·전압·다상 출력·알람·시험 결과 읽기 | 해당 모델의 UPS-MIB 구현 확인 |
| APC UPS | PowerNet 기본 UPS OID + 표준 MIB 보완 | UPS/NMC 모델·펌웨어와 OID·열거값 검증 |
| Vertiv UPS | UPS-MIB를 제공하는 모델의 표준 지표 | Unity/모델별 전용 MIB·매핑은 추가; 모든 Vertiv 장비 지원 아님 |
| Cisco | System·IF/IFX·ENTITY MIB, 포트 상태·오류·64비트 카운터·일부 HW/SW 정보 | 모델/OS별 센서·CPU·메모리·PoE·UC 프로파일 추가 |
| 사용자 SNMP 프로파일 | 공식 출처·모델 범위·numeric OID·단위·배율·table 정의로 확장 | 라이선스가 허용하는 MIB와 실장비 검증; 프로파일 다운로드 자동 활성화는 미구현 |
| Modbus TCP | function 3/4 읽기, 프레임·응답 식별 검증, 값 변환 | 제조사 모델별 register map, byte/word order, 주소 체계 |
| HTTPS JSON/RESTCONF 읽기 | 승인 origin, 인증서 검증, GET, JSON pointer·단위 매핑 | 실제 지원 API·YANG 경로, 계정·권한·CA; 완전한 NETCONF 구현 아님 |
| 배터리 분석 | 온도 추세·교체 신호·실측 용량 비율·데이터 부족 표시 | 화학계·설치일·모델 기준·동일 조건 용량 시험 |
| Probe 패키지 | Ed25519 서명, SHA256, 대상·만료·버전·호환성 확인 후 staging | 카탈로그·다운로더·서명키 운영·supervisor·활성화·롤백 추가 |
| 장비 펌웨어 | 호환성과 변경 조건을 확인하는 계획 함수 | 제조사별 실행·백업·복구 구현 및 사람 승인; 자동 실행 없음 |

BACnet/IP·MS/TP, Modbus RTU, Trap/Inform 수신, Syslog, NETCONF, vendor cloud API, Redfish, UPS USB/직렬, CRAC/PDU/NetBotz/Geist의 개별 맵은 이번 런타임의 구현 완료 목록에 포함하지 않는다. 범용 프로토콜 코드의 존재와 특정 장비 지원 인증을 구분한다.

## 실행

Node.js 22 이상. 이 저장소 루트에서:

```bash
npm ci --prefix services/probe
npm --prefix services/probe run demo
npm --prefix services/probe run collect -- /secure/cflex/inventory.json
npm --prefix services/probe run collect -- /secure/cflex/inventory.json --watch
```

`services/probe/examples/inventory.example.json`은 문서용 IP만 포함한다. 실제 승인된 목록으로 교체한다. 비밀정보는 내부 secret manager나 서비스 환경으로 공급한다. `secretEnv`가 참조하는 값은 JSON이며 SNMPv3에서는 `user`, `authKey`, `privKey`, `authProtocol`, `privProtocol`을 사용한다. 기본 알고리즘은 SHA256/AES이며 장비가 지원하는 조합을 확인한다. SNMPv2c는 장비별 `allowLegacyV2c: true`와 명시적 community가 있어야 한다. v1과 암묵적 public community는 사용하지 않는다.

실행 결과는 `outputPath`의 최신 수집 스냅샷이다. `--watch`는 한 주기가 끝난 뒤 설정 간격(최소 30초) 후 다시 실행한다. 고정 30초 내 전체 수집이나 대규모 병렬 성능을 보장하는 스케줄러가 아니다. 현재 장비와 OID를 순차 수집한다. 인터페이스 대량 장비의 수집 예산·동시성·지수 backoff는 운영 scheduler로 확장해야 한다.

권장 로컬 서비스 계정은 root가 아니며 인벤토리·비밀 파일을 읽을 권한과 상태 디렉터리에 쓸 권한만 갖는다. 개인 장치나 Git에 실제 자격증명을 복사하지 않는다.

## 데이터의 정확성과 한계

- `collectionQuality`는 complete/partial/unavailable이다. 정상 장비 판정이 아니다. `deviceHealth`는 평가하지 않았음을 명시한다. 모든 OID가 없으면 건강도 100으로 만들지 않는다.
- RFC1628 입력·출력 전압은 V 그대로, 배터리 전압은 0.1V, 출력 전류는 0.1A다. APC 잔여 런타임 TimeTicks는 6000으로 나눠 분으로 변환한다.
- 다상 지표는 인덱스를 보존한다. 단일 voltage 필드로 3상 값을 덮어쓰지 않는다. Cisco Counter64는 십진 문자열로 반환해 정밀도를 보존한다.
- 열거형 값은 프로파일별로 해석해야 한다. APC 교체 enum을 JavaScript `Boolean(value)`로 변환하면 안 된다. 제조사별 enum과 alarm OID 정의를 확정한 뒤 플랫폼 의미 체계로 변환한다.
- 표준 MIB의 일부를 제공하지 않는 APC/Vertiv 장비는 부분 지원으로 나타날 수 있다. APC NetBotz 등은 UPS PowerNet 프로파일로 처리하지 않는다.
- subtree는 512행 한도가 있다. 초과 시 불완전한 결과를 완전 수집으로 반환하지 않는다. 대상 테이블 필터링/분할과 제한 설정은 대형 장비 적용 전 추가한다.
- 현재 로컬 출력은 최신 값이다. 장기 이력·보존·압축·재전송은 기존 Probe 저장소 및 플랫폼 시계열 DB 통합 작업이다.

## SNMP가 제공하지 않는 기능

SNMP는 장비가 이미 노출하는 상태를 읽거나 지원되는 관리 항목에 접근하는 수단이다. 없는 센서 값을 만들 수 없다. 셀 단위 전압·임피던스·실제 용량은 별도 BMS/센서/제조사 진단이나 정비 시험 기록이 필요할 수 있다. 설정·펌웨어·구성 백업은 제조사별 API, NETCONF/RESTCONF, 관리 카드 기능, 승인된 파일 전송 등 별도 어댑터로 구현한다.

배터리 분석의 입력은 충전율(SOC), 실제 용량 시험에 근거한 용량 비율(SOH의 한 지표), 제조사 교체 권고일, 예측 모델의 잔여 수명(RUL)을 서로 구분한다. 현재 RUL은 `null`이고 검증된 예측 모델이 없다. 온도 경고 기준이나 권장 교체 기간을 모든 화학계에 동일하게 적용하지 않는다. `capacityTestAt`과 용량 수치는 동일한 온도·방전 조건 등 비교 가능한 시험일 때만 입력한다. 배터리 calibration/self-test도 전원 품질과 부하에 영향을 줄 수 있으므로 AI 일반 문의 자동 처리에 포함하지 않는다.

## 패키지와 장비 변경

`package-stage.mjs`는 서명된 manifest 원본 bytes와 artifact를 검증한다. 검증 공개키는 Probe 설치 시 별도 경로로 신뢰 설정하고 패키지 자체가 제공하는 키를 믿지 않는다. 중앙 서명 개인키는 Probe에 배포하지 않는다. 단조 증가 sequence의 신뢰 상태도 로컬 보호 저장소에서 공급해야 한다.

staging은 설치·실행이 아니다. 운영 구현은 다운로드 크기 제한 → 검증 → 일부 Probe 배포 → health check → 활성화 → 실패 시 기존 버전 복원 → 결과 보고 순서로 추가한다. 현재 함수는 다운로드·압축 해제·실행·서비스 재시작을 하지 않는다. 프로파일 변경과 Probe 바이너리 변경, 장비 펌웨어 변경을 같은 자동 작업으로 취급하지 않는다.

`firmwarePlan()`의 서명 확인·백업·승인 플래그는 외부 검증 결과를 입력하는 자리이며 이 함수가 제조사 파일을 직접 검증했다는 뜻이 아니다. 모든 조건이 갖춰져도 `ready_for_human_review`, `automaticExecutionAllowed: false`다. UPS 전원 off/on, outlet 제어, 배터리 방전 시험, 설정 쓰기 API는 이번 읽기 런타임에 없다.

## 기존 cflex-probe / cflex-fms와 결합

현재 Git에서 확인한 기존 Probe는 `/v1/probe/event`에 `{kind,payload}`를 보내며 `X-Probe-Key`, `X-Probe-Id`, `X-Tenant-Id`를 사용한다. 이 저장소의 실험용 서비스는 별도 `/v1/events` 계약이므로 URL만 바꿔 직접 연결하면 안 된다.

1. 수집 스냅샷을 기존 장비 UUID·tenant·site와 매칭한다. 서버는 Probe 자격증명에 귀속된 tenant/site 범위를 검증한다.
2. 통신 품질·미지원·다상 값을 유지하는 telemetry 스키마를 확정한다. 필요한 메타데이터만 외부로 내보내고 비밀정보를 제거한다.
3. 기존 SQLite 버퍼에 저장하고, 플랫폼의 영속화 ACK 후 제거한다. 재시작·WAN 단절·중복·순서 역전 시험을 한다.
4. 기존 로컬 FMS와 외부 NOC에서 같은 장비·시각·알람 상태를 보여주는지 대조한다.
5. 실험실 패키지를 운영 백엔드에 그대로 덮어쓰지 않는다. cflex-shell은 비공개 base 위의 패치라는 README 설명이 있어 base 소스·현재 배포 상태와 함께 통합한다.

기존 `src/services/ups-metrics.js`에서 발견한 검토 사항: 표준 UPS-MIB input/output voltage에 `/10`을 적용하는 경로, 일부/전체 결측인데 건강도를 100에서 계산하는 경로. 이번 새 collector에서는 수정된 의미 체계를 사용한다. 기존 원격 Git 파일이나 운영 서버는 이번 작업에서 수정하지 않았다.

## 네트워크 범위

| 통신 | 배치 원칙 |
|---|---|
| Probe → 장비 UDP 161 | 승인된 장비만, SNMP 읽기 계정 |
| 장비 → Probe UDP 162 | 향후 Trap 수신을 사용할 때만; 송신원·사용자 제한 |
| Probe → 장비 TCP 502 | Modbus 모델별 허용; 기본 프로토콜에 암호화/인증이 없으므로 내부 구획과 ACL 필요 |
| Probe → 장비 HTTPS | 승인된 origin과 내부 CA, GET 읽기 |
| Probe → 플랫폼/패키지 저장소 TCP 443 | 아웃바운드 허용 목록, 운영용 Probe별 인증·폐기·회전·재시도 |
| 현대 운영자 → 내부 FMS | 내부 HTTPS 및 고객 인증 체계 |
| NOC 운영자 → 외부 플랫폼 | MFA/역할·고객 범위, 감사 이력 |

장비 관리 포트를 인터넷에 공개하지 않는다. 실제 방화벽 규칙·인증서·mTLS/토큰 수명·프록시·DNS/NTP는 현대 네트워크 정책과 Azure 배포 구성을 확인해 적용한다. 현재 개발 API의 단일 프로세스 JSON 저장소·고정 토큰은 운영 아키텍처의 최종 형태가 아니다.

## 적용 전 확인 자료

장비 목록의 모델/수량/위치, UPS·PDU·냉각기와 NMC/BMS 모델, 펌웨어, 사용 가능 프로토콜, 공식 MIB 또는 register export, 승인 수집 IP 범위, 내부 서비스 계정·CA, 설치일·정비 이력, 계약 SLA가 필요하다. 자격증명은 채팅에 다시 적지 말고 내부 secret store에서 설정한다. 앞서 첨부된 장비 이미지들은 이 작업 환경에서 읽히지 않았으므로 이미지 기반 모델 검증을 완료했다고 볼 수 없다.

최소 실장비 검수: 정상/알람/복구, 한 항목 미지원, 전체 통신 단절, 잘못된 인증, 재시작, 다상·단위, 시계 오차, WAN 단절/재연결, 고객 범위, 장비 교체. 합격 증거에 모델·펌웨어·프로파일 버전·장비 화면 값·수집 값·검수자를 기록한다.

## 근거 자료

- UPS-MIB: https://www.rfc-editor.org/rfc/rfc1628.html
- APC MIB 및 제품별 범위: https://www.se.com/us/en/faqs/FA156048/
- Schneider 배터리 평가 설명: https://www.se.com/us/en/faqs/FAQ000242964/
- Schneider 장비 정의 DDF: https://www.se.com/us/en/faqs/FA290458/
- Vertiv Unity DP: https://www.vertiv.com/en-ca/products-catalog/monitoring-control-and-management/monitoring/liebert-is-unity-dp-communications-card/
- Cisco API: https://developer.cisco.com/docs/cisco-netconf-and-rest-device-management-api-documentation/
- net-snmp 공식 문서: https://github.com/markabrahams/node-net-snmp
