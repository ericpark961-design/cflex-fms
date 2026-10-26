# knowledge/vendor — K1 구조화 산출물 (WO-PTL-008)
- `apc_event_messages.csv` — NMC 이벤트 로그 메시지 사전: `code,text_pattern,severity_vendor,meaning,maps_to_alarm_code,trap_oid,source_doc_id,anchor`
- `apc_powernet_traps.csv` — PowerNet-MIB trap 표: `specific,oid,name,description,maps_to_alarm_code,action(raise|clear|info),source_mib_version`. 정본은 MIB 파일. `probe-agent/src/trap/apc-mib.js`(WO-INT-006)와 자동 대조 테스트(Q-2026-10-26-06).
- `manual/` — 사람이 받아 넣은 공식 문서(공개 다운로드 불가 시). 파일명 `<doc_id>_<title>_<version>.pdf`, 옆에 `<doc_id>.meta.yaml`(url, fetched_at, sha256, license_tag).
- 원문은 내부 운영 참조용. 고객 화면에는 요약·인용·링크만 (명세 03 §2.2).
