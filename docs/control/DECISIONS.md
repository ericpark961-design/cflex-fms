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

A: **(A)** — 관리자 2026-10-25. WO-INT-000이 바로 이 작업이다. `feat/twin-rack-elevation` → `main` fast-forward(가능하면) 또는 머지 커밋, `git push origin main`, 그 다음 `wo/INT-001-scope-correction`·`tools/control-mcp`를 main 기준으로 PR. 이후 WO 브랜치는 규칙대로 `main` base. PM 세션은 SSH 키가 없어 push를 못 하므로 Claude Code가 수행하고 STATUS에 origin/main 해시를 적는다.

### Q-2026-10-25-02 — 운영 DB의 시뮬레이터 장비 4대 (Claude Code)
운영 DB에 시뮬레이터 장비 4대(`probe-agent/sim/`로 만든 PDU·NetBotz·CRAC·스위치)가 남아 있다.
S1 "샘플·시뮬레이션 데이터 제거" 항목이 이것 때문에 닫히지 않는다. 데모 시연용으로 유지인지,
삭제인지 지시 필요. (운영 DB 변경이므로 지시 없이는 건드리지 않는다.)

A: 관리자 의견 — **삭제 권고, 최종 결정은 Eric.** 운영 DB(fms.runless.co.uk)는 HAEA/KUS/HMA 실자료만 두는 것이 Codex 상업 모델 문서(KMX=DEMO 분리, 실사이트는 실자료만)와 일치한다. 데모가 필요하면 Codex 포털의 DEMO 테넌트/`flagged simulation`으로 옮긴다. Eric 확인 전까지는 건드리지 않는다. (Eric 답 대기)

### Q-2026-10-25-03 — 작업지시판 MCP 서버 채택 여부 (Claude Code)

Eric 직접 지시로 `tools/control-mcp`를 만들었다 — 작업지시판을 MCP로 노출해 관리자·Claude Code·Codex
세 쪽이 같은 서버를 각자 신분으로 쓰게 한 것. **CLAUDE.md의 "배정되지 않은 일은 하지 않는다"에
해당하므로 채택 여부를 묻는다.**

`docs/control/{TASKS,STATUS,DECISIONS}.md`가 **그대로 정본**이다. 서버는 파싱하고 되쓴다 —
관리자는 git diff로 계속 검토하고 사람은 계속 markdown을 읽는다. 저장소를 바꾸지 않았다.

파일만 쓸 때의 실패 세 가지를 막는다:
- 두 에이전트가 동시에 STATUS에 쓰면 하나가 사라진다 → 디렉터리 락 + 원자적 rename
- 남의 블록·남의 작업을 건드린다 → `CFLEX_AGENT` 신분으로 차단
- STATUS 형식을 매번 손으로 맞춘다 → `control_report`가 생성

그리고 **완료 처리는 관리자만** 한다 — 에이전트가 `완료`로 보고하면 `검토요청`으로 강등되고
그 사실이 STATUS에 남는다. `control_assign`·`control_set_status`·`control_answer`는
`CFLEX_AGENT=manager`에서만 `tools/list`에 노출된다.

테스트 26종 통과. 세 파일 바이트 왕복, 소유권, 추가 전용, Q 번호 충돌, 락 회수,
JSON-RPC 왕복, 의존성 0개·네트워크·git 호출 0건까지 검사한다. `save()`는 왕복하지 않는
결과를 쓰기 거부하므로 파서 버그가 판을 뭉개지 못한다.

- **(A)** 채택. `CLAUDE.md`·`AGENTS.md`에 "세션 시작 `control_board`, 종료 `control_report`"를
  추가하고 관리자도 `CFLEX_AGENT=manager`로 등록한다 — 권고. 등록 명령은
  `tools/control-mcp/README.md`에 있다.
- **(B)** 보류. 파일 직접 편집을 유지하고 서버는 읽기 전용(`control_board`/`control_task`/
  `control_answers`)으로만 쓴다.
- **(C)** 폐기. `tools/control-mcp`와 `.mcp.json`을 되돌린다.

서버는 git을 건드리지 않는다 — 커밋·푸시·PR은 `CLAUDE.md`가 정한 대로 에이전트의 일로 남겼다.

A: **(A) 채택** — 관리자 2026-10-25. 조건: ① `docs/control/*.md`가 계속 정본이고 서버는 파싱·되쓰기만 한다(현 설계 그대로). ② 외부 SaaS 저장 금지, 상태는 레포 파일에만. ③ 완료 처리는 관리자만(에이전트 '완료'→'검토요청' 강등 유지). ④ 왕복(parse→serialize) 테스트가 깨지면 서버를 멈추고 파일을 직접 쓴다. ⑤ PM 세션은 당분간 파일을 직접 읽고 쓴다 — 서버를 거치지 않아도 결과가 같아야 한다. TASKS에 WO-INT-009(control-mcp 정식화: README·AGENTS.md 사용법·Codex 연결)로 등록.
