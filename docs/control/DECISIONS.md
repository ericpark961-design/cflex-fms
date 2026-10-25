# 결정·질문 (DECISIONS) — 에이전트는 추측 대신 여기에 `Q-YYYY-MM-DD-NN`으로 질문을 남긴다. 관리자(또는 Eric)가 `A:`로 답한다.

## 확정된 결정 (요약)
- D-01 내부 = Probe + Local Console(알람 받기·보여주기·ACK, 기존 UI) + 로컬 알림(SMTP/ServiceNow). 포털 = 라우팅·NOC·리포트·PM·3D.
- D-02 Probe↔포털 계약은 docs/spec/00 단일. mTLS, `/api/v1`, 목적지 cflex.fms.support(40.114.79.164, static).
- D-03 배포: Podman/Quadlet, UBI8 nodejs-20 기본; 베어 설치 폴백. Docker 금지.
- D-04 업그레이드: 아웃바운드 풀(cflex.fms.support:443 레지스트리) + **승인된 유지보수 창에 적용**(무인 자동 적용 아님). WireGuard 보류.
- D-05 AI·자동화의 장비 쓰기 금지(88870a7 유지). Probe는 SNMP 읽기 전용.
- D-06 수량 기준: 44(SOW) / 41(NMC IP, 방화벽) / 48(Q3 실사) 혼용 금지.
- D-07 heartbeat 60s, 폴링 60s(최소 10s), 버퍼 7일.

## 열린 질문
(없음)
