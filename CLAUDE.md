# cflex-fms — Claude Code 작업 규칙 (이 파일은 세션마다 먼저 읽는다)

당신의 역할: **내부(HAEA 온프레미스) Probe + Local Console + Forwarder + 설치 번들** 담당.
외부 포털(라우팅·NOC·리포트·PM·3D)은 Codex 담당 — 그쪽 코드를 만들지 않는다.
기준 문서: `docs/spec/01_SPEC_INTERNAL_Probe-OnPrem_for-ClaudeCode_v1.md`, 계약서 `docs/spec/00_INTERFACE_CONTRACT_Probe-Portal_v1.md`.
관리자(PM 역할)는 Cowork의 Claude가 맡는다. 지시는 `docs/control/TASKS.md`로 내려오고, 보고는 `docs/control/STATUS.md`로 올린다.

## 세션 시작 시
0. `git status --short docs/control CLAUDE.md`에 미커밋 변경이 있으면(관리자 PM 세션이 파일만 갱신한 것) 먼저 `[CTRL] control update <날짜>`로 커밋한다. 내용은 수정하지 않는다.
1. `docs/control/TASKS.md`를 읽고 **자기(Claude Code)에게 배정된 `상태: 진행` 또는 `대기` 작업지시(WO-INT-xxx)만** 수행한다. 우선순위 번호 순서대로.
2. 배정되지 않은 일, 범위 밖 기능 추가, 포털 쪽 코드는 하지 않는다. 필요하다고 판단되면 `docs/control/DECISIONS.md`에 `Q-날짜-번호`로 질문을 남기고 다음 WO로 넘어간다.
3. 모호한 요구는 추측하지 말고 DECISIONS.md에 질문을 남긴다.

## Git 운영 (관리자는 git으로 진행을 본다)
- **세션 하나 = 작업 트리 하나.** `/Users/macstudio/work/cflex-fms`(메인 트리)는 관리자가 기동하는 헤드리스 세션 전용이다. 사람이 여는 대화형 Claude Code 세션은 시작하자마자 `git worktree add ../cflex-fms-wt-<주제> -b wo/<ID>-<주제> main` 으로 **자기 트리를 만들고 거기서만** 작업한다. 남의 트리에서 `checkout`/`switch`/`stash`/`reset` 금지 — 2026-10-25에 두 세션이 한 트리를 공유해 고아 커밋과 TASKS 재배열 사고가 났다.
- `docs/control/*`를 고칠 일이 있으면(STATUS 보고 포함) 자기 트리에서 커밋하고 push한다. 관리자가 main으로 합친다.
- WO마다 브랜치: `wo/INT-003-short-name` (base: `main`). `main`에 직접 커밋하지 않는다.
- 커밋 메시지 접두어: `[WO-INT-003] …`. 하나의 커밋은 하나의 WO. 커밋 본문에 "완료 기준 중 무엇을 충족했는지"를 적는다.
- WO 완료 시 `gh pr create --base main --title "[WO-INT-003] …"` 로 PR을 연다(본문: 완료 기준 체크리스트 + 테스트 출력). **머지는 관리자가 한다.** PR이 없는 작업은 완료로 인정하지 않는다.
- 매 세션 종료 시 `git push -u origin <브랜치>`까지 한다(auto 모드에서 push가 막히면 STATUS에 '미푸시'라고 적는다) (origin: github.com/ericpark961-design/cflex-fms). 푸시 안 된 작업은 보이지 않는 작업이다.
- 관리자 지시(TASKS/DECISIONS 변경)는 `main`에 `[CTRL] …` 커밋으로 들어온다. 세션 시작 시 `git fetch && git log origin/main -5 -- docs/control`로 새 지시를 확인한다.

## 작업 중
- 각 WO의 **완료 기준(Acceptance)** 을 전부 만족해야 `완료`로 보고한다. 테스트가 명시돼 있으면 실행 결과를 STATUS에 붙인다.
- 운영 서버·고객 VM·DNS·비밀정보 변경 금지. 비밀값(토큰·키·community·webhook URL)을 파일·로그·STATUS에 쓰지 않는다.
- 다른 에이전트(Codex) 소유 경로를 수정하지 않는다: `cflex-fms-codex/**`, `docs/control/STATUS.md`의 Codex 블록.
- 기존 규칙 유지: `checkout/reset/stash`로 다른 작업 트리를 건드리지 않는다.

## 세션 종료 시 (반드시)
`docs/control/STATUS.md`의 **Claude Code 블록**에 아래 형식으로 **추가**(덮어쓰지 않음)하고 커밋한다.
```
### 2026-10-25 09:40 PDT — Claude Code
- WO-INT-001: 완료 | 커밋 7c7277b | 테스트 node --test probe-agent 18/18 | 비고 …
- WO-INT-003: 진행 60% | 남은 것: ServiceNow 테스트 티켓 | 블로커: 없음
- 질문: Q-2026-10-25-01 (DECISIONS.md)
- 다음 세션 계획: WO-INT-003 마무리 → WO-INT-004
```
STATUS에 쓰지 않은 작업은 관리자가 인정하지 않는다.
