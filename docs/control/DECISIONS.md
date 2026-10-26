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


### 답 Q-2026-10-26-01 → **(A)** (관리자, 2026-10-26)
replay 이벤트는 15분 이내면 알림, 그 이상이면 기록만(`CONSOLE_NOTIFY_REPLAY_MAX_S=900`). 포털 라우팅(WO-PTL-003)이 운영에 들어가면 0으로 낮춰 중복을 없앤다 — 이 전환은 WO-PTL-003 완료 기준에 한 줄로 추가. 15분 창은 SAT 체크리스트(알림 중복/누락 시나리오)에 올린다.

### 답 Q-2026-10-26-02 → **(A)** (관리자, 2026-10-26)
Q-09(B) 숨김 목록 밖의 항목(알람 워크벤치·티켓 버튼)은 그대로 두고, "FMS 1.x (관리)" 링크는 콘솔 "설정"으로. 워크벤치가 404를 "아직 배포 안 됨"으로 보여 주는 것은 허용. 현장 혼란이 확인되면 같은 빌드 플래그로 숨기는 후속 소작업(반 세션 이내)으로 처리.

### 답 Q-2026-10-26-03 → **(A)** (관리자, 2026-10-26)
베어 프로파일은 폴백 경로. Redis 설정 렌더링·promote는 문서 절차(`docs/install/REDIS_FAILOVER.md` §5)로 두고, 베어를 실제 채택할 때 별도 WO로 등록한다. 명세 밖 기능 추가 없음.

### Q-2026-10-26-04 — `SNMP_TRAP_UNKNOWN`은 부록 B에 없다 (Claude Code, WO-INT-006)

WO-INT-006은 모르는 trap(모르는 발신 IP·모르는 OID)을 `SNMP_TRAP_UNKNOWN`(P4)로 기록하라고 하지만 이 코드는 **부록 B에 없고**,
`events.schema.json`의 code enum도 부록 B와 같아서 이벤트로 보내면 스키마 검증에서 막힌다. 지시대로 "부록 B 밖이면 기록만"으로 구현했다:
Probe에서 카운트(`unknown_source`/`unknown_oid`) + 로그 1줄 + 최근 200건 목록(`handler.recent()`). 포털·콘솔로는 보내지 않는다.

- **(A)** 지금대로 — 기록만. 현장에서 모르는 trap이 실제로 얼마나 오는지 SAT에서 본 뒤 필요하면 (B) — 권고.
- **(B)** 계약 v1.2 부록 B에 `SNMP_TRAP_UNKNOWN`(P4) 추가 — 양 팀 반영(스키마 enum·포털 라우팅 "통보 없음"), 관리자가 00 갱신. Probe 쪽은 매핑 1줄.

### Q-2026-10-26-05 — 환경(온도·습도)·NetBotz(도어·누수·연기)·Rack PDU trap에 해당하는 부록 B 코드가 없다 (Claude Code, WO-INT-006)

부록 B v1.1은 UPS·노드 코드뿐이다. `UPS_HIGH_TEMP`는 UPS 자체(배터리) 온도라 랙 환경 센서 온도에 쓰면 뜻이 달라진다.
그래서 환경·NetBotz·PDU trap은 **매핑하지 않았고** `SNMP_TRAP_UNKNOWN` 경로(기록만)로 간다. 새 코드는 만들지 않았다.

- **(A)** 지금대로 — UPS만 알람, 나머지 trap은 기록만. 환경/PDU 알람은 계약 v1.2(코드 추가) 후 별도 WO — 권고.
- **(B)** 계약 v1.2에 환경·도어·누수·연기·PDU 분기 과전류 코드를 추가(관리자가 목록·심각도 결정) → Probe는 `apc-mib.js` 표에 행 추가(반 세션).

### Q-2026-10-26-06 — APC PowerNet-MIB trap 번호의 현장 MIB 대조 (Claude Code, WO-INT-006)

`src/trap/apc-mib.js`의 trap 번호(specific 1·2·3·5·7·8·9·10·11·12·17·20–23·30·33·36)는 PowerNet-MIB 정의를 기준으로 적었지만,
이 세션에서는 MIB 파일 원본(레포에 없음, 웹 조회 권한 없음)과 대조하지 못했다. 시뮬레이터·테스트는 같은 표를 쓰므로 번호가 틀려도 테스트는 통과한다.

- **(A)** SAT 체크리스트에 "HAEA NMC 펌웨어의 PowerNet-MIB와 `apc-mib.js` 대조 + 실제 NMC에서 test trap 1건 수신 확인"을 한 줄 추가. 틀리면 표 1줄 수정 — 권고.
- **(B)** 관리자가 MIB 파일(`powernet*.mib`)을 레포 `docs/vendor/`에 넣어 주면 다음 세션에서 테스트가 MIB 파일을 직접 파싱해 표를 검증하게 한다.
### D-12 — Probe(내부) 범위 동결, 알림 엔진은 포털 (Eric 지시, 2026-10-26)
법인장 정의: **Probe = 모든 UPS 정보를 취합(SNMP 폴링·trap)하고 HAEA 내부 직원(NOC)에게 현재 상태를 보여주는 것.** 내부에 보이는 것은 지금 개발된 수준(상태·알람 수신/표시/ACK·장비 현황·트렌드·설정)에서 **동결**한다. 기능 추가 금지.
SMS·이메일·Teams 발송과 에스컬레이션, 24x7 센터의 즉각 조치는 **포털(Codex, cflex.fms.support)** 의 역할이다. Probe→포털 443 아웃바운드(계약 00)가 그 통로다.
따라서 Q-2026-10-25-10의 답 (A)는 다음으로 축소한다: 내부 발송은 SOW 검수 항목인 **ServiceNow eBonding(테스트 티켓 1건) 최소 구현만** app에 두고, 내부 SMTP/Teams 발송은 기본 비활성 선택 기능으로 남기되 더 이상 개발하지 않는다. Collector에는 발송 채널을 두지 않는다(v3 준수). 중복 억제용 `local_notified`는 유지.
우선순위: 내부 Probe는 004c(축소 범위)·006(trap)·007(스모크)·008(PostgreSQL)로 마무리. **병목은 포털(WO-PTL-001 /api/v1 수신·mTLS, WO-PTL-002 알림 발송 엔진·에스컬레이션, 24x7 센터 화면)** — Codex 지시를 이 순서로 구체화한다.

### D-12a — 보강 (Eric 지시, 2026-10-26): Probe는 "수집하고 보여주는 것"만 한다
알람 처리(발송·에스컬레이션·티켓·당직 대응)는 전부 매니지드 서비스 포털의 일이다. Probe/Local Console은 **현재 개발된 범위를 넘는 어떤 것도 만들지 않는다.**
- D-12의 "ServiceNow eBonding 최소 1건"도 Probe 범위에서 **제외**한다. SOW의 ITSM 티켓 항목은 포털→HAEA ServiceNow(SaaS) 경로로 충족한다(WO-PTL-002에 포함).
- 이미 만들어진 로컬 알림 코드(WO-INT-003 local-notify)는 삭제하지 않되 **기본 비활성**으로 두고 더 손대지 않는다. Collector→app 이전은 004c(PR #6)에서 이미 반영됨 — 그 상태에서 종결, 기본 비활성.
- 남는 내부 작업은 "수집·표시"를 동작시키는 데 필요한 것만: 004c(내부 프로파일 화면 정리 + probe-agent↔콘솔 실연동 + Redis replica), 006(trap 수신 = 수집), 007(실기동 스모크), 008(PostgreSQL 마이그레이션). 이 넷이 끝나면 내부 Probe는 **기능 완료(feature-complete)** 로 선언하고 이후는 SAT·버그 수정만.

### D-14 — 지식베이스·사이트 기준선·AI 응답 (Eric 지시 2026-10-26, 명세 03 배포) — *위치: D-13 앞에 둔 것은 PR #7의 DECISIONS 말미 추가와 충돌을 피하기 위함*
법인장 지시: APC 매뉴얼·KB·MIB 전체와 커뮤니티 지식을 모아 "특별한 상황에서 무엇을 해야 하는지"를 AI가 출처와 함께 답하고, 사이트 내부 상태(장비 빌드업·환경·케이블링·알람 히스토리)를 AI가 가장 정확히 아는 기준선으로 운영한다.
- 구현 위치: **포털(Codex)**. Probe/Local Console은 D-12a 동결 유지 — 데이터 사전 문서(WO-INT-013)만 제공. 온프레미스에 AI 기능·외부 호출 없음.
- 명세: `docs/spec/03_SPEC_KNOWLEDGE_AI-Ops_v1.md`. 정본 데이터: `knowledge/`(sitebook·runbooks·sources·schemas·eval). WO-PTL-008/009/010, WO-INT-013 등록.
- 출처 정책(권고안으로 진행, 반대 시 수정): 제조사 **공식 공개 문서만** 자동 수집·내부 참조 보관, 고객 화면엔 요약·인용·링크만; 커뮤니티는 원문 복제 없이 런북 요약+링크+신뢰 등급(C/D). LLM은 포털 측 외부 API(권고 Anthropic), 유닛 컨텍스트 최소 전송·비밀 0.
- 장비 쓰기 금지(D-05)는 AI 응답에도 적용: 조치는 항상 사람이 NMC에서. AI는 계약 00 읽기성 명령 제안까지만.
- 시드: HAEA HQ Q3-2026 PM 보고서 5건 → Site Book 6유닛(UPS B는 부록 C만), 런북 8건, 골든 Q&A 21문항.

### D-13 — 분산 구조 확정: 프로브(컬렉터) N대 → FMS(Local Console) → 포털 (Eric 지시, 2026-10-26)
- **프로브(컬렉터) = 수집만.** SNMP 폴링·trap 수신·1차 정규화. 사이트 단위로 N대 배치 가능(각 컬렉터는 `site_id`별 자기 장비 목록만 보유, `node_id` cap01/cap02…). 컬렉터는 **외부(인터넷) 경로를 갖지 않는다** — FMS(app) 443으로만 보낸다.
- **FMS(app01/app02 Local Console) = 표시·관리·취합.** 여러 컬렉터 데이터를 `device_id`로 합치고 NOC에 보여준다(D-12a 범위 그대로, 기능 추가 없음).
- **포털 송신기(forwarder, 계약 00)는 컬렉터에서 FMS(app)로 이동.** 외부로 나가는 지점은 app 노드뿐. 저장·재전송 7일 버퍼는 FMS DB에서. 계약 00의 `node_id`는 송신 노드(app01) 기준, 텔레메트리의 수집 노드는 `collector_id` 필드로 보존(계약 v1.2 소폭 개정, 하위호환).
- **HAEA 1차 배포는 컬렉터 1대(cap01v)** — VM 4대가 한 세그먼트(10.138.14.66~69)에 있고 방화벽 v3가 그 전제. 사이트별 컬렉터는 HAEA가 VM을 추가 제공할 때 설정 추가로 확장(방화벽 v4 필요 — 그때 요청).
- 실행: **WO-INT-012** (007·008 이후). 범위: forwarder 모듈을 app으로 이동(코드 재사용, 컬렉터의 포털 설정 제거), 컬렉터 다중 인스턴스 설정(`site_id` 스코프)·FMS 병합, 계약 00 v1.2 `collector_id`, netcheck/방화벽 표에서 cap01→포털 행을 '해당 없음'으로(v3 문서 자체는 변경 않음). 테스트: 컬렉터 2개 + FMS 1개 E2E.

### Q-2026-10-26-07 — better-sqlite3는 RHEL 8에서 prebuild가 로드되지 않는다: 이미지 안 소스 빌드의 검증 시점 (Claude Code, WO-INT-007)

**실측(2026-10-25):**
- better-sqlite3가 GitHub에 올리는 linux-x64 prebuild를 받아 보았다(9.6.0·10.1.0·11.0.0·11.10.0, Node 20 = v115, Node 22 = v127).
  전부 `GLIBC_2.29` 심볼을 요구한다. RHEL 8.10 / UBI8의 glibc는 **2.28**이다.
- 그래서 UBI8에서는 prebuild-install이 받은 바이너리의 로드 검사에 실패하고 `node-gyp rebuild`로 넘어간다.
  지금까지의 이미지 빌드도 사실상 소스 빌드에 기대고 있었다.

WO-INT-007에서 한 일:
- Containerfile 2종이 `npm_config_build_from_source=true`로 소스 빌드를 **명시**한다. 빌드 직후 `:memory:` 로드 검사를 하고, 실패하면 빌드가 멈춘다.
- `build-bundle`은 이미지마다 better-sqlite3 로드와 ABI 115를 검사한다. 아니면 번들을 만들지 않는다.
- `ubi8/nodejs-20` 이미지 history로 툴체인을 확인했다: `make gcc gcc-c++`가 있고, `python3`는 platform-python(3.6)에 링크되어 있다.
- **확인하지 못한 것:** RHEL nodejs:20의 npm에 딸린 node-gyp가 Python 3.6을 받아들이는지. Podman이 없어 실제 `podman build`를 못 했다.
  이 Mac에서는 Node 20.20.2 + `--build-from-source`로 컴파일하고 로드까지 확인했다.

- **(A)** 지금 구조를 유지한다. RingOn 빌드 호스트에서 처음 `podman build`(D-11과 같은 시점)를 할 때 확인한다.
  python 때문에 실패하면 build 단계에만 `dnf install python39`(UBI 저장소, 빌드 호스트 전용, 현장 무관)를 한 줄 추가한다 — 권고.
- **(B)** 지금 build 단계에 `USER 0` + `dnf install -y python39`를 미리 넣는다. 검증 없이 넣는 변경이고, 빌드 호스트가 UBI 저장소에 접근해야 한다.
- **(C)** better-sqlite3를 순수 JS/WASM 드라이버로 바꾼다. 명세 밖이고 Collector 버퍼 성능을 다시 검증해야 한다 — 비권고.

권고안 (A)로 진행했다.

### 답 Q-2026-10-26-04 → **(A)** (관리자, 2026-10-26)
`SNMP_TRAP_UNKNOWN`은 부록 B 밖 — Probe 내부 카운트·로그·최근 200건만. 계약 v1.2(WO-INT-012 `collector_id`와 같은 개정)에서 추가할지 SAT 실측 뒤 결정.

### 답 Q-2026-10-26-05 → **(A)** (관리자, 2026-10-26, 권고안 — 법인장 반대 시 변경)
환경(온·습도)·NetBotz(도어·누수·연기)·Rack PDU trap 코드는 부록 B v1.1에 없으므로 매핑하지 않고 기록만. 코드 추가는 계약 v1.2 개정(WO-INT-012와 묶음)에서 법인장이 HAEA 제공 범위를 정한 뒤 — Probe는 `apc-mib.js` 표 행 추가(반 세션). 알람 라우팅·통보는 D-12a대로 포털 책임.

### 답 Q-2026-10-26-06 → **(A)** (관리자, 2026-10-26)
SAT 체크리스트에 "HAEA NMC 펌웨어 PowerNet-MIB와 `apc-mib.js` trap 번호 대조 + 실제 NMC test trap 1건 수신"을 추가한다. MIB 원본을 레포에 두는 (B)는 라이선스 확인 전까지 보류.

### 답 Q-2026-10-26-07 → **(A)** (관리자, 2026-10-26)
Containerfile의 `npm_config_build_from_source=true` + 빌드 직후 로드 검사 + `build-bundle` ABI 115 검사 구조를 유지한다. 첫 `podman build`(RingOn 빌드 호스트, D-11 시점)에서 node-gyp/Python 3.6 문제가 나오면 build 단계에만 `python39` 추가. WO-INT-007 완료(PR #8).

### Q-2026-10-26-08 — 집계 표 범위: 보존 "집계 10년"의 대상 표가 없다 (Claude Code, WO-INT-008)
명세 §2.3의 보존은 raw 3년 / 집계 10년 / 이벤트·감사 10년이다. 콘솔에는 지금 집계(시간·일 평균) 표가 없다. 트렌드는 raw `telemetry`를 조회할 때 버킷 평균으로 계산한다.
- **(A)** 집계 표를 만들지 않는다(D-12a 기능 추가 금지). 보존 설정 `CFLEX_RETENTION_AGGREGATE_YEARS`(site.yaml `retention.aggregate_years`, 기본 10)만 자리를 잡아 둔다.
  raw 3년이 지난 트렌드는 볼 수 없다. 장기 리포트는 포털(WO-PTL-006)이 한다 — **권고, 이대로 진행했다.**
- **(B)** 시간 평균 표(`telemetry_hourly`, 월 파티션)와 롤업 작업을 추가한다. 화면은 그대로 둔다. 기능 추가에 해당한다.

### Q-2026-10-26-09 — 월 파티션 선행 개수와 주기 (Claude Code, WO-INT-008)
- **(A)** 이번 달 + **3개월 앞**(`CFLEX_PARTITION_AHEAD_MONTHS=3`)을 만든다. 기동할 때와 **6시간마다** 돈다(`CFLEX_PARTITION_INTERVAL_H=6`). 두 노드 중 advisory lock을 잡은 쪽만 한다.
  두 노드가 석 달 동안 모두 내려가 있지 않는 한 파티션이 모자라지 않는다. 그래도 모자라면 DEFAULT 파티션이 받고, 그 달을 만들 때 옮긴다 — **권고, 이대로 진행했다.**
- **(B)** 12개월 앞(빈 파티션이 표당 12개).

### Q-2026-10-26-10 — 베어 프로파일 db01: initdb·계정·pg_hba를 설치기가 하지 않는다 (Claude Code, WO-INT-008)
컨테이너 프로파일(기본)은 rhel8/postgresql-16 이미지가 initdb·계정·DB를 만든다. 설치기는 설정 조각·백업 스크립트·타이머를 렌더한다.
베어 프로파일도 설치기가 AppStream 설치와 조각·타이머·`PGDATA=/opt/data/pgsql/data` 드롭인까지는 한다. initdb, `cflex` 계정·DB, `pg_hba`(app 2대 /32), include 줄은 수동이다(`PG_BACKUP_RESTORE.md` §1.1).
- **(A)** 문서 절차로 둔다. HAEA가 Podman을 거절해 베어로 가게 되면 그때 별도 WO(반 세션)로 자동화한다 — **권고.**
- **(B)** 지금 `deploy.py`에 베어 db 단계를 추가한다(검증할 RHEL 호스트 없음).

### Q-2026-10-26-11 — `pg` 의존성의 번들 방식 (Claude Code, WO-INT-008)
`pg`는 순수 JS이다(네이티브 빌드 없음). app 이미지 deps 단계의 `npm install --omit=dev`로 `apps/console/node_modules`에 들어간다.
베어 트리는 이미지에서 꺼낸 같은 트리라 그대로 따라간다. `build-bundle`은 app 이미지에서 `require('pg')`도 확인한다. embedded-postgres(테스트용 PG 16)는 devDependency라 이미지·번들에 들어가지 않는다.
- **(A)** 이대로 간다. lockfile은 지금처럼 커밋하지 않는다(버전 고정은 `^8.13.0` 범위 — SBOM 스텁 그대로) — **권고, 이대로 진행했다.**
- **(B)** `apps/console/package-lock.json`을 커밋해 빌드 재현성을 고정한다(collector·app 공통 정책 변경이라 관리자 결정 사항).

### Q-2026-10-26-12 — 명세 §3.3 "DB 마이그레이션(전방향+롤백 스크립트)": 롤백 스크립트를 두지 않았다 (Claude Code, WO-INT-008)
- **(A)** 마이그레이션은 **추가만** 한다(표·열·파티션 추가. 삭제·변경 없음). 그러면 `rollback`은 이미지만 되돌려도 이전 콘솔이 새 스키마에서 돈다.
  설치기 `rollback`은 "schema kept"를 출력한다. 스키마까지 되돌려야 하면 복구한다(`PG_BACKUP_RESTORE.md` §3·§4) — **권고, 이대로 진행했다.**
- **(B)** 파일마다 `NNNN_*.down.sql`을 두고 `rollback`이 실행하게 한다(0001의 down = 전체 삭제라 운영 데이터 소실 위험).

### Q-2026-10-26-13 — SQLite 이관 원본 경로: 지시는 `/var/lib/cflex/console.db`, 실제 설치 경로는 `/opt/app/cflex/data/console.db` (Claude Code, WO-INT-008)
설치기(app.env `CONSOLE_DB`)와 app 이미지가 쓰던 경로는 `/opt/app/cflex/data/console.db`이다. 레포에 `/var/lib/cflex`는 없다.
- **(A)** `cflex-migrate-sqlite`의 기본값을 `$CONSOLE_DB`로 하고, 없으면 `/opt/app/cflex/data/console.db`로 한다. 다른 경로는 `--sqlite <file>`로 지정한다 — **권고, 이대로 진행했다.**
- 함께 기록: 옮기는 것은 사용자·설정·장비·크리덴셜·유지보수 창·열린 알람(+코멘트·ServiceNow 매핑)·최근 90일 이벤트(`--events-days`)이다.
  지시 범위 밖이지만 **감사로그 전부**도 옮긴다(append-only 10년 보존 — 업그레이드로 감사 기록이 끊기지 않게). 텔레메트리는 옮기지 않는다.
