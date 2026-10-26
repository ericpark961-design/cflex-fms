# knowledge/ — C-Flex FMS 지식베이스 정본 (명세 docs/spec/03)
| 디렉터리 | 층 | 내용 | 담당 |
|---|---|---|---|
| `sitebook/<tenant>/<site>/<unit>.yaml` | K3 | 유닛별 빌드업·환경·케이블링·기준선·PM/알람 히스토리 (`schemas/sitebook_unit.schema.json`) | PM 시드 → 포털(Codex WO-PTL-009) 임포트·자동 갱신 |
| `runbooks/RB-*.yaml` | K2 | 상황 → 원인 → 확인(읽기) → 조치(사람) → 검증 → 에스컬레이션, 출처 등급 A~D (`schemas/runbook.schema.json`) | PM/FSE 승인 |
| `sources/apc_sources.yaml` | K1 | 수집 허용목록·시드·정책 | PM, Codex WO-PTL-008 |
| `vendor/` | K1 | 이벤트 메시지·trap 구조화 표, 수동 투입 문서 | Codex |
| `community/` | K2 | 정제 전 메모(근거로 사용 금지) | PM/FSE |
| `eval/` | 품질 | 골든 Q&A·게이트 | PM, Codex WO-PTL-010 CI |
규칙: 비밀값 금지 · `unknown`은 추정하지 않음 · 수량 44/41/48 혼용 금지 · 장비 쓰기 조치는 항상 "사람이 NMC에서" · 검증: `python3 tools/knowledge-validate.py`(Codex가 WO-PTL-008에서 추가; 그 전엔 jsonschema로 수동).
