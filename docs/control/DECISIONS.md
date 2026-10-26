# 결정·질문 (DECISIONS) — 에이전트는 추측 대신 여기에 `Q-YYYY-MM-DD-NN`으로 질문을 남긴다. 관리자(또는 Eric)가 `A:`로 답한다.

## 확정된 결정 (요약)
- D-01 내부 = Probe + Local Console(알람 받기·보여주기·ACK, 기존 UI) + 로컬 알림(SMTP/ServiceNow). 포털 = 라우팅·NOC·리포트·PM·3D.
- D-02 Probe↔포털 계약은 docs/spec/00 단일. mTLS, `/api/v1`, 목적지 cflex.fms.support(40.114.79.164, static).
- D-03 배포: Podman/Quadlet, UBI8 nodejs-20 기본; 베어 설치 폴백. Docker 금지.
- D-04 업그레이드: 아웃바운드 풀(cflex.fms.support:443 레지스트리) + **승인된 유지보수 창에 적용**(무인 자동 적용 아님). WireGuard 보류.
- D-05 AI·자동화의 장비 쓰기 금지(88870a7 유지). Probe는 SNMP 읽기 전용.
- D-06 수량 기준: 44(SOW) / 41(NMC IP, 방화벽) / 48(Q3 실사) 혼용 금지.
- D-07 heartbeat 60s, 폴링 60s(최소 10s), 버퍼 7일.
- D-08 계약 스키마 정본 = cflex-fms `docs/spec/schemas/*.json` (양 팀 공통). 분리는 추후.
- D-09 프록시 인증은 Basic/무인증까지. NTLM은 HAEA 회신 후 별도 WO.
- D-10 계약 v1.1 (2026-10-25): provisional/id_basis, UPS_BATTERY_CAPACITY_LOW(P3). 버전 헤더 1.1, 1.0 수락.

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

A: 관리자 의견 — **삭제 권고, 최종 결정은 Eric.** 운영 DB(fms.runless.co.uk)는 HAEA/KUS/HMA 실자료만 두는 것이 Codex 상업 모델 문서(KMX=DEMO 분리, 실사이트는 실자료만)와 일치한다. 데모가 필요하면 Codex 포털의 DEMO 테넌트/`flagged simulation`으로 옮긴다. Eric 2026-10-25: **삭제 승인**(관리자 제안대로). 실행 조건: 삭제 전 해당 4대의 장비 행·메트릭 행 수를 STATUS에 기록하고 DB 백업(또는 export) 1회 후 삭제, 삭제 SQL/스크립트를 커밋에 남김. 시뮬레이터 코드(probe-agent/sim/)는 유지.

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

### Q-2026-10-25-04 — HAEA 프록시 인증 방식: NTLM 지원 필요 여부 (Claude Code)

계약 §1은 `HTTPS_PROXY`(basic/NTLM 인증 포함)를 요구한다. WO-INT-002는 **Basic만** 구현했다(node 내장
https/tls, 의존성 0, 테스트 통과). NTLM은 같은 CONNECT 소켓에서 3단계 challenge/response를 해야 하고,
직접 구현하거나 패키지를 반입해야 한다(오프라인 번들에 추가).

- **(A)** HAEA 프록시가 실제로 무엇을 요구하는지 방화벽 양식 회신에서 먼저 확인한다. Basic이거나
  Collector IP 화이트리스트(무인증)이면 지금 상태로 끝 — 권고.
- **(B)** NTLM을 지금 구현한다(자체 구현, 테스트용 NTLM 더미 프록시 포함). 1~2 세션.
- **(C)** 프록시 대신 Collector에서 40.114.79.164:443 직통 허용을 요청한다(방화벽 요청서 v3에 이미 있음).

A: **(A)** — 관리자 2026-10-25. Basic + 무인증만 유지. HAEA 프록시 방식은 방화벽 양식 회신(docs/spec/01 §6-3)으로 확인한 뒤 NTLM/Kerberos가 필요하면 별도 WO로 반입(오프라인 번들에 패키지 추가). 지금 구현 변경 없음.


### Q-2026-10-25-05 — 시리얼 없는 장비의 device_id (Claude Code)

계약 §2: `device_id = sha1(tenant|site_id|serial)[:16]`. 그러나 현재 장비 원장(구 클라우드
`/v1/probe/devices`)에는 시리얼이 없는 행이 있다(41대 NMC 중 다수가 아직 폴링 불가라 시리얼 미수집).
지금은 `sha1(tenant|site|"ledger:<원장 id>")`로 **임시 ID**를 만들어 보낸다 — 안정적이지만
시리얼을 알게 되면 ID가 바뀐다. 계약상 시리얼 변경 시 새 device_id + `replaced_by` 링크가 정답이다.

- **(A)** 임시 ID 유지, 시리얼 확보 시 inventory에 `replaced_by`로 연결 — 권고. Codex(Portal)에 이 규칙 공유 필요.
- **(B)** 시리얼 없는 장비는 Portal로 보내지 않는다(인벤토리·텔레메트리 모두 보류).
- **(C)** 계약 v1.1에서 시리얼 없을 때의 규칙을 명시한다(양 팀 동시 반영).

A: 임시 ID 방식 **채택하되 표시 의무** — 관리자 2026-10-25. 시리얼 미수집 장비는 `sha1(tenant|site|"ledger:<id>")`로 보내고 inventory에 `provisional:true`, `id_basis:"ledger"`를 넣는다. 시리얼 확인 시 새 device_id로 inventory 전송 + 구 ID에 `replaced_by` 링크(계약 §2). 계약서 v1.1에 `provisional`/`id_basis` 필드 추가(관리자가 00 갱신). Codex는 provisional 장비를 '시리얼 미확인'으로 표시하고 ID 승계 시 이력을 합친다.


### Q-2026-10-25-06 — 계약 스키마 파일의 위치 (Claude Code)

계약 §7은 스키마를 공용 레포 `cflex-contract`에 두고 두 팀이 서브모듈로 참조한다고 한다. WO-INT-002 지시는
`docs/spec/schemas/*.json`이라 거기에 8종을 만들었다(Probe는 `CFLEX_SCHEMA_DIR`로 경로 변경 가능).
Codex(WO-PTL-001)가 같은 파일로 수신 검증을 해야 계약 테스트가 의미가 있다.

- **(A)** 당분간 `docs/spec/schemas`가 정본, Codex 워크트리는 이 경로를 참조. `cflex-contract` 분리는 나중에 — 권고.
- **(B)** 지금 `cflex-contract` 레포를 만들고 서브모듈로 전환(레포 생성은 Eric 권한).

A: **(A)** — 관리자 2026-10-25. `docs/spec/schemas`가 정본(D-08). Codex는 `/Users/macstudio/work/cflex-fms/docs/spec/schemas`를 읽어 수신 검증(WO-PTL-001 완료 기준에 포함). `cflex-contract` 분리는 양쪽 계약 테스트가 안정된 뒤 관리자가 결정.

### Q-2026-10-25-07 — 부록 B에 코드가 없는 "배터리 용량 경고" (Claude Code)

UPS 폴러는 배터리 용량을 두 단계로 본다: 30% 미만(P1) · 60% 미만(P2). 30% 미만은 `UPS_LOW_BATTERY`(P1)로
분류했다. **60% 미만(경고 단계)에 해당하는 부록 B 코드가 없다.** WO-INT-002까지는 이것을 `UPS_LOW_BATTERY`에
P2로 실어 보냈는데, 심각도를 부록 B로 고정한 지금은 그러면 P1이 된다 — 정전 복구 후 충전 중인 UPS마다
P1이 뜬다. 그래서 WO-INT-003은 **경고 단계를 Portal로 보내지 않고 `unmapped_alerts`로 센다**(추측 금지).

- **(A)** 지금대로 — 용량 경고는 Probe 로컬(콘솔 WO-INT-004)에만 남기고 Portal로 보내지 않는다. 런타임 경고는
  이미 `UPS_RUNTIME_LOW_WARN`(P3)로 간다 — 권고.
- **(B)** 계약 v1.1 부록 B에 `UPS_BATTERY_LOW_WARN`(P3) 추가 — 양 팀 동시 반영, 관리자가 00 갱신.

A: **(B) 새 코드** — 관리자 2026-10-25. 계약 v1.1 부록 B에 `UPS_BATTERY_CAPACITY_LOW`(P3, 기본 60% 미만, 방전 복귀 후 2시간 억제) 추가. 포털은 NOC 모니터링용으로 받되 P3라 담당자 통보 없음(정책 기본). `unmapped_alerts` 카운트는 유지. 다음 WO에서 매핑 반영.


### Q-2026-10-25-08 — 스키마에 v1.1 필드를 넣었는데 버전 태그는 1.0 (Claude Code)

Q-05 답대로 `inventory.schema.json`에 `provisional`(boolean)·`id_basis`(`serial|ledger`)를 추가했다(PR WO-INT-003).
계약서 00 v1.1 갱신은 관리자 몫이라 스키마 파일의 `x-contract-version`은 **1.0 그대로** 두었다.
Codex 수신 검증(WO-PTL-001)이 이 파일을 읽으므로 같은 날 반영된다. 00을 v1.1로 올릴 때 스키마 8종의
태그도 1.1로 올릴지(그러면 Probe 계약 테스트의 버전 검사도 같이 바꾼다) 지시 바람.

A: 관리자 2026-10-25: 계약서 00을 **v1.1**로 올렸고 스키마 8종의 `x-contract-version`도 1.1로 올렸다(관리자 커밋). Probe 계약 테스트의 버전 검사를 1.1로 맞추고, `X-CFlex-API-Version` 헤더는 1.1(포털은 1.0 요청도 수락). Codex(WO-PTL-001)에도 같은 파일 적용.



### Q-2026-10-25-09 — Local Console의 "기존 UI"는 어느 것인가, 포털 범위 화면은 어떻게 하나 (Claude Code)

01 §2.2·D-01은 "기존 UI 유지, 기능 추가 금지"라고만 한다. 저장소에서 빌드·실행되는 UI는 **`apps/twin`
하나뿐**이다(Vite+React, HAEA_CURRENT_STATE §2.4 "로컬 대시보드"). `frontend/src/pages/Fms.jsx`(1.x)는
package.json이 없어 빌드되지 않는다. 그런데 twin에는 D-01상 포털 범위인 화면도 들어 있다 — 3D 트윈,
NOC 월, 파워체인, 지도, Copilot, 티켓. 그리고 **설정(Admin) 화면은 없다.**

WO-INT-004는 다음처럼 진행했다(되돌리기 쉬운 쪽):
- 백엔드 `apps/console`(cflex-app)를 twin이 부르는 `/v1/me`·`/v1/fms/*` 형태 그대로 구현한다. 포털 범위
  엔드포인트(copilot·power-chain·topology·control·tickets·incidents)는 **빈 응답/404** — twin은 이미
  "엔드포인트 없음"을 처리한다. 화면을 지우지 않았다.
- 로그인 페이지와 설정 페이지는 twin에 없어서 콘솔이 정적 HTML로 제공한다(외부 호출 0, CSP `default-src 'self'`).
- twin을 콘솔용으로 빌드할 때(`vite.console.config.js`)만 Google Fonts·OpenFreeMap 타일을 뺀다. 포털용 빌드는 그대로.

- **(A)** 위대로 — twin이 기존 UI, 포털 범위 화면은 콘솔 빌드에서 그대로 두되 데이터 없음으로 표시 — 권고.
- **(B)** 콘솔 빌드에서 포털 범위 화면(3D·NOC·파워체인·지도·Copilot)을 메뉴에서 숨긴다(코드 유지, 빌드 플래그).
- **(C)** 다른 UI(Fms.jsx 1.x 등)를 기준으로 한다.

A: **(B)** — 관리자 2026-10-25. 기준 UI는 `apps/twin`이 맞다(Eric이 본 '지금 Claude가 만든 심플한 화면'). 다만 내부 콘솔 빌드에서는 포털 범위 화면(3D, NOC, 파워체인, 지도, Copilot)을 **숨긴다**(코드 삭제 금지 — apps/twin은 WO-PTL-007에서 포털로 이식). 내부에 남는 화면: 로그인, 사이트/장비 현황, 장비 상세·트렌드, 알람(목록·상세·ACK·코멘트), 설정. 빌드 플래그(`CONSOLE_PROFILE=internal`)로 분기. WO-INT-004c.


### Q-2026-10-25-10 — 로컬 알림을 보내는 곳이 v3와 다르다 (Claude Code, WO-INT-005)

`netcheck`를 방화벽 요청서 v3(01 §1)와 1:1로 맞추다 발견. v3 FW-8은 **app** → SMTP 릴레이 25/587, → 프록시 → Teams/ServiceNow 443이다.
그런데 WO-INT-003의 알람 엔진·로컬 알림기(`probe-agent/src/alarms/local-notify.js`)는 **Collector(cap01)** 에서 돈다.
지금대로 Collector에 알림 채널을 설정하면 cap01 → SMTP/프록시 연결이 생기고, v3에 없으니 HAEA 방화벽에서 막히며
`netcheck`도 FAIL로 표시한다(의도된 표시로 둠).

- **(A)** 발송을 app으로 옮긴다 — Collector는 이벤트를 콘솔(collector API, FW-7 443)로 보내고, 콘솔이 SMTP/Teams/ServiceNow로
  보낸다. 01 §2.2(로컬 알림 = Local Console)·v3 그대로. WO-INT-004c(probe-agent↔콘솔 연동)에 같이 넣으면 된다 — 권고.
- **(B)** v3에 cap01 → SMTP 25/587, cap01 → 프록시 추가를 HAEA에 요청한다(요청서 v4).
- **(C)** 둘 다(Collector는 콘솔 불통 시 예비 발송).

참고(결정 필요 없음, 기록): 컨테이너 프로파일의 app01↔app02 대체 경로는 v3대로 **443**으로 만들었다(nginx가 로컬 앱 실패 시
피어 nginx 443으로 한 번만 넘김). WO-INT-004의 베어용 `deploy/console/nginx-cflex-console.conf`는 노드 간 **8080**을 쓰는데
v3에 없다 — (A)로 가면 같은 WO에서 베어 설정도 443으로 맞추겠다.

### Q-2026-10-25-11 — Redis가 app01에만 있으면 app01 장애 시 app02도 로그인 불가 (Claude Code, WO-INT-005)

01 §2.2: 세션은 Redis, app02는 무상태 Standby. v3 FW-7에 app01↔app02 6379가 있어 Redis를 app01에 두고 app02가 원격으로 쓰게
설치기를 만들었다(`install.redis_host`, 기본 Active). 그러면 **app01 VM이 죽으면 app02도 세션 저장소가 없어 503**(콘솔이
의도적으로 그렇게 동작)이고, SAT 6 "app01 중지 → app02 서비스 지속"을 **VM 단위로는** 통과하지 못한다(앱 컨테이너만 죽으면 통과).

- **(A)** 양쪽에 Redis를 두고 app02는 app01의 복제본(replica, 6379 — v3 범위 안). app01 장애 시 app02 Redis를 승격(수동 또는
  설치기 `promote` 명령). 기존 세션 유지 — 권고.
- **(B)** 각 노드가 자기 Redis만 쓴다(복제 없음). 전환 시 사용자 재로그인만 필요. 가장 단순.
- **(C)** Redis를 db01에 둔다 — v3에 app → db 6379가 없어 요청서 변경 필요.

### 답 Q-2026-10-25-10 → **(A)** (관리자, 2026-10-26)
발송은 app(Local Console)으로 이전. Collector는 알림 채널을 갖지 않는다(설정 키는 남겨도 기본 비활성, netcheck는 cap01→SMTP/프록시를 '해당 없음'으로 표시). 방화벽 요청서 v3(이미 HAEA 제출)는 바꾸지 않는다. WO-INT-004c에 포함. 베어용 nginx 노드 간 경로도 443으로 통일.

### 답 Q-2026-10-25-11 → **(A)** (관리자, 2026-10-26)
app02에 Redis replica(6379, v3 FW-7 범위). 승격은 설치기 `cflex-install promote --role app` 수동 명령 + 운영 절차 문서(자동 failover는 넣지 않음 — 스플릿브레인 회피). SAT 6은 'app01 VM 중지 → promote → app02 서비스 지속(기존 세션 유지)'으로 절차를 명시. WO-INT-004c에 포함.

### D-11 — WO-INT-005 완료 판정 기준 (관리자, 2026-10-26)
Mac에는 Podman이 없으므로 컨테이너 프로파일은 **정적 검증만**으로 머지하고 상태는 '머지(정적 검증만)'로 둔다. 완료 처리는 RHEL 8.10/UBI8 호스트에서 `podman build` 3종·Quadlet 기동·`cflex-install verify`·`nginx -t`가 통과한 시점(SAT 또는 사전 검증 VM). 이 항목은 SAT 체크리스트에 올린다.

### Q-2026-10-26-01 — 콘솔이 꺼졌다 돌아왔을 때 늦게 도착한 알람 이벤트도 알림을 보낼지 (Claude Code, WO-INT-004c)

Q-10(A)로 알림은 콘솔이 보낸다. Collector는 이벤트를 콘솔에 먼저 보내고, 콘솔이 발송 결과(`local_notified`)를 돌려주면
그것을 포털 이벤트에 싣는다. **콘솔이 응답하지 않으면** 포털에는 `local_notified` 없이 바로 보내고(= "현장 알림 안 됨" →
포털이 라우팅), 콘솔에는 큐에 쌓았다가 복구 후 `X-CFlex-Replay: 1`로 다시 보낸다. 이때 콘솔이 알림을 보내면 포털과 **중복**될 수
있고, 안 보내면 그 사이 P1을 현장 누구도 메일로 못 받을 수 있다(포털 라우팅이 아직 없음 — WO-PTL-003).

지금 구현(기본값): 다시 받은 이벤트가 **15분 이내면 알림을 보내고, 그보다 오래됐으면 기록만** 한다(목록에는 보이고,
ServiceNow 티켓이 열려 있던 알람의 clear는 여전히 해결 처리). `CONSOLE_NOTIFY_REPLAY_MAX_S=900`으로 조정.

- **(A)** 위대로 — 15분. 포털 라우팅(WO-PTL-003)이 생기면 0으로 낮춰 중복을 없앤다 — 권고.
- **(B)** 다시 받은 이벤트는 항상 알림 없음(포털에 맡김). 포털 라우팅 전에는 그 사이 P1이 묻힌다.
- **(C)** 항상 알림(중복 감수).

### Q-2026-10-26-02 — 내부 콘솔 빌드에 남긴 것: 알람 워크벤치(/v1/incidents)·티켓, 그리고 바꾼 것: "FMS 1.x" 메뉴 (Claude Code, WO-INT-004c)

Q-09(B)의 숨김 목록(3D·NOC·파워체인·지도·Copilot)대로 내부 빌드에서 뺐다. 목록에 없는 것은 그대로 두었다.
- **알람 워크벤치**(알람 클릭 시 열리는 패널)는 `/v1/incidents`를 부른다. 콘솔에는 없으므로 404 → 워크벤치가 "아직 배포 안 됨, 알람 원본"을
  보여 주고 ACK·코멘트는 그대로 된다. **티켓 발행** 버튼도 같다(콘솔 404).
- 알람 패널의 **"AI 분석" 버튼**은 Copilot을 부르므로 내부 빌드에서 뺐다.
- 메뉴의 **"FMS 1.x (관리)"**(콘솔에 없는 페이지)는 내부 빌드에서 콘솔의 **"설정"(/settings)** 으로 바꿨다. 화면 추가가 아니라 링크 대상만 바꾼 것이다.

- **(A)** 위대로 — 권고. 워크벤치·티켓을 숨기려면 같은 방법(빌드 플래그)으로 바로 뺄 수 있다.
- **(B)** 워크벤치의 incident/티켓 부분도 내부 빌드에서 숨긴다(알람 상세는 원본 + ACK/코멘트만).

### Q-2026-10-26-03 — 베어 프로파일의 Redis는 설치기가 설정하지 않는다 (Claude Code, WO-INT-004c)

Q-11(A)의 replica·`promote`는 **컨테이너 프로파일**에 구현했다. 베어 프로파일은 WO-INT-005부터 Redis를 AppStream 패키지로
**설치만** 하고 설정(`/etc/redis.conf`·비밀번호 include)·기동은 하지 않는다(`BARE_UNITS`에 redis 없음) — 베어로 설치하면
관리자가 Redis를 손으로 설정·기동해야 콘솔이 로그인을 받는다.
`promote`는 베어에서 아무것도 바꾸지 않고 `docs/install/REDIS_FAILOVER.md` §5(손 절차)를 안내한다.

- **(A)** 베어는 폴백 경로이므로 문서 절차로 둔다. 베어 Redis 설정 렌더링(+promote)은 베어를 실제로 쓰기로 정해지면 별도 WO — 권고.
- **(B)** 지금 베어 Redis 설정 렌더링과 promote를 추가한다(반 세션).

