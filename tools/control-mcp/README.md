# @cflex/control-mcp

작업지시판을 MCP로 노출한다. 관리자(Cowork Claude) · Claude Code · Codex 세 쪽이
같은 서버를 각자의 신분으로 띄워 쓴다. **의존성 0개**, Node ≥ 20.

```
docs/control/TASKS.md      작업지시 (WO-INT-xxx / WO-PTL-xxx)
docs/control/STATUS.md     보고 — 에이전트별 블록, 추가 전용
docs/control/DECISIONS.md  확정 결정(D-xx) + 열린 질문(Q-날짜-번호)
        ↑
   이 세 파일이 그대로 정본이다. 서버는 파싱하고 되쓴다.
```

## 왜 파일을 그대로 두는가

SQLite에 넣고 markdown을 뷰로 만드는 쪽이 파싱은 훨씬 쉽다. 여기서는 틀리다.
`CLAUDE.md`·`AGENTS.md`가 세 에이전트에게 **이 파일들을** 읽고 쓰라고 지시하고,
관리자는 git diff로 검토하고, 사람이 읽는다. 저장소를 바꾸면 규칙을 다시 쓰고
diff를 잃는다.

대신 파싱 취약성이라는 값을 치른다. 그 값은 **왕복 테스트**로 낸다 —
`parse → serialize`가 저장소의 실제 파일을 **바이트 단위로** 재현해야 하고,
`save()`는 왕복하지 않는 결과를 **쓰기 거부**한다. 포맷이 바뀌면 조용히 망가지는
대신 테스트가 깨진다.

## 무엇이 달라지는가

파일만 쓸 때의 실패 세 가지를 막는다.

| 문제 | 서버가 하는 일 |
|---|---|
| 에이전트가 STATUS 형식을 매번 손으로 맞춘다 | `control_report`가 형식을 생성한다 |
| 두 에이전트가 동시에 쓰면 하나가 사라진다 | 디렉터리 락(원자적 mkdir) + 원자적 rename. 60초 넘은 락은 버려진 것으로 간주 |
| 남의 블록·남의 작업을 건드린다 | 신분(`CFLEX_AGENT`)으로 차단. Codex 보고는 Codex 블록에만 들어간다 |

추가로 **완료 처리는 관리자만** 할 수 있다. 에이전트가 `status: '완료'`로 보고하면
`검토요청`으로 기록되고 "완료 처리는 관리자가 한다"가 STATUS에 남는다 —
`CLAUDE.md`의 "PR이 없는 작업은 완료로 인정하지 않는다"와 같은 규칙이다.

## 등록

### Claude Code (내부 담당)

저장소에 `.mcp.json`이 들어 있으므로 `cflex-fms`를 열면 자동으로 붙는다.
수동 등록이 필요하면:

```sh
claude mcp add cflex-control \
  --env CFLEX_AGENT=claude-code \
  --env CFLEX_ROOT=/Users/macstudio/work/cflex-fms \
  -- node /Users/macstudio/work/cflex-fms/tools/control-mcp/server.js
```

### 관리자 (Cowork Claude — PM)

`manager`만 `control_assign` · `control_set_status` · `control_answer`를 본다.

```sh
claude mcp add cflex-control \
  --env CFLEX_AGENT=manager \
  --env CFLEX_ROOT=/Users/macstudio/work/cflex-fms \
  -- node /Users/macstudio/work/cflex-fms/tools/control-mcp/server.js
```

### Codex (포털 담당)

Codex는 자기 저장소에서 돌지만 작업지시판은 `cflex-fms` 쪽 하나다 — `CFLEX_ROOT`로 가리킨다.
`~/.codex/config.toml`:

```toml
[mcp_servers.cflex-control]
command = "node"
args = ["/Users/macstudio/work/cflex-fms/tools/control-mcp/server.js"]
env = { CFLEX_AGENT = "codex", CFLEX_ROOT = "/Users/macstudio/work/cflex-fms" }
```

확인: `claude mcp list` 또는 세션에서 `/mcp`.

## 도구

### 세 쪽 공통

| 도구 | 쓰는 때 |
|---|---|
| `control_board` | **세션 시작 첫 호출.** 내 대기/진행 작업(우선순위 순), 확정 결정, 열린 질문, 보류 항목을 한 번에 |
| `control_answers` | 그다음. 내가 올린 질문에 답이 달렸는지 |
| `control_task` | 지시 하나를 전문으로 — 작업 내용 + 완료 기준 전체 |
| `control_claim` | 작업을 집는다 (대기 → 진행). 남의 작업·보류는 거부. 우선순위를 건너뛰면 경고 |
| `control_ask` | 모호하면 추측하지 말고 질문. Q 번호 자동 발급(같은 날 충돌 없음) |
| `control_report` | **세션 종료 필수.** 내 블록에 추가. TASKS 상태도 같이 갱신 |

### 관리자 전용

| 도구 | |
|---|---|
| `control_assign` | 새 지시 생성. ID는 섹션 접두어로 자동 발급 |
| `control_set_status` | 검토요청 → 완료, 보류, 우선순위 변경. `note`는 관리자 검토 로그에 |
| `control_answer` | 질문에 답. `promote_as`를 주면 `D-xx` 확정 결정으로 승격 |

에이전트 서버에서 관리자 도구를 부르면 `tools/list`에 아예 안 나오고,
직접 호출해도 `-32600 manager-only`로 거부된다.

## 하루

```
세션 시작
  control_board            → mine_actionable: ["WO-INT-002", …]
  control_answers          → Q-2026-10-25-01 답 왔나?
  control_claim WO-INT-002 → 대기→진행, 완료 기준 전문 받음
     … 작업 …
  control_ask              → 막히면 Q 발급하고 다음 WO로
세션 종료
  control_report { entries:[{id, status:'검토요청', branch, commit, tests, acceptance}], next }
  git commit && git push   ← 이건 여전히 사람/에이전트가 한다
```

서버는 **git을 건드리지 않는다.** 커밋·푸시·PR은 `CLAUDE.md`가 정한 대로
에이전트의 일로 남긴다. 책임 위치를 바꾸지 않기 위해서다.

## 테스트

```sh
node tools/control-mcp/test/control.test.js    # 26종
```

실제 `docs/control`의 **복사본**에만 돌린다 — 원본을 건드리지 않는다.
검사하는 것: 세 파일의 바이트 왕복 · 변경 없을 때 쓰기 0건 · 소유권(남의 작업 집기
거부, 남의 블록 불변) · STATUS 추가 전용(연속 보고 둘 다 생존) · 에이전트의 완료 보고가
검토요청으로 강등 · Q 번호 충돌 없음 · 관리자 승격이 확정 섹션 안에 들어감 ·
오래된 락 회수 · 살아있는 락은 크게 실패 · JSON-RPC `initialize`/`tools/list`/`tools/call` ·
도구 스키마 정합(선언/핸들러 수 일치) · **의존성 0개, 네트워크·git 호출 0건**.

마지막 항목이 이 패키지의 약속이다. 작업지시판을 읽고 쓰는 것 말고는
아무 데도 손을 뻗지 않는다.
