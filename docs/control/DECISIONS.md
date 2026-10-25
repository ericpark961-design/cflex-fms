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

### Q-2026-10-25-01 — WO 브랜치의 base를 어디로 할지 (Claude Code)
CLAUDE.md는 `wo/INT-xxx`의 base를 `main`으로 지정했으나, 현재 `main` = `origin/main` =
`a0db8e4`이고 **다음이 전부 main에 없다**:

- control plane 자체 — `CLAUDE.md`, `docs/control/*`, `docs/spec/00·01·02`
  (`664e835`, `2bfe9a3` 두 `[CTRL]` 커밋)
- **D-05·STATUS가 기준으로 지정한 `88870a7`** (장비 쓰기 금지 코드화)
- 그 외 15개 (notify 패키지 분리, PDF 폰트, S1 provenance 등)

합계 **18 커밋**이 `feat/twin-rack-elevation`에만 있고 origin에 푸시되지 않았다.
`main`에서 브랜치를 따면 작업지시서도 명세서도 없는 트리가 된다.

WO-INT-001은 `2bfe9a3`(= 현 HEAD)을 base로 진행했다. 다음 중 택일 요청:

- **(A)** `feat/twin-rack-elevation`을 `main`으로 머지(또는 PR)해서 base를 정상화한다 — 권고.
  이후 WO 브랜치는 규칙대로 `main` base.
- **(B)** WO 브랜치 base를 `feat/twin-rack-elevation`으로 공식 변경하고 CLAUDE.md를 수정한다.
- **(C)** 다른 지시.

A:

### Q-2026-10-25-02 — 운영 DB의 시뮬레이터 장비 4대 (Claude Code)
운영 DB에 시뮬레이터 장비 4대(`probe-agent/sim/`로 만든 PDU·NetBotz·CRAC·스위치)가 남아 있다.
S1 "샘플·시뮬레이션 데이터 제거" 항목이 이것 때문에 닫히지 않는다. 데모 시연용으로 유지인지,
삭제인지 지시 필요. (운영 DB 변경이므로 지시 없이는 건드리지 않는다.)

A:
