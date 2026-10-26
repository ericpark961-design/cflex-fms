# 03. C-Flex FMS 지식베이스·사이트 기준선·AI 운영 응답 명세 (Knowledge & AI-Ops)
### 문서번호: SPEC-CFLEX-KNOWLEDGE-2026-1026 v1.0 · 작성: PM(관리자) · 지시: Eric Park(법인장) 2026-10-26
### 담당: **Codex(포털, 주 구현)** · Claude Code(Probe, 데이터 사전 제공만 — D-12a 동결 준수)
### 선행 계약: `00_INTERFACE_CONTRACT_Probe-Portal_v1.md` v1.1 (반드시 준수) · 관련: 01(내부) · 02(포털) · v1.4 설계서 · D-05·D-08·D-12·D-12a·D-13

---

## 0. 목적과 한 줄 정의

> **"어떤 특별한 상황이 생겼을 때 AI가 (1) 그 사이트·그 장비의 현재와 과거를 누구보다 정확히 알고, (2) 제조사 문서와 현장 경험을 근거로, (3) 무엇을 어떻게 조치해야 하는지 출처와 함께 답하는 것."** — 법인장 지시 요지

이를 위해 포털(cflex.fms.support)에 세 층을 만든다.

| 층 | 이름 | 내용 | 갱신 주체 |
|---|---|---|---|
| K1 | **Vendor Knowledge** (제조사 지식) | APC/Schneider 매뉴얼·설치가이드·KB(FAQ)·MIB·펌웨어 릴리스노트·RBC/배터리 가이드·NMC 가이드·이벤트/알람 코드 사전 | 수집 파이프라인(자동) + PM 큐레이션 |
| K2 | **Field Knowledge** (현장·커뮤니티 지식) | 커뮤니티·포럼·RingOn 기술자 경험을 **"상황 → 원인 후보 → 조치 → 검증"** 런북 형식으로 정제한 것. 원문 전체 복제가 아니라 **요약 + 출처 링크 + 신뢰 등급** | PM/FSE 큐레이션(반자동) |
| K3 | **Site Book** (사이트 기준선) | 테넌트·사이트·유닛별 **빌드업(모델·시리얼·펌웨어·배터리·옵션)**, **환경(실온·습도·공조·바닥)**, **케이블링·전원 경로(입력 분전반·차단기·바이패스·출력·NMC 포트/VLAN/IP)**, **알람·이벤트·PM 히스토리**, **정상 기준값(baseline)** | 포털 DB(Probe 수신 자동) + PM 보고서 임포트 + 현장 입력 |

AI 응답 서비스(§7)는 질문을 받으면 **K3(이 장비는 무엇이고 지금 어떤가) → K1/K2(그 상황에서 무엇을 해야 하나)** 순으로 근거를 모아 답한다. 근거 없는 답은 하지 않고, **장비에 어떤 쓰기도 하지 않는다**(D-05).

---

## 1. 범위·역할 경계

- **포털(Codex)**: K1·K2·K3 저장소, 수집 파이프라인, 검색(하이브리드: 키워드+벡터), AI 응답 API·화면, 평가셋 실행, 큐레이션 UI. 모든 것은 `cflex.fms.support` 뒤.
- **Probe/Local Console(Claude Code)**: **새 기능 없음**(D-12a). 하는 일은 둘뿐 — ① 이미 계약 00으로 보내는 inventory/telemetry/events/files(`collect_diag` 결과 로그 번들·`config_backup`)가 K3의 자동 입력이 된다. ② 포털 지식 입력용 **데이터 사전 문서**(`docs/knowledge/PROBE_DATA_DICTIONARY.md`: 폴링 OID·파생 메트릭·알람 엔진 규칙·trap 매핑표·임계치 기본값)를 작성한다(WO-INT-013, 문서만).
- **RingOn PM/FSE**: K2 런북 승인, K3 현장 입력(케이블링·사진·PM 보고서), 평가셋 정답 검수.
- **HAEA NOC/고객**: 포털 고객 화면에서 질문·열람만. 조치 실행은 사람이 한다.

금지: 장비 쓰기(SET/HTTP 설정 변경) 일체 · 운영 DB·VM 직접 접근 · 비밀값(SNMP community·v3 키·인증서 키·고객 연락처 원문)을 지식 코퍼스에 넣는 것 · 계약 00 밖 Probe 변경 · 수량 44/41/48 혼용.

---

## 2. K1 — Vendor Knowledge (제조사 지식 코퍼스)

### 2.1 수집 대상 (1차: HAEA/HMA/KUS 보유 기종 — 부록 C 시드 기준)

| 분류 | 대상 | 비고 |
|---|---|---|
| UPS 기종 | **SRT5KRMXLT**(Smart-UPS SRT 5000 RM) · **SRYLF20KRMT / SRYLFXBPRM4**(Smart-UPS Ultra On-Line 20kW Li-ion, XBP 배터리팩 4) · SRT3000RMXLA(-NC) · 부록 C에 등장하는 그 외 모델 전부 | 모델별: 사용자 매뉴얼, 설치 가이드, 사양서, 배터리 교체 가이드(RBC/XBP), 안전 안내, 펌웨어 릴리스노트 |
| 네트워크 카드 | NMC2(AP9630/31/35), **NMC3(AP9640/41/43)**, 내장 NMC(SRT/Ultra), 펌웨어 **v1.x~3.x** 사용자 가이드·CLI 가이드·보안 가이드 | 이벤트 로그 메시지 사전(`Event Log Messages`)이 핵심 |
| MIB | **PowerNet-MIB**(현재 버전 + 장비 펌웨어 시점 버전), RFC 1628 UPS-MIB | trap 번호·OID 정본 → WO-INT-006 `apc-mib.js` 대조(Q-2026-10-26-06 (B) 경로) |
| 배터리 | RBC 번호표·수명·교체 절차, Li-ion XBP 안내, 배터리 온도·충전 관련 KB | |
| 환경 | NetBotz(보유 시), 온습도 센서(AP9335T/TH), 권장 운전 환경 범위 | |
| PDU/기타 | 부록 C·Exhibit 1에 있는 것만 | |
| KB/FAQ | Schneider Electric Knowledge Base(FAQ) 중 위 기종·NMC·배터리·SNMP·trap·시간/NTP·이메일 알림 관련 문서 | 문서 ID(FA######)로 식별 |
| 소프트웨어 | PowerChute Network Shutdown / Business, Data Center Expert(EcoStruxure IT) 중 고객이 쓰는 것만 | |

### 2.2 출처 정책 (법적·운영)
1. **공식 공개 문서만** 자동 수집한다: `se.com`, `apc.com`, `download.schneider-electric.com`, Schneider FAQ(KB). 로그인·구독·파트너 포털 전용 문서는 수집하지 않는다(사람이 받아 `knowledge/vendor/manual/`에 넣고 출처를 적는 것은 허용).
2. 각 문서는 **원본 그대로 보관**(PDF/HTML) + 추출 텍스트 + 메타(문서 ID, 제목, 버전/개정일, URL, 수집일, sha256, 적용 모델/펌웨어). 라이선스는 "내부 운영 참조용"으로 표기하고 **고객 화면에는 요약·인용(짧은 발췌)과 원문 링크**만 노출한다. 원문 PDF 자체를 고객에게 재배포하지 않는다.
3. `robots.txt`·이용약관을 지키고, 요청 간격 ≥ 2초, 동시 1, User-Agent에 RingOn 식별 문자열. 차단되면 중단하고 수동 수집으로 전환.
4. 수집 대상 목록은 코드가 아니라 데이터 — `knowledge/sources/apc_sources.yaml`(허용 도메인·시드 URL·문서 ID 목록). 목록 밖은 수집하지 않는다.
5. 갱신: 주 1회 변경 감지(ETag/sha256), 새 버전은 **새 문서 버전**으로 추가(이전 버전 보존 — 장비 펌웨어가 옛 버전일 수 있다).

### 2.3 처리 파이프라인
```
fetch(허용목록) → store(원본, sha256) → extract(PDF: 레이아웃 보존 텍스트 + 표 + 그림 캡션; HTML: 본문)
→ normalize(모델·펌웨어·문서유형 태그, 섹션 트리) → chunk(섹션 경계 우선, 300~800 토큰, 표는 통째로)
→ embed(벡터) + index(키워드/BM25) → verify(샘플 5% 사람이 확인) → publish(검색 가능)
```
- 섹션별 `anchor`(문서ID#섹션번호/페이지)를 보존해 응답에서 **페이지 단위 인용**이 되게 한다.
- **이벤트 로그 메시지 사전**과 **MIB trap 표**는 비정형 청크가 아니라 **구조화 테이블**(`knowledge/vendor/apc_event_messages.csv`, `apc_powernet_traps.csv`)로도 만든다. 알람 코드(부록 B) ↔ APC 이벤트 메시지 ↔ trap OID의 **3방향 매핑**이 AI 응답의 뼈대다.

---

## 3. K2 — Field Knowledge (현장·커뮤니티 지식)

### 3.1 원칙
- 커뮤니티(Schneider Community, r/sysadmin, Spiceworks, ServeTheHome, 국내 카페 등)는 **원문 전체를 복제하지 않는다.** 사람(또는 LLM 초안 + 사람 승인)이 **런북 형식**으로 정제하고 출처 링크·날짜·신뢰 등급을 단다.
- 신뢰 등급: `A` 제조사 문서 근거 · `B` RingOn 현장에서 재현/확인 · `C` 커뮤니티 복수 보고(미검증) · `D` 단일 보고/추정. AI 응답은 등급을 명시하고, **C/D만 근거일 때는 "검증 필요"로 답한다.**
- RingOn 기술자 경험(PM 보고서 코멘트, 출동 기록)은 `B`로 들어가며 가장 값지다 — PM 보고서 임포트(§4.4)에서 "Active Alarms / Warnings / Notice" 칸을 자동으로 런북 후보로 뽑는다.

### 3.2 런북 형식 (`knowledge/runbooks/*.yaml`, 스키마 `knowledge/schemas/runbook.schema.json`)
```yaml
id: RB-UPS-CLOCK-DRIFT-001
title: UPS/NMC 시계가 수십 분 어긋남 (PM 보고 "TIME NEEDS TO BE CORRECTED")
applies_to: { models: [SRT5KRMXLT, SRYLF20KRMT], nmc: [NMC2, NMC3, embedded], firmware: ">=1.0" }
triggers:                      # 어떤 신호가 이 런북을 깨우나
  alarm_codes: [CLOCK_DRIFT]   # 부록 B
  apc_events: ["System: Date/time changed", "NTP: synchronization failed"]
  pm_findings: ["TIME NEEDS TO BE CORRECTED"]
  telemetry_rules: ["abs(nmc_time - probe_time) > 300s"]
symptoms: [...]
causes:                        # 확률 순
  - { cause: "NTP 서버 미설정 또는 방화벽 123/UDP 차단", likelihood: high, evidence: "..." }
  - { cause: "NMC 재부팅 후 RTC 리셋(배터리 없는 모델)", likelihood: medium }
checks:                        # 읽기 전용 확인
  - { step: "NMC UI → Configuration → General → Date/Time 확인", read_only: true }
actions:                       # 사람이 수행; 각 단계에 영향·권한·롤백
  - { step: "NTP 서버(고객 내부 NTP) 설정, 수동 동기 1회", impact: none, who: "FSE 또는 HAEA NOC", rollback: "이전 값 복원" }
verification: ["5분 후 NMC 시간 ≤ 60초 오차", "events 에 CLOCK_DRIFT clear"]
escalate_if: ["동기 후 24h 내 재발 → NMC 펌웨어 KB 확인·교체 검토"]
sources:
  - { grade: A, ref: "NMC3 User Guide §Date/Time", doc_id: "...", anchor: "p.xx" }
  - { grade: B, ref: "RingOn PM 2026-10-02 HAEA HQ IDF 332/433/537/MDF 2F — 50~55분 지연 4건" }
severity_hint: P4
last_reviewed: 2026-10-26
reviewed_by: PM
```
- 런북은 **알람 코드(부록 B)·APC 이벤트 메시지·PM 소견 문구**로 색인된다. 코드 밖 trap(환경·NetBotz·PDU, Q-05)은 `apc_events`로만 색인되어 "기록만" 상태에서도 지식은 쌓인다.

### 3.3 초기 런북 세트 (이번 시드, HAEA HQ Q3 PM 보고서에서 추출)
| ID | 상황 | 근거 |
|---|---|---|
| RB-UPS-CLOCK-DRIFT-001 | 시계 50~55분 지연 | IDF 332/433/537, MDF 2F 4건 공통 → 사이트 NTP 미설정 의심 |
| RB-UPS-RBC-REPLACE-ALARM-001 | 배터리 94%·자가진단 GOOD인데 "REPLACE ALL RBC" 알람 | IDF 537 |
| RB-ULTRA-XBP-MODULE-COUNT-001 | 20kW Ultra 배터리 모듈 14 등록 기대, 11만 등록 | MDF 1F UPS A |
| RB-NMC-ENV-HISTORY-001 | NMC 로그 환경(온도) 고점 이력, 활성 알람은 없음 | MDF 1F UPS A (PREV HIGH 09/26) |
| RB-UPS-LOAD-LOW-001 | 부하 18~21%(5kVA) / 3kW(20kW) — 저부하 운전 영향·효율·런타임 해석 | 5건 공통 |
| RB-UPS-SELFTEST-SCHEDULE-001 | 자가진단 주기·결과 해석, PM 때 수동 실행 절차 | 5건 |
| RB-UPS-COMM-LOST-001 | UPS_COMM_LOST(30분 규칙) 발생 시 NMC/네트워크/카드 점검 순서 | 부록 B·006 |
| RB-UPS-ON-BATTERY-001 | 온배터리 → 런타임·입력 전원 확인 → 바이패스/정지 판단 기준 | 부록 B |

---

## 4. K3 — Site Book (사이트 기준선)

### 4.1 데이터 모델 (포털 DB, 02 §8 확장)
- `site_book_unit` (device 1:1): **build-up** (model, model_family, serial, serial_yyww, mfg_date, firmware_ups, firmware_nmc, nmc_model, nmc_mac, battery {type: RBC|XBP|LiIon, strings, modules_expected, modules_registered, install_date, replace_due, last_status_pct}, options {ext_bypass_type, ext_battery_packs, rail_kit}), **environment** (room, cabinet/rack, ru_position, room_temp_c_baseline, humidity_baseline, hvac_note, floor_type), **cabling** (input_panel, input_breaker, input_voltage_nominal, input_phase, output_breaker, output_pdu_targets[], bypass_type, bypass_location, nmc_port {switch, port, vlan, ip, gateway}, snmp_version, console_cable), **baseline** (load_pct, load_kw, runtime_min, dc_v, batt_temp_c, input_v, output_v, output_a, efficiency_pct, measured_at, source: pm_report|telemetry_7d_median), `photos[]`(file_id), `notes[]`, `source_refs[]`, `updated_by`, `updated_at`.
- `site_book_history` : 유닛별 **알람·이벤트 히스토리**(events 테이블 참조), **PM 히스토리**(pm_inspection), **변경 이력**(펌웨어·배터리·IP·위치 변경 — `UPS_CONFIG_CHANGED`·inventory diff에서 자동), **조치 이력**(런북 실행 기록, 사람 입력).
- `site_book_site`: 사이트 공통 — 건물·층·실 구조, 전원 계통도(분전반 → UPS → PDU/랙), 네트워크(관리 VLAN, NTP/SMTP/SNMP 매니저 주소는 **ID만**, 값은 비밀 저장소), 공조, 출입/연락 절차(연락처 원문은 암호화 contact 참조), 방화벽 요청서 v3 요약(변경 불가).
- **기준선(baseline)의 뜻**: "정상일 때 이 장비는 이렇다"를 숫자로 둔다. 1차 값은 PM 보고서(2026-10-02)에서, 이후는 **telemetry 7일 중앙값**으로 자동 갱신하되 PM 값은 `source=pm_report`로 보존. AI는 "지금 값 vs 기준선"을 답의 첫 줄에 쓴다.

### 4.2 자동 입력(계약 00, Probe 변경 없음)
| 계약 엔드포인트 | Site Book 반영 |
|---|---|
| `PUT /inventory` | build-up(모델·시리얼·펌웨어·NMC·IP), 변경 diff → history(변경) |
| `POST /telemetry` | baseline 자동 갱신(7일 중앙값), 현재값 |
| `POST /events` | history(알람), 런북 트리거 |
| `POST /files kind=log` (`collect_diag` 결과) | NMC 이벤트 로그·데이터 로그 파싱 → history(장비 자체 로그, Probe 설치 이전 이력 포함) · `config_backup` → build-up 설정 스냅샷(비밀 필드 마스킹) |
| `POST /files kind=pm_report|photo` | §4.4 PM 임포트, 사진 |

### 4.3 수동 입력(현장) — 케이블링·환경
- 포털 큐레이션 화면에서 유닛별 폼 + 사진 첨부. **케이블링은 사진 1장 이상 + 라벨 문자열**(분전반명/차단기 번호/스위치 포트)로 입력한다. 미입력 필드는 `unknown`으로 두고 AI가 "미확인"이라고 말한다(추정 금지).
- 1차 입력 범위: HAEA HQ 6대(MDF 1F A/B, MDF 2F, IDF 332/433/537) — 이번 시드 YAML(`knowledge/sitebook/HAEA/HQ/*.yaml`)을 포털 임포트 형식의 정본으로 삼는다. HMA/KUS는 부록 C에서 build-up만 자동 생성하고 케이블링·환경은 다음 PM 때 채운다.

### 4.4 PM 보고서 임포트 (02 §6 PM 디지털화와 연결)
- 입력: RingOn PM 보고서(DOCX/PDF). 파서는 보고서 템플릿의 표(시스템 정보·배터리·점검 10항목·전기 측정·활성 알람/경고/노트)를 필드로 뽑고, 원문은 `files`로 보관.
- 출력: `pm_inspection` 행 + Site Book build-up/baseline 갱신 + **"Active Alarms / Warnings / Notice" 문구를 런북 후보로 큐에 올림**(PM 승인 후 K2 편입).
- 부록 C 시드 CSV(48행)와 **충돌 시 CSV가 정본**(v1.3 보정본), 차이는 리뷰 큐로.

---

## 5. 검색·근거 조립 (Retrieval)

1. **질문 이해**: 테넌트/사이트/유닛 식별(이름·시리얼·IP·위치 문자열 정규화 — v1.4 §라벨 유일성 규칙 재사용), 의도 분류(상태 질문 / 원인 분석 / 조치 절차 / 문서 조회 / 리포트).
2. **K3 우선**: 식별된 유닛의 build-up·baseline·현재 telemetry·열린 알람·최근 30일 이벤트·마지막 PM·변경 이력을 **구조화 컨텍스트**로 먼저 넣는다(벡터 검색 아님, DB 조회).
3. **런북 매칭**: 열린 알람 코드·최근 APC 이벤트·질문 키워드로 K2 런북 상위 3개.
4. **K1 검색**: 모델·펌웨어 태그로 필터한 뒤 하이브리드(BM25 + 벡터) 상위 8청크, 같은 문서 인접 청크 병합. 이벤트 메시지·trap 표는 정확 일치 우선.
5. **컨텍스트 예산**: K3 구조화 ≤ 2k 토큰, 런북 ≤ 3k, K1 ≤ 6k. 넘치면 신뢰 등급·최신 버전·모델 일치 순으로 자른다.

---

## 6. 데이터 모델 요약 (신규 테이블)
`knowledge_doc`(id, kind, vendor, model_tags[], fw_range, title, version, url, doc_id, sha256, license, fetched_at, status) · `knowledge_chunk`(doc_id, anchor, section_path, text, embedding, tokens) · `apc_event_message`(code, text_pattern, severity_vendor, meaning, maps_to_alarm_code?, trap_oid?) · `apc_trap`(oid, specific, name, maps_to_alarm_code?, action) · `runbook`(§3.2 YAML 그대로 jsonb + 색인 컬럼) · `site_book_unit`/`site_book_site`/`site_book_history`(§4.1) · `kb_question_log`(질문, 식별 유닛, 사용 근거 id[], 답, 피드백, 모델, 지연) · `eval_case`(§8).

---

## 7. AI 응답 서비스

### 7.1 API (포털 내부, 02 §4 콘솔·고객 포털에서 호출)
`POST /ai/v1/ask` `{ tenant_id, site_id?, device_id?, question, mode: "noc|customer", lang: "ko|en" }`
→ `{ answer_md, summary_one_line, grounding: { unit_state: {...}, runbooks: [...], citations: [{doc_id, anchor, quote, grade}] }, confidence: "high|medium|low", requires_human_action: true|false, suggested_runbook_id?, unknowns: [...] }`

### 7.2 응답 규칙
1. **첫 줄은 항상 현재 상태 vs 기준선**(식별된 유닛이 있을 때): "HAEA HQ IDF 537(SRT5KRMXLT, AS2528280276): 부하 19%(기준 19%), 런타임 39m(기준 33m), 열린 알람 0, 마지막 PM 2026-10-02 PASS."
2. **조치는 런북 단계로**, 각 단계에 영향·권한·롤백. 장비 설정 변경은 "사람이 NMC에서" — AI가 명령을 발행하지 않는다. 계약 00 §3.6의 6개 명령(`poll_now`, `collect_diag` 등 읽기성) 제안은 가능하되 발행은 NOC 사용자가 버튼으로.
3. **인용 필수**: 근거 없는 문장은 쓰지 않는다. 근거가 C/D 등급뿐이면 "검증 필요"를 명시. 모르면 "미확인" + 무엇을 확인하면 되는지.
4. **고객 모드(customer)**: 내부 비밀(IP 전체·community·연락처·타 테넌트) 노출 금지, 원문 PDF 링크 대신 문서명·섹션 표기.
5. **언어**: 질문 언어로. 기술 용어는 영문 병기.
6. **로그**: 모든 질문·근거·답을 `kb_question_log`에 보관(테넌트 격리), 피드백(👍/👎·정정)을 받아 런북 개선 큐로.

### 7.3 모델·호스팅
- LLM은 **포털 측 외부 API 호출**(Anthropic Claude 권장; 키는 포털 비밀 저장소). 고객 데이터 최소화: 질문에 필요한 유닛 컨텍스트만 전송, 연락처·community 등 비밀은 절대 전송하지 않음. 모델명·버전은 `kb_question_log`에 기록.
- 임베딩: 다국어 모델(한/영 혼용 질문) 1종 고정, 교체 시 전체 재색인.
- 온프레미스(Probe/Local Console)에는 **AI 기능을 두지 않는다**(D-12a, 외부 호출 0). 단, 포털이 만든 **정적 런북 PDF/HTML 묶음**을 Local Console 설정 화면 "참고 문서"에 넣는 것은 설정 자료 배포(`config_update`)로 허용 — 코드 변경 없음.

---

## 8. 평가셋·품질 게이트
- `knowledge/eval/haea_hq_q3_2026.yaml`: 이번 PM 보고서 5건에서 뽑은 **골든 Q&A 20문항 이상**(상태 질문·원인·조치·문서 조회). 예: "IDF 537 배터리 94%인데 REPLACE ALL RBC 알람이 뜬 이유와 조치는?", "MDF 1F UPS A 배터리 모듈이 14개인데 11개만 등록된 상태에서 런타임 2시간이 맞나?", "HQ 4대의 시계가 55분 늦다. 공통 원인은?"
- 게이트: 정답 근거 포함률 ≥ 90%, 환각(근거 없는 단정) 0건, 비밀 노출 0건, 응답 ≤ 15초(p95). 매 릴리스 CI에서 실행.
- 사람 검수: PM이 주 1회 `kb_question_log` 👎 샘플 검토 → 런북 수정.

---

## 9. 작업 분할

| WO | 담당 | 내용 | 완료 기준 |
|---|---|---|---|
| **WO-PTL-008** | Codex | K1 수집 파이프라인 + 저장·추출·청크·색인 + `apc_sources.yaml` 허용목록 + 이벤트 메시지/trap 구조화 표 | 허용목록 문서 수집 E2E(원본·sha256·메타), 검색 API, 표 2종 ≥ 200행, 수집 로그에 차단/오류 0 |
| **WO-PTL-009** | Codex | K3 Site Book 모델·자동 입력(계약 00 매핑)·PM 보고서 파서·큐레이션 화면·시드 YAML 임포트 | HAEA HQ 6대 Site Book 화면, 5건 PM 보고서 파싱 정확도 ≥ 95%(시드 YAML 대조), inventory/telemetry/events 연동 테스트, 부록 C 48행 build-up 자동 생성 |
| **WO-PTL-010** | Codex | K2 런북 저장·색인 + AI 응답 API/화면 + 평가셋 CI + 질문 로그/피드백 | 골든 20문항 게이트 통과, 비밀 노출 테스트 0, 고객/NOC 모드 권한 테스트 |
| **WO-INT-013** | Claude Code | `docs/knowledge/PROBE_DATA_DICTIONARY.md` — 폴링 OID·파생 메트릭·알람 엔진 규칙(임계·히스테리시스·30분 규칙)·trap 매핑표·`collect_diag` 번들 구성. **코드 변경 없음.** | 문서 1건, 포털이 그대로 K1에 적재 가능한 표 형식 |
| PM | 관리자 | 초기 런북 8건·시드 YAML·골든 Q&A 승인, 출처 정책 법무 확인(공식 문서 내부 참조·커뮤니티 요약만) | 이 명세 v1.0 배포 |

순서: WO-PTL-001/002(/api/v1·mTLS)가 끝나야 K3 자동 입력이 산다. 그 전에도 **008(수집)과 009의 PM 파서·시드 임포트는 독립**이라 바로 시작 가능. 010은 008·009 뒤.

---

## 10. SAT(수락) — 지식·AI 범위
1. HAEA HQ 유닛 6대 각각에 대해 "지금 상태 vs 기준선" 질문 → 첫 줄 규칙·숫자 정확(포털 DB와 일치).
2. PM 소견 4종(시계 지연·RBC 알람·모듈 수·환경 이력) 질문 → 해당 런북 제시 + A/B 등급 근거 인용.
3. 부록 B 알람 코드 전부에 대해 최소 1개 런북이 연결되어 있음.
4. 커뮤니티 근거만 있는 질문 → "검증 필요" 표기.
5. 고객 모드에서 비밀·타 테넌트 데이터 0건(자동 테스트).
6. 수집 허용목록 밖 도메인 접근 0건(수집 로그 감사).

---

## 11. 미확정 (DECISIONS Q로 관리)
1. 커뮤니티 출처 범위(국내 카페 포함 여부)와 공식 문서 내부 보관의 법무 확인 — 권고: 공식 공개 문서 내부 참조 + 커뮤니티는 요약·링크만(이 명세 §2.2·§3.1대로 진행).
2. LLM 공급자·데이터 처리 계약(고객 데이터 외부 전송 범위) — 권고: Anthropic API, 유닛 컨텍스트 최소 전송, 비밀 0.
3. Q-2026-10-26-05(환경·NetBotz·PDU 코드 v1.2) — 런북은 코드와 무관하게 먼저 쌓는다.
4. Local Console "참고 문서" 배포 여부 — 기본 보류(D-12a).
