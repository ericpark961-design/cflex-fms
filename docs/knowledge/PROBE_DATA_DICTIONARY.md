# Probe 데이터 사전 (PROBE_DATA_DICTIONARY) v1

- 문서: WO-INT-013 · 명세 03 §1·§9 · 작성 Claude Code · 2026-10-26
- 기준 코드: `main` `d328497` (D-12a 기능 완료 시점). 표마다 출처 파일과 그 파일의 마지막 커밋을 적었다.
- 기준 계약: `docs/spec/00_INTERFACE_CONTRACT_Probe-Portal_v1.md` v1.1, 부록 A(메트릭 27키), 부록 B(알람 코드 22개).
- 원칙: **코드에서 읽은 사실만** 적었다. 코드에 없으면 `미구현`이라고 적었다. 시뮬레이터(`probe-agent/sim/`)에만 있는 값은 `시뮬레이터 전용`이라고 표시했다.
- 범위: SOW 44대(UPS)와 같은 컬렉터가 읽는 PDU·NetBotz·CRAC·네트워크 장비. Probe는 SNMP 읽기(GET/WALK)만 하고 trap은 받기만 한다. 장비 쓰기(SET)는 없다(D-05).
- 형식: 표 하나 = CSV 하나. 열 이름은 영문 snake_case이고, 1행 = 1항목이다. 셀 안에는 줄바꿈과 세로선 문자를 넣지 않았다. 빈 값은 `-`로 적었다.
- 비밀값·IP·호스트명 실값은 넣지 않았다. community·v3 키는 변수 이름만 적었다.

---

## §1. 폴링 OID 표

### 1.0 폴링 주기·세션 (공통)

| item | value | source_file | note |
|---|---|---|---|
| poll_interval | 60000 ms (`POLL_INTERVAL_MS`) | probe-agent/src/config.js | UPS와 비UPS 장비가 같은 주기로 돈다. 장비별 주기 설정은 미구현 |
| first_poll_delay | 5000 ms | probe-agent/src/index.js | 기동 뒤 첫 사이클 |
| poll_concurrency | 12 (`POLL_CONCURRENCY`) | probe-agent/src/config.js | 한 사이클 안 동시 폴링 수 |
| ups_snmp_timeout_retries | 5000 ms / 1회 | probe-agent/src/services/ups-metrics.js | `pollDevice`가 opts 없이 호출해서 기본값이 적용된다. `SNMP_TIMEOUT_MS`·`SNMP_RETRIES`는 UPS 경로에 적용되지 않는다 |
| collector_snmp_timeout_retries | 3000 ms / 2회 (`SNMP_TIMEOUT_MS`, `SNMP_RETRIES`) | probe-agent/src/index.js | PDU·NetBotz·CRAC·네트워크 |
| ups_request | SNMP GET 1회(프로파일의 OID 전부) | probe-agent/src/services/ups-metrics.js | WALK 없음 |
| collector_request | 표는 WALK, CRAC 상태는 GET | probe-agent/src/pollers/*.js | - |
| snmp_versions | v1, v2c, v3(noAuthNoPriv, authNoPriv, authPriv) | probe-agent/src/services/snmp-helpers.js | 장비별 `snmp_version`. 기본값 v2c |
| snmp_port | 161 (`snmp_port` 또는 `SNMP_PORT`) | probe-agent/src/services/snmp-helpers.js | 161이 아닌 포트는 시뮬레이터 전용 |
| config_reload | 300000 ms (`CONFIG_RELOAD_MS`) | probe-agent/src/index.js | 장비 목록·임계·유지보수 창을 다시 받는다 |
| telemetry_flush | 60000 ms 또는 500포인트 | probe-agent/src/forwarder.js | 계약 §3.3 |
| heartbeat | 60000 ms | probe-agent/src/config.js | 계약 §3.1 |
| ups_profile_select | `oid_profile`이 `apc-powernet`이면 APC, `ups-mib`이면 RFC 1628. 값이 없으면 vendor에 apc·schneider가 있거나 model이 SR·SRT·SMART-UPS·SMC·SUA·SURTA·SYMMETRA·GALAXY로 시작할 때 APC | probe-agent/src/services/snmp-helpers.js | `isApcVendor` |
| non_ups_feed_with_console | Local Console을 구성하면 비UPS 객체 피드가 비어 있다 | probe-agent/src/forwarder.js | `fetchObjectConfig`가 `[]`를 반환한다. 그래서 Local Console 구성(HAEA 기본)에서는 PDU·NetBotz·CRAC·네트워크 폴러가 돌지 않는다. 이 폴러들은 구 클라우드 `/v1/probe/objects` 피드에서만 장비를 받는다 |

### 1.1 UPS — APC PowerNet-MIB 프로파일 (`OID_APC_POWERNET`)

| device_class | oid | mib_name | mib | poll_interval_s | internal_key | appendix_a_key | conversion | m_ext | note |
|---|---|---|---|---|---|---|---|---|---|
| ups | 1.3.6.1.2.1.33.1.1.1.0 | upsIdentManufacturer | UPS-MIB (RFC 1628) | 60 | manufacturer | - | 문자열 | - | 텔레메트리로 보내지 않는다 |
| ups | 1.3.6.1.4.1.318.1.1.1.1.1.1.0 | upsBasicIdentModel | PowerNet-MIB | 60 | model | - | 문자열 | - | 텔레메트리로 보내지 않는다 |
| ups | 1.3.6.1.4.1.318.1.1.1.1.2.1.0 | upsAdvIdentFirmwareRevision | PowerNet-MIB | 60 | firmware | fw | 문자열, 최대 128자 | - | - |
| ups | 1.3.6.1.4.1.318.1.1.1.2.1.1.0 | upsBasicBatteryStatus | PowerNet-MIB | 60 | battery_status | bat_replace_flag | 2=normal 3=low 4=depleted 그 밖=unknown. bat_replace_flag는 이 문자열이 replace를 포함하는지로 정한다 | - | 이 매핑은 replace 값을 만들지 않으므로 bat_replace_flag는 항상 false다(§2 D-03) |
| ups | 1.3.6.1.4.1.318.1.1.1.2.1.2.0 | upsBasicBatteryTimeOnBattery | PowerNet-MIB | 60 | - | - | - | - | GET으로 읽지만 값을 쓰지 않는다 |
| ups | 1.3.6.1.4.1.318.1.1.1.2.2.3.0 | upsAdvBatteryRunTimeRemaining | PowerNet-MIB | 60 | runtime_min | runtime_s | TimeTicks ÷ 6000 → 분(반올림), 텔레메트리에서 × 60 → 초 | - | 1분 단위로 반올림한 값이 초로 나간다 |
| ups | 1.3.6.1.4.1.318.1.1.1.2.2.1.0 | upsAdvBatteryCapacity | PowerNet-MIB | 60 | battery_pct | bat_pct | % 그대로 | - | - |
| ups | 1.3.6.1.4.1.318.1.1.1.2.2.2.0 | upsAdvBatteryTemperature | PowerNet-MIB | 60 | temp_c | bat_temp_c | °C 그대로 | - | - |
| ups | 1.3.6.1.4.1.318.1.1.1.2.2.4.0 | upsAdvBatteryReplaceIndicator | PowerNet-MIB | 60 | - | - | - | - | GET으로 읽지만 값을 쓰지 않는다. bat_replace_flag의 출처가 아니다 |
| ups | 1.3.6.1.4.1.318.1.1.1.3.2.1.0 | upsAdvInputLineVoltage | PowerNet-MIB | 60 | input_v | in_v | V 그대로, 1원소 배열 [v] | - | 상(phase) 1개만 |
| ups | 1.3.6.1.4.1.318.1.1.1.4.1.1.0 | upsBasicOutputStatus | PowerNet-MIB | 60 | output_source | status | 2=onLine 3=onBattery 4=onSmartBoost 6=softwareBypass 7=off 8=rebooting 12=onSmartTrim 그 밖=unknown. status: onLine·onSmartBoost·onSmartTrim→online, onBattery→on_battery, softwareBypass→bypass, off→off, 그 밖→null | - | 9(switchedBypass)·10(hardwareFailureBypass)는 unknown이 되고 status는 null이다 |
| ups | 1.3.6.1.4.1.318.1.1.1.4.2.1.0 | upsAdvOutputVoltage | PowerNet-MIB | 60 | output_v | out_v | V 그대로, 1원소 배열 [v] | - | - |
| ups | 1.3.6.1.4.1.318.1.1.1.4.2.3.0 | upsAdvOutputLoad | PowerNet-MIB | 60 | load_pct | load_pct | % 그대로 | - | - |

### 1.2 UPS — 표준 UPS-MIB 프로파일 (`OID_UPS_MIB`, APC가 아닐 때)

| device_class | oid | mib_name | mib | poll_interval_s | internal_key | appendix_a_key | conversion | m_ext | note |
|---|---|---|---|---|---|---|---|---|---|
| ups | 1.3.6.1.2.1.33.1.1.1.0 | upsIdentManufacturer | UPS-MIB (RFC 1628) | 60 | manufacturer | - | 문자열 | - | 텔레메트리로 보내지 않는다 |
| ups | 1.3.6.1.2.1.33.1.1.2.0 | upsIdentModel | UPS-MIB (RFC 1628) | 60 | model | - | 문자열 | - | 텔레메트리로 보내지 않는다 |
| ups | 1.3.6.1.2.1.33.1.1.3.0 | upsIdentUPSSoftwareVersion | UPS-MIB (RFC 1628) | 60 | firmware | fw | 문자열, 최대 128자 | - | 코드 키 이름은 identFirmware |
| ups | 1.3.6.1.2.1.33.1.2.1.0 | upsBatteryStatus | UPS-MIB (RFC 1628) | 60 | battery_status | bat_replace_flag | 2=normal 3=low 4=depleted 그 밖=unknown | - | bat_replace_flag는 항상 false다(§2 D-03) |
| ups | 1.3.6.1.2.1.33.1.2.3.0 | upsEstimatedMinutesRemaining | UPS-MIB (RFC 1628) | 60 | runtime_min | runtime_s | 분 그대로, × 60 → 초 | - | - |
| ups | 1.3.6.1.2.1.33.1.2.4.0 | upsEstimatedChargeRemaining | UPS-MIB (RFC 1628) | 60 | battery_pct | bat_pct | % 그대로 | - | - |
| ups | 1.3.6.1.2.1.33.1.2.5.0 | upsBatteryVoltage | UPS-MIB (RFC 1628) | 60 | - | - | - | - | GET으로 읽지만 값을 쓰지 않는다. bat_v는 미구현 |
| ups | 1.3.6.1.2.1.33.1.2.7.0 | upsBatteryTemperature | UPS-MIB (RFC 1628) | 60 | temp_c | bat_temp_c | °C 그대로 | - | - |
| ups | 1.3.6.1.2.1.33.1.3.3.1.3.1 | upsInputVoltage (line 1) | UPS-MIB (RFC 1628) | 60 | input_v | in_v | 코드는 ÷ 10을 적용한다. 1원소 배열 | - | RFC 1628의 단위 정의와 대조할 대상이다(DECISIONS Q-2026-10-26-16) |
| ups | 1.3.6.1.2.1.33.1.4.1.0 | upsOutputSource | UPS-MIB (RFC 1628) | 60 | output_source | status | 1=other 2=none 3=onLine 4=bypass 5=onBattery 6=booster 7=reducer. status: onLine→online, onBattery→on_battery, bypass→bypass, 그 밖→null | - | UPS-MIB 경로에서는 off가 나오지 않는다 |
| ups | 1.3.6.1.2.1.33.1.4.4.1.2.1 | upsOutputVoltage (line 1) | UPS-MIB (RFC 1628) | 60 | output_v | out_v | 코드는 ÷ 10을 적용한다. 1원소 배열 | - | RFC 1628의 단위 정의와 대조할 대상이다(Q-2026-10-26-16) |
| ups | 1.3.6.1.2.1.33.1.4.4.1.5.1 | upsOutputPercentLoad (line 1) | UPS-MIB (RFC 1628) | 60 | load_pct | load_pct | % 그대로 | - | - |

### 1.3 UPS — 폴 결과에서 만드는 부록 A 키 (OID 없음)

| device_class | source | appendix_a_key | conversion | note |
|---|---|---|---|---|
| ups | 폴 성공 여부 | comm_ok | 성공 true, 실패 false | 실패한 폴에서도 이 키는 보낸다 |
| ups | 폴 소요 시간 | poll_latency_ms | ms | 실패한 폴에서도 이 키는 보낸다 |

### 1.4 Rack PDU — PowerNet-MIB rPDU2 (enterprise 318)

`telemetry_key`는 계약 `m`에 들어가는 키다(`adapt.collectorPoint`가 snake_case로 바꾼다). PDU 키는 부록 A에 없어서 전부 `m_ext`다. 모든 행의 `confidence`는 `documented`이다(벤더 MIB 기준이고 실장비로 아직 확인하지 않았다). `mib_object`에 객체 이름을 적은 것은 코드 주석에 이름이 있는 2개(rPDU2DeviceStatusPower, rPDU2PhaseStatusCurrent)뿐이다. 나머지는 "표 + 열 번호"로 적었고, 객체 이름은 K1 PowerNet-MIB 원문과 대조할 대상이다(Q-2026-10-26-06).

| device_class | table_oid | column_sub | mib_object | mib | poll_interval_s | metric | telemetry_key | unit | scale | value_map | m_ext | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pdu | 1.3.6.1.4.1.318.1.1.26.4.3.1 | 3 | rPDU2DeviceStatusEntry column 3 | PowerNet-MIB | 60 | load_state | load_state | state | 1 | 1=normal 2=low 3=nearOverload 4=overload | yes | 장치 행이 여럿이면 label dev<n> |
| pdu | 1.3.6.1.4.1.318.1.1.26.4.3.1 | 5 | rPDU2DeviceStatusPower | PowerNet-MIB | 60 | power_kw | power_kw | kW | 0.01 | - | yes | 현장 표시값과 대조할 대상이다 |
| pdu | 1.3.6.1.4.1.318.1.1.26.4.3.1 | 6 | rPDU2DeviceStatusEntry column 6 | PowerNet-MIB | 60 | peak_power_kw | peak_power_kw | kW | 0.01 | - | yes | - |
| pdu | 1.3.6.1.4.1.318.1.1.26.4.3.1 | 11 | rPDU2DeviceStatusEntry column 11 | PowerNet-MIB | 60 | energy_kwh | energy_kwh | kWh | 0.1 | - | yes | - |
| pdu | 1.3.6.1.4.1.318.1.1.26.6.3.1 | 3 | rPDU2PhaseStatusEntry column 3 | PowerNet-MIB | 60 | - | - | index | 1 | - | - | 상 라벨 L<n>을 만드는 데만 쓴다 |
| pdu | 1.3.6.1.4.1.318.1.1.26.6.3.1 | 4 | rPDU2PhaseStatusEntry column 4 | PowerNet-MIB | 60 | phase_load_state | phase_load_state | state | 1 | 1=normal 2=low 3=nearOverload 4=overload | yes | 상별 행이 있다(label L<n>) |
| pdu | 1.3.6.1.4.1.318.1.1.26.6.3.1 | 5 | rPDU2PhaseStatusCurrent | PowerNet-MIB | 60 | phase_current_a | phase_current_a | A | 0.1 | - | yes | 0.1 A 단위다 |
| pdu | 1.3.6.1.4.1.318.1.1.26.6.3.1 | 6 | rPDU2PhaseStatusEntry column 6 | PowerNet-MIB | 60 | phase_voltage_v | phase_voltage_v | V | 1 | - | yes | - |
| pdu | 1.3.6.1.4.1.318.1.1.26.9.2.3.1 | 5 | switched outlet status table column 5 | PowerNet-MIB | 60 | outlet_state | outlet_state | state | 1 | 1=off 2=on | yes | pdu_type=switched일 때만 읽는다 |
| pdu | 1.3.6.1.4.1.318.1.1.26.10.2.2.1 | 5 | metered outlet status table column 5 | PowerNet-MIB | 60 | outlet_current_a | outlet_current_a | A | 0.1 | - | yes | pdu_type=metered일 때만 읽는다 |

### 1.5 NetBotz — NETBOTZ-MIB (enterprise 5528)

센서는 인덱스가 아니라 **센서 자신의 label**로 구분한다. 모든 행의 confidence는 `documented`이다.

| device_class | table_oid | column_sub | mib_object | mib | poll_interval_s | metric | telemetry_key | unit | scale | value_map | m_ext | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| netbotz | 1.3.6.1.4.1.5528.100.4.1.1.1 | 4 | temperature sensor label | NETBOTZ-MIB | 60 | - | - | text | - | - | - | 센서 label |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.1.1 | 7 | temperature sensor value | NETBOTZ-MIB | 60 | temp_c | temp_c | °C | 0.1 | - | yes | NetBotz 웹 UI 값과 대조할 대상이다 |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.2.1 | 4 | humidity sensor label | NETBOTZ-MIB | 60 | - | - | text | - | - | - | 센서 label |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.2.1 | 7 | humidity sensor value | NETBOTZ-MIB | 60 | humidity_pct | humidity_pct | %RH | 0.1 | - | yes | - |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.3.1 | 4 | state sensor label | NETBOTZ-MIB | 60 | - | - | text | - | - | - | 아래 상태 종류를 이 label로 정한다 |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.3.1 | 7 | state sensor value (leak) | NETBOTZ-MIB | 60 | leak | leak | state | 1 | 1=dry 2=wet | yes | label이 leak·water·fluid·누수에 맞을 때 |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.3.1 | 7 | state sensor value (door) | NETBOTZ-MIB | 60 | door | door | state | 1 | 1=closed 2=open | yes | label이 door·contact·access·도어·출입에 맞을 때 |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.3.1 | 7 | state sensor value (smoke) | NETBOTZ-MIB | 60 | smoke | smoke | state | 1 | 1=clear 2=detected | yes | label이 smoke·fire·연기·화재에 맞을 때 |
| netbotz | 1.3.6.1.4.1.5528.100.4.1.3.1 | 7 | state sensor value (unlabelled) | NETBOTZ-MIB | 60 | contact_state | contact_state | state | 1 | 원시값 state(<n>) | yes | 어느 label에도 맞지 않을 때. 알람으로 해석하지 않는다 |

### 1.6 CRAC — Liebert iCOM, LIEBERT-GP MIB (enterprise 476)

장비 `protocol`이 비어 있거나 snmp·icom·icom-snmp·snmpv2c·snmpv3일 때만 읽는다. 그 밖의 값(예: BACnet)이면 `unsupported`를 반환한다(BACnet은 미구현). 모든 행의 confidence는 `documented`이다.

| device_class | oid | access | mib_object | mib | poll_interval_s | metric | telemetry_key | unit | scale | value_map | m_ext | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| crac | 1.3.6.1.4.1.476.1.42.3.4.1.1.1.0 | get | system state | LIEBERT-GP | 60 | state_system | state_system | state | 1 | 1=on 2=standby 3=off | yes | - |
| crac | 1.3.6.1.4.1.476.1.42.3.4.1.1.2.0 | get | cooling state | LIEBERT-GP | 60 | state_cooling | state_cooling | state | 1 | 1=on 2=standby 3=off | yes | - |
| crac | 1.3.6.1.4.1.476.1.42.3.4.5.1.1.1.0 | get | fan speed | LIEBERT-GP | 60 | fan_pct | fan_pct | % | 1 | - | yes | - |
| crac | 1.3.6.1.4.1.476.1.42.3.9.20.1.0 | get | active alarm count | LIEBERT-GP | 60 | alarm_count | alarm_count | count | 1 | - | yes | - |
| crac | 1.3.6.1.4.1.476.1.42.3.4.1.2.3 (column 1) | walk | supply air temperature | LIEBERT-GP-ENVIRONMENTAL | 60 | supply_temp_c | supply_temp_c | °C | 0.1 | - | yes | iCOM 표시값과 대조할 대상이다. 센서가 여럿이면 label sensor<n> |
| crac | 1.3.6.1.4.1.476.1.42.3.4.1.2.4 (column 1) | walk | return air temperature | LIEBERT-GP-ENVIRONMENTAL | 60 | return_temp_c | return_temp_c | °C | 0.1 | - | yes | - |
| crac | 1.3.6.1.4.1.476.1.42.3.4.2.2.3 (column 1) | walk | humidity | LIEBERT-GP-ENVIRONMENTAL | 60 | humidity_pct | humidity_pct | %RH | 0.1 | - | yes | - |

### 1.7 네트워크 — IF-MIB · ENTITY-SENSOR-MIB · CISCO-ENVMON-MIB

대상 kind는 switch·router·sbc·server·storage이다. confidence는 전부 `verified`이다.

| device_class | table_oid | column_sub | mib_object | mib | poll_interval_s | metric | telemetry_key | unit | scale | value_map | m_ext | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| network | 1.3.6.1.2.1.2.2.1 | 2 | ifDescr | IF-MIB (RFC 2863) | 60 | - | - | text | - | - | - | 포트 label |
| network | 1.3.6.1.2.1.2.2.1 | 3 | ifType | IF-MIB (RFC 2863) | 60 | - | - | enum | 1 | 6=ethernetCsmacd 117=gigabitEthernet만 포트로 센다 | - | VLAN·루프백·포트채널은 제외한다 |
| network | 1.3.6.1.2.1.2.2.1 | 7 | ifAdminStatus | IF-MIB (RFC 2863) | 60 | - | - | state | 1 | 1=up 2=down 3=testing | - | ports_admin_down 계산에 쓴다 |
| network | 1.3.6.1.2.1.2.2.1 | 8 | ifOperStatus | IF-MIB (RFC 2863) | 60 | port_oper_status | port_oper_status | state | 1 | 1=up 2=down 3=testing 4=unknown 5=dormant 6=notPresent 7=lowerLayerDown | yes | 포트별 행. ports_total·ports_up 계산에도 쓴다 |
| network | 1.3.6.1.2.1.99.1.1.1 | 1 | entPhySensorType | ENTITY-SENSOR-MIB (RFC 3433) | 60 | - | - | enum | 1 | 3=amperes 4=voltsDC 5=voltsAC 6=watts 8=celsius 9=percentRH 10=rpm | - | 1·2·7(other·unknown·hertz)은 보고하지 않는다 |
| network | 1.3.6.1.2.1.99.1.1.1 | 2 | entPhySensorScale | ENTITY-SENSOR-MIB (RFC 3433) | 60 | - | - | enum | - | 1..17 → 10^-24..10^24 | - | 지수다. 곱셈 계수가 아니다 |
| network | 1.3.6.1.2.1.99.1.1.1 | 3 | entPhySensorPrecision | ENTITY-SENSOR-MIB (RFC 3433) | 60 | - | - | digits | - | - | - | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (celsius) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | temp_c | temp_c | °C | value × 10^scale × 10^-precision | - | yes | entPhySensorOperStatus가 1이 아닌 센서는 건너뛴다 |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (voltsDC) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | sensor_voltsDC | sensor_voltsdc | V | value × 10^scale × 10^-precision | - | yes | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (voltsAC) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | sensor_voltsAC | sensor_voltsac | V | value × 10^scale × 10^-precision | - | yes | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (amperes) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | sensor_amperes | sensor_amperes | A | value × 10^scale × 10^-precision | - | yes | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (watts) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | sensor_watts | sensor_watts | W | value × 10^scale × 10^-precision | - | yes | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (percentRH) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | sensor_percentRH | sensor_percentrh | %RH | value × 10^scale × 10^-precision | - | yes | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 4 | entPhySensorValue (rpm) | ENTITY-SENSOR-MIB (RFC 3433) | 60 | sensor_rpm | sensor_rpm | rpm | value × 10^scale × 10^-precision | - | yes | - |
| network | 1.3.6.1.2.1.99.1.1.1 | 5 | entPhySensorOperStatus | ENTITY-SENSOR-MIB (RFC 3433) | 60 | - | - | state | 1 | 1=ok 2=unavailable 3=nonoperational | - | 필터로만 쓴다 |
| network | 1.3.6.1.4.1.9.9.13.1.3.1 | 2 | ciscoEnvMonTemperatureStatusDescr | CISCO-ENVMON-MIB | 60 | - | - | text | - | - | - | ENTITY-SENSOR에서 temp_c가 없을 때만 읽는다 |
| network | 1.3.6.1.4.1.9.9.13.1.3.1 | 3 | ciscoEnvMonTemperatureStatusValue | CISCO-ENVMON-MIB | 60 | temp_c | temp_c | °C | 1 | - | yes | ENTITY-SENSOR에서 temp_c가 없을 때만 읽는다 |
| network | 1.3.6.1.4.1.9.9.13.1.3.1 | 6 | ciscoEnvMonTemperatureState | CISCO-ENVMON-MIB | 60 | - | - | state | 1 | 1=normal 2=warning 3=critical 4=shutdown 5=notPresent 6=notFunctioning | - | WALK로 읽지만 보내지 않는다 |
| network | 1.3.6.1.4.1.9.9.13.1.5.1 | 2 | ciscoEnvMonSupplyStatusDescr | CISCO-ENVMON-MIB | 60 | - | - | text | - | - | - | PSU label |
| network | 1.3.6.1.4.1.9.9.13.1.5.1 | 3 | ciscoEnvMonSupplyState | CISCO-ENVMON-MIB | 60 | psu_state | psu_state | state | 1 | 1=normal 2=warning 3=critical 4=shutdown 6=notFunctioning | yes | 5(notPresent)는 보고하지 않는다 |

### 1.8 식별 OID (주기 폴링 아님)

| oid | mib_name | used_by | runtime_use | note |
|---|---|---|---|---|
| 1.3.6.1.2.1.1.1.0 | sysDescr | probe-agent/src/services/ups-probe-engine.js, oid-catalog.js SYS_DESCR | 미사용 | ups-probe-engine.js는 에이전트 런타임에서 import되지 않는다 |
| 1.3.6.1.2.1.1.2.0 | sysObjectID | ups-probe-engine.js, oid-catalog.js SYS_OBJECT_ID | 미사용 | 벤더 접두 표(APC 318 등)가 함께 있다 |
| 1.3.6.1.2.1.1.5.0 | sysName | ups-probe-engine.js | 미사용 | - |
| 1.3.6.1.2.1.2.1.0 | ifNumber | oid-catalog.js IF_MIB.if_number | 미사용 | 카탈로그에만 있다 |

### 1.9 부록 A 대조 (27키)

| appendix_a_key | produced | producer | note |
|---|---|---|---|
| in_v | yes | UPS 폴 | 1원소 배열 |
| in_a | no | - | 미구현 |
| in_hz | no | - | 미구현 |
| out_v | yes | UPS 폴 | 1원소 배열 |
| out_a | no | - | 미구현 |
| out_hz | no | - | 미구현 |
| load_pct | yes | UPS 폴 | - |
| load_kva | no | - | 미구현 |
| load_kw | no | - | 미구현 |
| bat_pct | yes | UPS 폴 | - |
| bat_v | no | - | 미구현. UPS-MIB upsBatteryVoltage는 읽지만 쓰지 않는다 |
| bat_a | no | - | 미구현 |
| bat_temp_c | yes | UPS 폴 | - |
| runtime_s | yes | UPS 폴 | 분 단위로 반올림한 값 × 60 |
| status | yes | UPS 폴 | online·on_battery·bypass·off·null |
| bypass | no | - | 미구현 |
| selftest | no | - | 미구현 |
| selftest_ts | no | - | 미구현 |
| alarm_bits | no | - | 미구현 |
| int_temp_c | no | - | 미구현 |
| fan_ok | no | - | 미구현 |
| bat_replace_flag | yes | UPS 폴 | 항상 false(§2 D-03) |
| bat_installed | no | - | 미구현 |
| bat_due | no | - | 미구현 |
| fw | yes | UPS 폴 | - |
| comm_ok | yes | UPS 폴, 비UPS 수집기 | - |
| poll_latency_ms | yes | UPS 폴 | 비UPS 수집기는 보내지 않는다 |

집계: 부록 A 27키 중 **생산 11 / 미구현 16**. 부록 A 밖 키(`m_ext`)는 **37개**다(§1.10). 비UPS 수집기가 만들고, 계약 스키마(`telemetry.schema.json`의 `additionalProperties`)가 허용한다. 처리 방안은 DECISIONS Q-2026-10-26-14에 남겼다.

### 1.10 부록 A 밖 키 (m_ext) 목록

| telemetry_key | device_class | source | value_type |
|---|---|---|---|
| load_state | pdu | measured | number(state) |
| power_kw | pdu | measured | number |
| peak_power_kw | pdu | measured | number |
| energy_kwh | pdu | measured | number |
| phase_load_state | pdu | measured | number(state) |
| phase_current_a | pdu | measured | number |
| phase_voltage_v | pdu | measured | number |
| phase_imbalance_pct | pdu | derived | number |
| outlet_state | pdu | measured | number(state) |
| outlet_current_a | pdu | measured | number |
| outlets_on | pdu | derived | number |
| temp_c | netbotz, network | measured | number |
| humidity_pct | netbotz, crac | measured | number |
| leak | netbotz | measured | number(state) |
| door | netbotz | measured | number(state) |
| smoke | netbotz | measured | number(state) |
| contact_state | netbotz | measured | number(state) |
| state_system | crac | measured | number(state) |
| state_cooling | crac | measured | number(state) |
| fan_pct | crac | measured | number |
| alarm_count | crac | measured | number |
| supply_temp_c | crac | measured | number |
| return_temp_c | crac | measured | number |
| cooling_available | crac | derived | number(0 또는 1) |
| delta_t_c | crac | derived | number |
| port_oper_status | network | measured | number(state) |
| ports_total | network | measured | number |
| ports_up | network | measured | number |
| ports_admin_down | network | derived | number |
| ports_down_unexpected | network | derived | number |
| sensor_voltsdc | network | measured | number |
| sensor_voltsac | network | measured | number |
| sensor_amperes | network | measured | number |
| sensor_watts | network | measured | number |
| sensor_percentrh | network | measured | number |
| sensor_rpm | network | measured | number |
| psu_state | network | measured | number(state) |

전송 형태(`adapt.collectorPoint`) 관련 사실:
- `m`은 평면 객체다. 키 하나에 값이 하나만 들어간다. 한 장비에서 같은 metric이 여러 행이면(상 L1/L2/L3, 포트별 `port_oper_status`, 콘센트별 값, 센서 여러 개) **마지막 행의 값 하나만** 남는다. 행 label은 텔레메트리에 실리지 않는다.
- 숫자 값이 있으면 숫자를 보낸다. 상태 metric도 숫자 코드(예: `load_state`=1)로 나가고, `str_value`(normal 등)는 숫자가 없을 때만 보낸다.
- `raw_value`·`unit`·`oid`·`confidence`·`label`은 수집기 결과에만 있고 계약 텔레메트리로는 가지 않는다.
- Local Console에는 같은 계약 포인트가 간다(`console/client.js` `addPoint`).

---

## §2. 파생 메트릭 표

| derived_id | output_key | device_class | formula | input_keys | update_condition | sent_as | source_file | note |
|---|---|---|---|---|---|---|---|---|
| D-01 | runtime_s | ups | APC: round(TimeTicks ÷ 6000) × 60. UPS-MIB: 분 × 60 | upsAdvBatteryRunTimeRemaining 또는 upsEstimatedMinutesRemaining | 성공한 UPS 폴마다 | appendix_a | probe-agent/src/services/ups-metrics.js, contract/adapt.js | 해상도 60초 |
| D-02 | status | ups | output_source 매핑(§1.1·§1.2 표) | upsBasicOutputStatus 또는 upsOutputSource | 성공한 UPS 폴마다 | appendix_a | probe-agent/src/contract/adapt.js | 매핑되지 않는 값은 null |
| D-03 | bat_replace_flag | ups | battery_status 문자열이 replace를 포함하면 true | battery_status | 성공한 UPS 폴마다 | appendix_a | probe-agent/src/contract/adapt.js | battery_status는 normal·low·depleted·unknown만 되므로 항상 false |
| D-04 | in_v, out_v | ups | APC: 값 그대로. UPS-MIB: 값 ÷ 10. 1원소 배열 | input_v, output_v | 성공한 UPS 폴마다(값이 숫자일 때) | appendix_a | probe-agent/src/services/ups-metrics.js | Q-2026-10-26-16 |
| D-05 | comm_ok | ups, 비UPS | 폴 결과 ok가 false가 아니면 true | 폴 결과 | 모든 폴(실패 포함) | appendix_a | probe-agent/src/contract/adapt.js | - |
| D-06 | poll_latency_ms | ups | 폴 종료 시각 − 시작 시각 | - | 모든 UPS 폴(실패 포함) | appendix_a | probe-agent/src/pollers/ups.js | - |
| D-07 | health_score | ups | 100에서 감점: bat<50이면 (50−bat)×1.5, load>80이면 (load−80)×2, temp>35이면 (temp−35)×4, battery_status가 low·depleted면 40, onBattery면 30. 0~100으로 자른다 | battery_pct, load_pct, temp_c, battery_status, output_source | 성공한 UPS 폴마다 | 미전송 | probe-agent/src/services/ups-metrics.js | 계약 텔레메트리에 포함되지 않는다(내부 값) |
| D-08 | status(내부) | ups | health_score ≥80 ok, ≥50 warn, 그 밖 critical | health_score | 성공한 UPS 폴마다 | 미전송 | probe-agent/src/services/ups-metrics.js | 계약 status(D-02)와 다른 값이다 |
| D-09 | phase_imbalance_pct | pdu | round((max − min) ÷ avg × 1000) ÷ 10. avg가 0이면 0 | phase_current_a(상 2개 이상) | 성공한 PDU 폴에서 상 전류가 2개 이상일 때 | m_ext | probe-agent/src/pollers/pdu.js | label은 L1/L2/L3 형식이다(전송 안 됨) |
| D-10 | outlets_on | pdu | outlet_state가 on인 콘센트 수 | outlet_state | switched PDU에서 콘센트 행이 1개 이상일 때 | m_ext | probe-agent/src/pollers/pdu.js | label on/total(전송 안 됨) |
| D-11 | cooling_available | crac | state_cooling이 있으면 그 값이 on인지, 없으면 state_system이 on인지. 1 또는 0 | state_cooling, state_system | 둘 중 하나라도 읽혔을 때 | m_ext | probe-agent/src/pollers/crac.js | str_value cooling 또는 상태 문자열. alarm_count>0이면 label alarms <n> |
| D-12 | delta_t_c | crac | round((return − supply) × 10) ÷ 10 | supply_temp_c, return_temp_c | 둘 다 읽혔을 때 | m_ext | probe-agent/src/pollers/crac.js | 센서가 여럿이면 각 metric의 첫 행 값을 쓴다 |
| D-13 | ports_admin_down | network | 물리 포트 중 ifAdminStatus=2 수 | ifType, ifAdminStatus | 물리 포트가 1개 이상일 때 | m_ext | probe-agent/src/pollers/network.js | - |
| D-14 | ports_down_unexpected | network | max(0, ports_total − ports_up − ports_admin_down) | ports_total, ports_up, ports_admin_down | 물리 포트가 1개 이상일 때 | m_ext | probe-agent/src/pollers/network.js | 관리상 up인데 down인 포트 수 |
| D-15 | ports_total, ports_up | network | 물리 포트 수, 그중 ifOperStatus=1 수 | ifType, ifOperStatus | 물리 포트가 1개 이상일 때 | m_ext | probe-agent/src/pollers/network.js | 코드에는 source=measured로 표시되어 있다 |
| D-16 | entity sensor value | network | value × 10^(scale 지수) × 10^-precision, 소수 3자리로 반올림 | entPhySensorValue, entPhySensorScale, entPhySensorPrecision | 센서 OperStatus가 1이거나 없을 때 | m_ext | probe-agent/src/services/oid-catalog.js | sensorValue() |
| D-17 | 모든 scaled 값 | pdu, netbotz, crac | round(raw × scale × 1000) ÷ 1000 | 원시 정수 | 매 폴 | 해당 키 | probe-agent/src/services/oid-catalog.js | scaled(). raw_value는 수집기 결과에만 남는다 |

---

## §3. 알람 엔진 규칙 표

### 3.0 엔진 공통 규칙 (`alarms/engine.js`, `alarms/codes.js`)

| rule | value | env_override | note |
|---|---|---|---|
| severity_source | 부록 B 코드 사전(codes.js SEVERITY) | 없음 | 폴러가 붙인 P1/P2는 코드 선택에만 쓴다. 이벤트 심각도는 언제나 사전 값이다. 사이트별 오버라이드는 포털 정책이다 |
| dedup_key | device_id + code (한 장비·한 코드에 열린 알람 1개) | 없음 | alarm_id는 그 알람을 만들 때 UUIDv4로 정하고 해제할 때까지 바뀌지 않는다. trap과 폴이 같은 키를 쓰므로 같은 결함은 alarm_id 하나다 |
| update_interval | 900000 ms(15분) | ALARM_UPDATE_EVERY_MS | 열린 알람이 계속 관측되어도 alarm_update는 15분에 1회까지만 |
| clear_rule_poll | 성공한 폴 사이클 1개 동안 관측되지 않으면 그다음 성공한 폴의 시작에서 alarm_clear | 없음 | beginCycle. UPS_COMM_LOST와 latched 알람은 이 규칙을 적용받지 않는다 |
| hysteresis | 미구현(데드밴드 없음) | - | 임계 비교는 엄격 부등호 한 번이다. 해제 지연은 clear_rule_poll과 flapping 규칙에서만 생긴다 |
| flap_window | 900000 ms(15분) | ALARM_FLAP_WINDOW_MS | - |
| flap_raises | 3 | ALARM_FLAP_RAISES | 15분 안에 같은 키가 3번째 raise되면 그 알람에 flapping=true를 붙인다 |
| flap_quiet | 900000 ms(15분) | ALARM_FLAP_QUIET_MS | flapping 알람은 15분 연속으로 관측되지 않아야 해제된다. 이벤트 detail.flapping=true |
| comm_lost_hold | 1800000 ms(30분) | 없음 | 부록 B UPS_COMM_LOST(30분) |
| capacity_hold | 7200000 ms(2시간) | 없음 | UPS_ON_BATTERY가 열려 있는 동안과, 마지막으로 on-battery를 관측했거나 해제한 뒤 2시간 동안은 UPS_BATTERY_CAPACITY_LOW를 새로 raise하지 않는다 |
| latched | trap으로만 볼 수 있는 조건(apc-mib.js POLL_SEEN에 없는 코드). 폴 사이클로는 해제하지 않고 clear trap을 기다린다 | 없음 | 해당 코드: UPS_COMM_LOST, UPS_SELFTEST_FAIL |
| maintenance_window | 필드 device_id?, ledger_id?, site_id?, from?, until, reason?. 셋 다 없으면 노드 전체다. Local Console 설정에서 5분마다 받는다 | 없음 | 창 안의 이벤트도 포털로 보내고 detail.maintenance=true를 붙인다. suppressed=maintenance로 표시하므로 로컬 통보는 하지 않는다 |
| maintenance_end | 창 안에서 raise된 알람이 창이 끝난 뒤에도 남아 있으면 alarm_update(detail.maintenance_ended=true)를 보내고 로컬 통보는 raise로 처리한다 | 없음 | - |
| persistence | 열린 알람과 on-battery 시각은 buffer SQLite `state` 표(name=alarm_engine)에 저장한다. 재기동 후에도 alarm_id가 유지된다 | 없음 | flap 이력과 30분 comm-loss 계산은 저장하지 않는다. 재기동하면 0부터 다시 센다 |
| unmapped_alert | classify가 null인 폴러 경보는 알람으로 만들지 않고 stats.unmapped_alerts에 센다 | 없음 | 예: output_source가 onSmartBoost·rebooting·unknown·none일 때 |
| reachability_alert | 폴러의 reachability 경보(P2, 1h·2h·…·24h 간격)는 알람 엔진으로 가지 않는다 | 없음 | comm loss는 폴 결과로만 판정한다(commStatus) |
| non_ups_alarms | 비UPS 수집기(PDU·NetBotz·CRAC·네트워크)는 임계 평가를 하지 않는다. 알람이 없다 | 없음 | Q-2026-10-26-05 답(A): 코드 추가는 계약 v1.2 |

### 3.1 UPS 임계 기본값 (`pollers/thresholds.js`)

| threshold_key | default | unit | comparison | console_override | note |
|---|---|---|---|---|---|
| battery_critical_pct | 30 | % | battery_pct < 값 | battery_pct.critical | - |
| battery_warn_pct | 60 | % | battery_pct < 값 (critical이 아닐 때) | battery_pct.warn | - |
| temp_critical_c | 45 | °C | temp_c > 값 | temp_c.critical | 배터리 온도 |
| temp_warn_c | 38 | °C | temp_c > 값 (critical이 아닐 때) | temp_c.warn | 배터리 온도 |
| load_critical_pct | 90 | % | load_pct > 값 | load_pct.critical | - |
| load_warn_pct | 75 | % | load_pct > 값 (critical이 아닐 때) | load_pct.warn | - |
| runtime_critical_min | 5 | min | runtime_min < 값, output_source=onBattery일 때만 | runtime_min.critical | - |
| runtime_warn_min | 15 | min | runtime_min < 값 (critical이 아닐 때), onBattery일 때만 | runtime_min.warn | - |

우선순위: Local Console 장비별 값 > 콘솔 전체 값 > 위 기본값(`fromConsole`).

### 3.2 부록 B 코드별 규칙 (22개, 1:1)

| code | default_severity | impl_status | source | raise_condition | clear_condition | hold_rule | latched | dedup_key | maintenance_behavior | device_scope | source_file | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| UPS_ON_BATTERY | P1 | implemented | poll, trap | 폴: output_source=onBattery(APC 3, UPS-MIB 5). trap: upsOnBattery(5) | 폴: 1사이클 동안 미관측. trap: powerRestored(9) | 없음. 열려 있으면 UPS_BATTERY_CAPACITY_LOW를 억제 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, trap/apc-mib.js | 해제 시각부터 capacity_hold 2시간이 시작된다 |
| UPS_LOW_BATTERY | P1 | implemented | poll, trap | 폴: battery_pct < 30, 또는 onBattery 중 runtime_min < 5, 또는 battery_status가 low·depleted(APC·UPS-MIB 3·4). trap: lowBattery(7) | 폴: 1사이클 동안 미관측. trap: returnFromLowBattery(11) | 없음 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, pollers/ups.js | 세 폴 조건이 같은 키를 쓴다(알람 1개) |
| UPS_OUTPUT_OFF | P1 | implemented | poll, trap | 폴: output_source=off(APC upsBasicOutputStatus 7만 해당). trap: upsTurnedOff(12) | 폴: 1사이클 동안 미관측. trap: upsTurnedOn(30) | 없음 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, trap/apc-mib.js | UPS-MIB 경로에서는 off가 나오지 않는다 |
| UPS_BATTERY_FAILED | P1 | 미구현 | - | classify에 battery_status가 fail을 포함하는 분기는 있다. 하지만 battery_status는 fail 값을 만들지 않고 경보 조건도 low·depleted·replace뿐이라 발생 경로가 없다. trap 매핑 없음 | - | - | - | device_id + code | - | device | alarms/codes.js | Q-2026-10-26-15 |
| UPS_OVERLOAD_SHUTDOWN_IMMINENT | P1 | 미구현 | - | 코드 사전에만 있다 | - | - | - | - | - | device | alarms/codes.js | Q-2026-10-26-15 |
| UPS_OVERLOAD | P2 | implemented | poll, trap | 폴: load_pct > 75(warn) 또는 > 90(critical). 둘 다 이 코드다. trap: upsOverload(2) | 폴: 1사이클 동안 미관측. trap: upsOverloadCleared(33) | 없음 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, pollers/ups.js | load_critical이어도 SHUTDOWN_IMMINENT가 아니다 |
| UPS_ON_BYPASS | P2 | implemented | poll, trap | 폴: output_source가 bypass를 포함(APC 6 softwareBypass, UPS-MIB 4 bypass). trap: hardwareFailureBypass(20), softwareBypass(21), switchedBypass(22) | 폴: 1사이클 동안 미관측. trap: returnFromBypass(23) | 없음 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, trap/apc-mib.js | APC 폴 값 9·10은 unknown이 되어 이 코드가 나오지 않는다. trap 20·22로만 잡힌다 |
| UPS_HIGH_TEMP | P2 | implemented | poll | 폴: 배터리 temp_c > 38(warn) 또는 > 45(critical). 둘 다 이 코드다 | 폴: 1사이클 동안 미관측 | 없음 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, pollers/ups.js | trap 매핑 없음 |
| UPS_BATTERY_REPLACE | P2 | implemented | trap | trap: upsBatteryNeedsReplacement(17). 폴 분기(battery_status가 replace를 포함)는 있지만 그 값이 나오지 않아 발생하지 않는다 | trap: upsBatteryReplaced(36). 이 코드는 POLL_SEEN에 있어 latched가 아니다. 그래서 다음 성공 폴 사이클이 미관측으로 해제한다 | 없음 | no | device_id + code | 공통 규칙 | device | trap/apc-mib.js, alarms/engine.js | trap으로 연 알람이 폴링 중인 장비에서는 약 2폴 주기 뒤 해제된다. Q-2026-10-26-16 |
| UPS_FAN_FAIL | P2 | 미구현 | - | fan_ok를 폴링하지 않는다. trap 매핑 없음 | - | - | - | - | - | device | alarms/codes.js | Q-2026-10-26-15 |
| COLLECTOR_DOWN | P2 | 미구현 | - | NODE_CODES에만 있다. 발생시키는 코드가 Probe·Local Console에 없다 | - | - | - | - | - | node(device_id null) | alarms/codes.js | Q-2026-10-26-15 |
| UPS_SELFTEST_FAIL | P3 | implemented | trap | trap: upsDiagnosticsFailed(3) | trap: upsDiagnosticsPassed(10)만 해제한다 | 없음 | yes | device_id + code | 공통 규칙 | device | trap/apc-mib.js | 폴 사이클로는 해제되지 않는다 |
| UPS_COMM_LOST | P3 | implemented | poll, trap | 폴: 첫 실패 폴부터 30분 넘게 응답이 없으면 raise(detail.down_min). trap: communicationLost(1)를 받고 30분 안에 communicationEstablished가 오지 않으면 handler.tick(60초 주기)이 raise | 폴: 첫 성공 폴에서 해제(trap으로 연 경우도 같다). trap: communicationEstablished(8) | 30분 | trap으로 raise하면 yes | device_id + code | 공통 규칙 | device | alarms/engine.js, trap/handler.js | 30분 계산은 재기동하면 0부터 다시 시작한다 |
| UPS_RUNTIME_LOW_WARN | P3 | implemented | poll | 폴: onBattery 중 5 ≤ runtime_min < 15 | 폴: 1사이클 동안 미관측 | 없음 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, pollers/ups.js | trap 매핑 없음 |
| UPS_BATTERY_CAPACITY_LOW | P3 | implemented | poll | 폴: 30 ≤ battery_pct < 60 | 폴: 1사이클 동안 미관측 | UPS_ON_BATTERY가 열려 있거나 그 뒤 2시간 안이면 새 raise 안 함 | no | device_id + code | 공통 규칙 | device | alarms/codes.js, alarms/engine.js | 부록 B v1.1, Q-2026-10-25-07 |
| PORTAL_LINK_DOWN | P3 | 미구현 | - | NODE_CODES에만 있다. 발생시키는 코드가 없다 | - | - | - | - | - | node(device_id null) | alarms/codes.js | Q-2026-10-26-15 |
| UPS_SELFTEST_OK | P4 | 미구현 | - | upsDiagnosticsPassed(10)는 UPS_SELFTEST_FAIL을 해제할 뿐 이 코드 이벤트를 만들지 않는다 | - | - | - | - | - | device | trap/apc-mib.js | Q-2026-10-26-15 |
| UPS_RETURN_FROM_BATTERY | P4 | 미구현 | - | 배터리 복귀는 UPS_ON_BATTERY의 alarm_clear로만 나간다. 이 코드 이벤트는 만들지 않는다 | - | - | - | - | - | device | alarms/engine.js | Q-2026-10-26-15 |
| UPS_CONFIG_CHANGED | P4 | 미구현 | - | 코드 사전에만 있다 | - | - | - | - | - | device | alarms/codes.js | Q-2026-10-26-15 |
| BATTERY_EOL_90D | P4 | 미구현 | - | 코드 사전에만 있다. bat_due를 폴링하지 않는다 | - | - | - | - | - | device | alarms/codes.js | Q-2026-10-26-15 |
| CLOCK_DRIFT | P4 | implemented | system | 성공한 heartbeat 응답의 Date 헤더와 노드 시계가 (차이 − 1초) > 60초면 raise(detail.drift_s) | 차이가 60초 이하로 돌아오면 clear | 없음 | - | 노드당 1개(forwarder 메모리 drift 상태) | 알람 엔진을 거치지 않으므로 유지보수 창·flapping·15분 update 규칙이 없다 | node(device_id null) | forwarder.js | 포털로만 보낸다(postEvents). Local Console로는 가지 않는다. 60초 heartbeat마다 판정한다 |
| CONFIG_CONFLICT | P4 | 미구현 | - | NODE_CODES에만 있다. config pull(§3.7)이 미구현이다 | - | - | - | - | - | node(device_id null) | alarms/codes.js | Q-2026-10-26-15 |

대조 결과(부록 B 22개): 코드 사전(`codes.js` SEVERITY) **일치 22/22**, 심각도 일치 22/22. 발생 경로가 있는 코드 **12개**, **미구현 10개**. 부록 B에 없는 알람 코드를 내는 곳 **0개**. `SNMP_TRAP_UNKNOWN`은 알람 코드가 아니며 이벤트로 나가지 않는다(§4.2).

### 3.3 이벤트 필드 (엔진이 만드는 것)

| field | value |
|---|---|
| event_id | UUIDv4, 이벤트마다 새로 |
| alarm_id | 알람 생애 동안 불변 |
| device_id | tenant, site_id, serial을 세로선 문자로 이어 붙인 문자열의 sha1 앞 16자(계약 §2). serial이 없으면 serial 자리에 ledger:<원장 id>를 넣는다(provisional) |
| kind | alarm_raise, alarm_update, alarm_clear |
| severity | 부록 B 사전 값 |
| title | 최대 200자. 해제 이벤트는 "Cleared: " + 원래 title |
| detail | 폴: metric, value, threshold. trap: trap, trap_oid, snmp_version, vb1..vb4(스칼라, 문자열은 120자까지). comm loss: down_min. 그 밖: flapping, maintenance, maintenance_ended |
| source | poll(comm loss), rule(임계), trap, system(CLOCK_DRIFT) |
| local_notified | Local Console이 응답한 경우에만 붙는다 |

---

## §4. trap 매핑표 (`trap/apc-mib.js` 전부)

PowerNet-MIB trap은 SNMPv1 TRAP-TYPE이고 ENTERPRISE는 apc(1.3.6.1.4.1.318)이다. 그래서 v1 trap은 enterprise 318 / generic 6 / specific N으로 오고, v2c·v3 trap의 snmpTrapOID는 1.3.6.1.4.1.318.0.N이다(RFC 3584 §3.1). 두 경우 모두 N으로 찾는다. 수신은 UDP `CFLEX_TRAP_PORT`이고 기본값은 1162다. 컨테이너 프로파일(Podman)에서는 호스트가 162를 1162로 넘기고, 베어 프로파일에서는 162를 쓴다. v1, v2c, v3(authPriv까지)를 받는다. inform에는 프로토콜이 요구하는 응답만 하고, 그 밖에 장비로 보내는 것은 없다.

### 4.1 매핑 행 (18개)

| specific | trap_oid_v2 | v1_enterprise | v1_generic | v1_specific | powernet_name | appendix_b_code | action | hold | latched_on_raise | poll_seen | sat_check | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.3.6.1.4.1.318.0.1 | 1.3.6.1.4.1.318 | 6 | 1 | communicationLost | UPS_COMM_LOST | raise | comm_lost(30분) | yes | no | Q-2026-10-26-06 | 30분 안에 8이 오면 raise하지 않는다 |
| 2 | 1.3.6.1.4.1.318.0.2 | 1.3.6.1.4.1.318 | 6 | 2 | upsOverload | UPS_OVERLOAD | raise | - | no | yes | Q-2026-10-26-06 | - |
| 3 | 1.3.6.1.4.1.318.0.3 | 1.3.6.1.4.1.318 | 6 | 3 | upsDiagnosticsFailed | UPS_SELFTEST_FAIL | raise | - | yes | no | Q-2026-10-26-06 | - |
| 5 | 1.3.6.1.4.1.318.0.5 | 1.3.6.1.4.1.318 | 6 | 5 | upsOnBattery | UPS_ON_BATTERY | raise | - | no | yes | Q-2026-10-26-06 | - |
| 7 | 1.3.6.1.4.1.318.0.7 | 1.3.6.1.4.1.318 | 6 | 7 | lowBattery | UPS_LOW_BATTERY | raise | - | no | yes | Q-2026-10-26-06 | - |
| 8 | 1.3.6.1.4.1.318.0.8 | 1.3.6.1.4.1.318 | 6 | 8 | communicationEstablished | UPS_COMM_LOST | clear | - | - | no | Q-2026-10-26-06 | 보류 중인 30분 대기도 지운다 |
| 9 | 1.3.6.1.4.1.318.0.9 | 1.3.6.1.4.1.318 | 6 | 9 | powerRestored | UPS_ON_BATTERY | clear | - | - | yes | Q-2026-10-26-06 | - |
| 10 | 1.3.6.1.4.1.318.0.10 | 1.3.6.1.4.1.318 | 6 | 10 | upsDiagnosticsPassed | UPS_SELFTEST_FAIL | clear | - | - | no | Q-2026-10-26-06 | UPS_SELFTEST_OK는 만들지 않는다 |
| 11 | 1.3.6.1.4.1.318.0.11 | 1.3.6.1.4.1.318 | 6 | 11 | returnFromLowBattery | UPS_LOW_BATTERY | clear | - | - | yes | Q-2026-10-26-06 | - |
| 12 | 1.3.6.1.4.1.318.0.12 | 1.3.6.1.4.1.318 | 6 | 12 | upsTurnedOff | UPS_OUTPUT_OFF | raise | - | no | yes | Q-2026-10-26-06 | - |
| 17 | 1.3.6.1.4.1.318.0.17 | 1.3.6.1.4.1.318 | 6 | 17 | upsBatteryNeedsReplacement | UPS_BATTERY_REPLACE | raise | - | no | yes | Q-2026-10-26-06 | 폴이 이 조건을 관측하지 못해서 다음 폴 사이클에 해제된다(§3.2) |
| 20 | 1.3.6.1.4.1.318.0.20 | 1.3.6.1.4.1.318 | 6 | 20 | hardwareFailureBypass | UPS_ON_BYPASS | raise | - | no | yes | Q-2026-10-26-06 | - |
| 21 | 1.3.6.1.4.1.318.0.21 | 1.3.6.1.4.1.318 | 6 | 21 | softwareBypass | UPS_ON_BYPASS | raise | - | no | yes | Q-2026-10-26-06 | - |
| 22 | 1.3.6.1.4.1.318.0.22 | 1.3.6.1.4.1.318 | 6 | 22 | switchedBypass | UPS_ON_BYPASS | raise | - | no | yes | Q-2026-10-26-06 | - |
| 23 | 1.3.6.1.4.1.318.0.23 | 1.3.6.1.4.1.318 | 6 | 23 | returnFromBypass | UPS_ON_BYPASS | clear | - | - | yes | Q-2026-10-26-06 | - |
| 30 | 1.3.6.1.4.1.318.0.30 | 1.3.6.1.4.1.318 | 6 | 30 | upsTurnedOn | UPS_OUTPUT_OFF | clear | - | - | yes | Q-2026-10-26-06 | - |
| 33 | 1.3.6.1.4.1.318.0.33 | 1.3.6.1.4.1.318 | 6 | 33 | upsOverloadCleared | UPS_OVERLOAD | clear | - | - | yes | Q-2026-10-26-06 | - |
| 36 | 1.3.6.1.4.1.318.0.36 | 1.3.6.1.4.1.318 | 6 | 36 | upsBatteryReplaced | UPS_BATTERY_REPLACE | clear | - | - | yes | Q-2026-10-26-06 | - |

집계: 18행(raise 10, clear 8). 대응하는 부록 B 코드는 8개다(UPS_COMM_LOST, UPS_OVERLOAD, UPS_SELFTEST_FAIL, UPS_ON_BATTERY, UPS_LOW_BATTERY, UPS_OUTPUT_OFF, UPS_BATTERY_REPLACE, UPS_ON_BYPASS). raise가 있는 코드는 모두 clear trap도 있다. trap 번호는 모두 PowerNet-MIB 기준이고, SAT 때 현장 NMC 펌웨어 MIB와 대조한다(Q-2026-10-26-06 답 (A)). 환경·NetBotz·Rack PDU trap은 이 표에 없다(Q-2026-10-26-05 답 (A): 기록만).

### 4.2 trap 처리 경로 (`trap/handler.js`, `trap/listener.js`)

| step | outcome | condition | counted_as | sent_as_event | note |
|---|---|---|---|---|---|
| 1 receive | discarded | 수신기 인증 실패(모르는 community, 모르는 v3 user, digest·복호 오류) | discarded.auth | no | 인벤토리에 있는 장비들의 크리덴셜만 받는다 |
| 1 receive | discarded | 디코드 불가, 또는 trap OID 없음 | discarded.malformed | no | - |
| 2 source | SNMP_TRAP_UNKNOWN (unknown_source) | 송신 주소(v1은 agentAddr도 본다)가 인벤토리에 없음 | unknown_source | no | 최근 목록(최대 200건)과 info 로그에 남긴다. Q-2026-10-26-04 답 (A) |
| 3 credential | discarded | 그 장비 자신의 크리덴셜이 아님(다른 NMC의 community나 v3 user) | discarded.wrong_device_credential | no | warn 로그 |
| 4 lookup | SNMP_TRAP_UNKNOWN (unknown_oid) | OID가 1.3.6.1.4.1.318.0.N이 아니거나 N이 표에 없음. v1 generic trap(coldStart 등, 1.3.6.1.6.3.1.1.5.x)도 여기에 해당한다 | unknown_oid | no | 최근 목록(최대 200건)과 info 로그에 남긴다. 알람이 아니다 |
| 5 map raise | alarm_raise 또는 중복 | 표에서 action=raise | raised 또는 duplicates | yes | 폴과 같은 키다. 중복 억제·flapping·유지보수 창이 똑같이 적용된다 |
| 5 map raise(comm_lost) | held | communicationLost이고 알람이 아직 열려 있지 않음 | comm_lost_pending | 30분 뒤 | tick(60초)이 raise한다 |
| 5 map clear | alarm_clear | 표에서 action=clear | cleared | yes | flapping 때문에 해제가 미뤄지면 tick이 다시 시도한다 |

---

## §5. `collect_diag` 번들 구성

**상태: 계약 정의만 있고 미구현이다.** 코드에서 확인한 사실:
- `forwarder.js`의 PATHS는 heartbeat·inventory·telemetry·events 4개뿐이다. `GET /api/v1/commands`, `POST /api/v1/commands/{cmd_id}/result`, `POST /api/v1/files` 호출 코드가 없다.
- heartbeat 응답의 `commands_pending`은 `stats().commands_pending`에 저장만 된다. 명령을 가져오거나 실행하지 않는다.
- 번들을 만드는 코드도, NMC 이벤트 로그·데이터 로그를 가져오는 코드도 없다. Local Console(`apps/console`)에도 `collect_diag`가 없다.
- D-12a(기능 추가 금지)에 따라 이 WO에서는 추가하지 않았다.

| item | contract_definition | implementation | source |
|---|---|---|---|
| command_type | collect_diag(허용 명령 6종 중 하나. 원격 셸·임의 스크립트 금지) | 미구현 | 계약 00 §3.6, schemas/commands.schema.json |
| command_fetch | heartbeat의 commands_pending > 0이면 GET /api/v1/commands?node_id=<node> | 미구현(commands_pending 저장만) | 계약 00 §3.6, forwarder.js |
| command_result | POST /api/v1/commands/{cmd_id}/result, status ok·failed·rejected, detail 객체 | 미구현 | schemas/commands.schema.json $defs.result |
| upload_path | POST /api/v1/files multipart | 미구현 | 계약 00 §3.5 |
| upload_fields | kind(pm_report·photo·log·config_backup), device_id?, site_id, ts, sha256, file | 미구현 | schemas/files.schema.json |
| upload_kind_for_diag | log(명세 03 §4.2) | 미구현 | 03 §4.2 |
| size_limit | 요청당 25 MB 이하(§3.5). 전송 일반 규칙은 요청당 5 MB 이하(§1) | 미구현 | 계약 00 §1, §3.5 |
| integrity | sha256 필드 = file 부분의 sha256 | 미구현 | schemas/files.schema.json $comment |
| bundle_contents | 계약에 정의되어 있지 않다 | 미구현 | - |
| secret_exclusion | 계약에 번들 규칙이 없다. 일반 원칙만 있다: 사용자 계정·이메일·이름·사용자 IP 전송 금지(§5), config_backup의 비밀 필드 마스킹(03 §4.2) | 미구현 | 계약 00 §5, 03 §4.2 |

참고(기존 구현, `collect_diag`와는 별개): 텔레메트리·이벤트 전송 전에 계약 스키마 화이트리스트(`contract/schema.js` prune)를 적용하고, 차단한 키 수를 `blocked_keys`로 센다. 키 파일·인증서·community·v3 키는 설정에 **경로나 변수 이름으로만** 두고 로그에 쓰지 않는다(`config.js`, `portal/transport.js`).

---

## §6. 데이터 흐름 요약과 출처

**흐름(현재 코드, `d328497`):** 컬렉터(probe-agent)가 Local Console의 `/collector/v1/devices`·`/collector/v1/config`에서 UPS 인벤토리와 SNMP 크리덴셜, 임계, 유지보수 창을 5분마다 받는다. 그다음 60초 주기로 SNMP GET/WALK 폴링을 하고 UDP trap을 받는다. 폴 결과는 `contract/adapt.js`에서 계약 텔레메트리 포인트(부록 A 키 + m_ext)로 바뀐다. 임계 경보와 trap은 `alarms/engine.js`에서 부록 B 코드 알람(raise·update·clear)이 된다. 이 둘은 먼저 Local Console(`/collector/v1/telemetry`·`/collector/v1/events`)로 간다. Local Console은 HAEA 내부 통보를 하고 `local_notified`를 돌려준다. 이어서 같은 데이터가 계약 00 `/api/v1/*`로 포털에 간다(로컬 큐 7일, 멱등 키, 재시도). D-13이 정한 최종 구조는 "컬렉터 N대 → FMS(Local Console) collector API → 포털"이다. 이 구조에서는 포털 송신기가 FMS(app) 노드로 옮겨 가고 컬렉터는 외부 경로를 갖지 않는다. 다만 이것은 **WO-INT-012에서 할 일이고 아직 구현되지 않았다.** 현재 코드에서는 컬렉터의 forwarder가 포털로 직접 보낸다. 포털은 inventory·telemetry·events를 K3 Site Book의 자동 입력으로 쓰고(명세 03 §4.2), 이 문서의 표를 K1 구조화 표(`apc_powernet_traps.csv`, 알람 코드 사전)의 Probe 측 정본으로 적재한다.

### 6.1 표 출처

| doc_section | source_file | last_commit |
|---|---|---|
| §1.0 | probe-agent/src/config.js | 9cd0d1d |
| §1.0 | probe-agent/src/index.js | 9cd0d1d |
| §1.1 §1.2 | probe-agent/src/services/snmp-helpers.js | 9cd0d1d |
| §1.1 §1.2 §2 | probe-agent/src/services/ups-metrics.js | 360011e |
| §1.4 ~ §1.8 §2 | probe-agent/src/services/oid-catalog.js | a4485a1 |
| §1.4 ~ §1.7 §2 | probe-agent/src/pollers/pdu.js, netbotz.js, crac.js, network.js, index.js | ee6476e |
| §3.0 §3.1 | probe-agent/src/pollers/ups.js, thresholds.js | ee6476e |
| §1.9 §1.10 §2 §3.3 | probe-agent/src/contract/adapt.js | 3d5dd6a |
| §3.0 §3.2 | probe-agent/src/alarms/codes.js | e6c6947 |
| §3.0 §3.2 §3.3 | probe-agent/src/alarms/engine.js | 9cd0d1d |
| §3.0 | probe-agent/src/alarms/persist.js | 9cd0d1d |
| §4 | probe-agent/src/trap/apc-mib.js, handler.js, listener.js | 9cd0d1d |
| §3.2 §5 §6 | probe-agent/src/forwarder.js | 9cd0d1d |
| §1.9 §5 | docs/spec/schemas/telemetry.schema.json, files.schema.json, commands.schema.json | e6c6947 |
| §6.2 | probe-agent/sim/*.js | 9cd0d1d |

### 6.2 시뮬레이터 (시뮬레이터 전용, 운영 값 아님)

| sim_file | emulates | values | note |
|---|---|---|---|
| probe-agent/sim/sim-ups.js | APC Smart-UPS, OID_APC_POWERNET 스칼라 | 모델 SRT5KRMXLT, 용량 100%(CHARGE), 배터리 온도 24, 런타임 45분, 출력 120 V, 부하 38%, onLine 또는 onBattery(stdin으로 전환) | 시뮬레이터 전용 |
| probe-agent/sim/sim-pdu.js | APC Rack PDU rPDU2 | LOAD_A 등 환경변수로 상 전류 지정, 원시 정수(0.1 A)로 제공 | 시뮬레이터 전용, 스케일 검증용 |
| probe-agent/sim/sim-netbotz.js | NetBotz 750 센서 표 | TEMPS·STATES 환경변수, 0.1 단위 값, label 순서를 일부러 섞음 | 시뮬레이터 전용 |
| probe-agent/sim/sim-crac.js | Liebert iCOM | SUPPLY_C·RETURN_C·COOLING·ALARMS 환경변수 | 시뮬레이터 전용 |
| probe-agent/sim/sim-switch.js | IF-MIB + ENTITY-SENSOR | VLAN·루프백·포트채널 행, down 포트 1개, 관리상 shut 포트 1개 | 시뮬레이터 전용 |
| probe-agent/sim/sim-trap.js | APC trap 송신 | 시나리오: apc-mib.js 이름 13종 + 매핑 없는 OID 2종(NetBotz형 1.3.6.1.4.1.5528.100.10.2.1, coldStart) | 시뮬레이터 전용. v3 키는 환경변수로만 받는다 |
