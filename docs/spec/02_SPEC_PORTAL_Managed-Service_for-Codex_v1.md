# C-Flex FMS 2.x — 매니지드 서비스 포털(외부) 명세서
### 담당: Codex · 문서번호 SPEC-CFLEX-PORTAL-2026-1023 v1.0
### 계약서: `00_INTERFACE_CONTRACT_Probe-Portal_v1.md` (반드시 준수)

---

## 0. 역할 경계

**만든다 (외부, RingOn 운영, cflex.fms.support / Azure 40.114.79.164 static)**
1. **Ingest** — 계약서 §3의 모든 엔드포인트(heartbeat, inventory, telemetry, events, files, commands, config) + mTLS 장치 인증 + 테넌트 격리 + 멱등 처리 + 목 서버(`/_mock`, 테넌트 TEST).
2. **알람 라우팅·에스컬레이션 엔진** — 테넌트/사이트/심각도별 정책 → **사이트별 지정 담당자 + RingOn 당직**에게 e-mail / SMS / Teams, ACK 추적, 미ACK 시 단계 에스컬레이션, 근무시간표(on-call), Probe의 `local_notified`로 중복 발송 억제.
3. **RingOn NOC 콘솔** — 전 고객 통합 화면(테넌트·사이트·장비 상태, 알람 큐, Probe 헬스, 포털 링크 상태), 운영자 액션(ACK, 노트, 에스컬레이션, 명령 발행: config_update/cert_renew/poll_now/set_maintenance/collect_diag).
4. **고객 포털(테넌트 뷰)** — 고객 사용자(예: HAEA Kay/Patrick)가 자기 테넌트만 보는 대시보드·알람·리포트·3D 뷰. 로컬 콘솔보다 풍부한 분석은 여기서.
5. **리포트** — 월간 Executive Report(PDF, 자동 생성·메일 발송·포털 보관), 연간 **라이프사이클/예산 예측표**(Region/Office/City/Item/Age/Cost, 매년 9월 차년도), SLA 준수 리포트.
6. **PM(예방점검) 디지털화** — 체크리스트 템플릿·모바일 입력·유닛 PDF/사이트 합본/분기 Status Report 자동 생성·이력 비교. 현장 데이터는 Probe가 `files`/`telemetry`로 올리거나 엔지니어가 포털 모바일 UI로 입력.
7. **3D 평면도(Digital Twin) 뷰** — 기존 구현을 포털 기능으로(모델 업로드·배치 편집기·실시간 마커·2D 폴백).
8. **자산·라이프사이클** — 제조일(시리얼 YYWW 디코드), 배터리 설치/교체 예정, 보증 상태, 교체 권고.
9. **테넌트/장치 관리** — 테넌트 생성, 노드 등록, CSR 서명·인증서 수명주기(폐기·갱신 명령), 설정 배포(config_version).

**만들지 않는다 (내부 Probe = Claude Code 담당)**
- SNMP 폴링/trap, HAEA 내부 SMTP/Teams/ServiceNow 발송, 로컬 콘솔, 온프레미스 설치기. 포털은 **Probe로 인바운드 연결을 열지 않는다**(명령은 큐로만, 허용 6종 고정).

---

## 1. 호스팅·보안
- Azure(미국), 공인 엔드포인트 `cflex.fms.support` **고정 IP 40.114.79.164**(고객 방화벽 allow-list 대상이므로 변경 금지; 변경 시 90일 전 고지 절차). TLS 1.2+/1.3, HSTS, 인바운드는 443만.
- mTLS: RingOn 사설 CA(오프라인 루트 + 온라인 발급 중간 CA), 노드 인증서 CN=`<tenant>.<node-id>`, CRL/OCSP, 폐기 즉시 401.
- 테넌트 격리: 모든 테이블 `tenant_id`, 행 수준 보안(RLS), 사용자-테넌트 매핑, 고객 사용자는 자기 테넌트 외 데이터 접근 불가(테스트 필수).
- 데이터: 계약서 §5 허용 필드만 저장. 고객 담당자 연락처(알림 수신자)는 포털 전용 데이터(Probe와 공유하지 않음), 암호화 저장. 보존: raw 3년/집계 10년/이벤트 10년(테넌트별 설정), 테넌트 해지 시 삭제 절차.
- 감사로그(운영자 액션·명령 발행·정책 변경), SSO(RingOn 내부: Entra ID; 고객: SAML/OIDC 선택), MFA 필수(운영자).
- 가용성: 다중 AZ, DB 복제, Probe 큐 7일을 감안한 RPO ≤ 5분/RTO ≤ 1시간, 상태 페이지.

## 2. Ingest 서비스
- 계약서 §1 전송 규칙 그대로: gzip 수용, Idempotency-Key 24h 캐시, 429/Retry-After, 노드당 60 req/min, `X-CFlex-API-Version`.
- 텔레메트리: 배치 수신 → 시계열 저장(월 파티션 또는 TSDB) → 1분 raw, 5분/1시간/1일 집계 롤업. 미등록 메트릭 키 → `m_ext` 보관 + 경고.
- 이벤트: alarm_id 생애 관리(raise/update/clear), 코드 사전(계약서 부록 B) 기반 기본 심각도 + 테넌트/사이트 오버라이드.
- 헬스: heartbeat 5분 미수신 → `PROBE_OFFLINE`(P2) 자체 알람 → RingOn 당직. `clock` drift·queue_depth 추이 저장.
- 인벤토리: full/delta 병합, `duplicate_serial` 등 거절 사유 반환, `serial_alt`(모듈형 장비 복수 시리얼) 지원, Exhibit 1 임포트(XLSX)와 대조 리포트.
- files: PM 리포트 PDF·사진·진단 번들 저장(오브젝트 스토리지), SHA-256 검증, 바이러스 스캔.
- commands/config: 명령 큐(만료·결과 수집), 설정 버전 관리·배포, 노드별 `config_version` 추적.
- **목 서버** `/api/v1/_mock`(테넌트 TEST): Probe 팀 개발·HAEA SAT용. 계약 JSON Schema로 요청 검증, 샘플 명령 발행.

## 3. 알람 라우팅·에스컬레이션
- 정책 모델: 테넌트 → 사이트 → 심각도별 **라우팅 규칙**(수신 그룹, 채널, 지연, 반복, 에스컬레이션 단계, 근무시간/휴일, 유지보수 창). 수신자 = "지정 담당자"(고객 측, 역할 기반) + RingOn 당직(on-call 스케줄).
- 채널: e-mail(RingOn 발신 도메인, SPF/DKIM/DMARC), SMS(Twilio 등 — 교체 가능한 어댑터), Teams(고객 또는 RingOn 채널 웹훅/그래프), 음성 호출(P1 옵션).
- 중복 억제: Probe `local_notified`가 true인 채널은 포털에서 재발송하지 않음(정책으로 "양쪽 모두" 선택 가능). 알람 폭주 시 사이트 단위 묶음 통보.
- ACK: 링크/회신/콘솔로 ACK, 미ACK 시 N분 후 다음 단계. SLA 타이머(P1 현장 4시간, NBD) 추적·리포트.
- ServiceNow 등 고객 ITSM은 **내부 Probe가 수행**(HAEA 내부망). 포털은 티켓 번호를 받아 표시만. RingOn 자체 ITSM(선택)은 포털에서.

## 4. 콘솔·고객 포털
- NOC 콘솔: 테넌트 전체 보드, 알람 큐(심각도·경과·ACK 상태), 장비 상세(실시간·트렌드·이력·PM·배터리), Probe 헬스, 명령 발행 UI(6종), 정책 편집기, on-call 스케줄, 감사로그.
- 고객 포털: 자기 테넌트 대시보드, 알람·이력, 리포트 다운로드, 3D/2D 뷰, 자산 목록·라이프사이클, PM 리포트 열람, 담당자(자기 사이트 수신자) 관리(권한 시). HAEA는 로컬 콘솔(내부)과 포털 둘 다 사용 가능.
- 다국어 EN/KR(+ES), 타임존·단위 테넌트별.

## 5. 리포트
- **월간 Executive Report**(SOW D6): 가용성, 알람 통계(P1–P4), 배터리 상태·EOL 90일, 교체 권고, SLA 준수, Probe 가동률 → PDF 자동 생성, 테넌트 수신자 메일 발송, 포털 보관, 내부 Probe에도 사본 전달(선택, 명령 큐 사용 안 함 — 고객이 포털에서 받음).
- **라이프사이클/예산 예측표**: 유닛별 제조년월(시리얼 YYWW), 설치일, 배터리 설치/예정, 모델별 수명 규칙(SRT 배터리 4.5~5년, Modular Ultra 10년, 본체 refresh 7~8년/trade-up 10년), 단가표 → 차년도·2년 후 교체 목록과 비용(Region/Office/City/Item/Age/Cost). 매년 9월 자동 생성, CSV/XLSX/PDF.
- SLA 리포트, PM 분기 Status Report(§6과 연동).

## 6. PM(예방점검) 디지털화
- 템플릿 = 현행 "UPS Preventative Maintenance Service Report"(헤더·System Info·Battery Info·점검 10~12항목 PASS/FAIL/N/A·전기 측정값·환경·비고·서명).
- 모바일 입력: 유닛 QR/시리얼 스캔 → 체크리스트, **SNMP 값 자동 채움**(Probe 최신 텔레메트리에서), 사진 첨부, 오프라인 입력 후 동기화.
- 출력: 유닛 PDF, 사이트 합본(표지·인덱스), 분기 Status Report. 이력·직전 PM 대비 변화 하이라이트.
- 검증 규칙: 시리얼 중복(KUS IDF1/IDF2 사례), 제조일 vs 시리얼 YYWW 불일치(1/1/YYYY 기본값 의심), 라벨 중복(HMA 2E-A ×3), 날짜 포맷 정규화(`AUG 2025`, `10/13/2025`, `JUL-2025`, `12/11/2025 OR NEWER`, precision 보존), 필수값 누락, `in_sow` 구분, 배터리 교체일 자동 계산 vs 입력값 차이 표시.
- 시드: `Appendix_C_Q3-2026_PM_Inventory_Seed.csv`(48행)로 HAEA 테넌트 첫 PM 이력 임포트 + 원본 PDF 48건 files로 보관.

## 7. 3D 평면도(Digital Twin)
- 기존 구현 이식(스택·모델 포맷은 개발팀 확인 — 미확정 §10-1). glTF/GLB(Draco), 모델 업로드·버전 관리(테넌트/사이트/층), **배치 편집기**(드래그, 좌표 저장), Exhibit 1 Location 문자열로 초기 층/구역 매핑, 미배치 목록.
- 실시간 마커(심각도 색, 통신 단절 점멸), 클릭 상세, P1 시 층 포커스, 2D 폴백, 모바일 터치.
- 평면도 원본(DWG/PDF)은 고객 수령 전까지 블록아웃 모델. HAEA Phase 1 사이트 구성: HMA FV(1W~6W/E, 1E MPOE, 6F Boardroom, TC, PG), KUS(IDF1~7, 1·2층), HAEA HQ(1F MDF 캐비닛 2·3, 2F MDF, IDF 332/433/537).

## 8. 데이터 모델(요지)
tenant · site · device(serial, serial_alt[], in_sow, mfg_date+source, location) · node(cert, version, config_version) · telemetry(파티션) · rollup · alarm(alarm_id 생애) · event · notification(채널·수신자·결과·ACK) · routing_policy · oncall_schedule · contact(암호화) · command · config_version · file · pm_inspection · pm_item · report · floorplan_model · device_placement · user · role · audit.

## 9. 수락 시험(SAT) — 포털 범위
1. 계약 테스트: 모든 엔드포인트가 JSON Schema 검증 통과, 멱등·429·버전 헤더 동작, 목 서버 제공.
2. mTLS: 유효 인증서만 수락, 폐기 시 401, `cert_renew` 명령 흐름.
3. 테넌트 격리 테스트(교차 접근 0건).
4. P1 이벤트 수신 → 정책대로 지정 담당자+당직 통보(e-mail/SMS/Teams), `local_notified` 중복 억제, 미ACK 에스컬레이션, ACK 반영.
5. heartbeat 중단 5분 → PROBE_OFFLINE 당직 통보.
6. 월간 Executive Report·라이프사이클 예산표 생성(HAEA 시드 데이터로), PM 리포트 패키지 생성(48건 → 사이트 합본+Status Report).
7. 3D 뷰: 3사이트 배치, P1 포커스, 2D 폴백.
8. 48시간 부하: 500 UPS × 10초 폴링 상당 수신에서 지연·손실 0.

## 10. 미확정
1. 3D 뷰 기존 구현의 스택·모델 포맷·라이브러리 라이선스
2. SMS 공급자, RingOn 발신 도메인/DKIM, 음성 호출 여부
3. 고객 SSO 방식(HAEA Entra ID SAML) 및 고객 포털 사용자 범위
4. 평면도 원본 수령(HAEA/HMA/KUS)
5. 보존기간·백업 정책 최종(기본 3년/10년)
6. 고객 방화벽에서 프록시 경유 시 HTTP/1.1 Keep-Alive 제약 → 로드밸런서 설정

## 부록. 참조 데이터
- 계약서 부록 A(메트릭)·B(알람 코드)·C(스키마 파일) — 포털은 **수신 측 검증 기준**으로 사용.
- `Appendix_C_Q3-2026_PM_Inventory_Seed.csv`, Exhibit 1 NMC IP 목록(내부 명세 부록 B와 동일).
