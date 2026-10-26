# 포털 연결 끊김·복구 알람 정의 v1

- 문서: `docs/handoff/PORTAL_LINK_ALARM_DEFINITION.md`
- 작성: Claude Code (내부 Probe 담당) · 2026-10-26
- 근거: 계약 `IFC-CFLEX-2026-1023 v1.1` 부록 B, 내부 스펙 `docs/spec/01`, D-07
- 구현: `probe-agent/src/alarms/portal-link.js` · 시험 `probe-agent/test/portal-link.test.js` (11/11)

## 0. 왜 이 문서가 필요했나

여태 포털 연결이 끊기면 **아무 일도 일어나지 않았다.** 큐에 쌓이고 로그에 한 줄
남고, 누가 콘솔을 열어볼 때까지 조용하다. D-07 의 7일 버퍼가 차오르는 동안
아무도 모르는 상태가 가능했다.

새 코드는 만들지 않았다. 계약 부록 B 에 `PORTAL_LINK_DOWN` (P3) 이 이미 있고
`docs/spec/schemas/events.schema.json` 의 enum 과 `probe-agent/src/alarms/codes.js`
에도 들어 있다 — **올리는 쪽만 없었다.**

## 1. 두 알람은 중복이 아니다

| | `PROBE_OFFLINE` | `PORTAL_LINK_DOWN` |
|---|---|---|
| 감지 | 포털 (허트비트 5분 침묵) | 프로브 (자기가 못 닿음) |
| 소유 | Codex / 포털 `WO-PTL-003` | Claude Code / 내부 |
| 청중 | **C-Flex NOC** (24×365 AI 운영센터) | **HAEA IT** |
| 조치 | 고객망이 죽었나, VM 이 죽었나 | 프록시 규칙, 방화벽, DNS, 인증서 |
| 전달 | 포털 라우팅 | 로컬 통지(콘솔·메일·Teams·ITSM) |

끊김의 원인은 거의 항상 **HAEA 경계 안쪽**이다. NOC 은 HAEA 프록시 규칙을
고칠 수 없고, HAEA IT 는 포털 대시보드를 보고 있지 않다. 그래서 **억제(dedup)가
아니라 각자 자기 청중에게 보낸다.** 링크가 돌아오면 큐에 있던 raise/clear 가
포털에 도착해 NOC 이 프로브 쪽 시각을 뒤늦게 본다 — 그게 상호참조다.

> 포털 쪽에 요청할 것은 없다. 이 정의는 내부 범위 안에서 끝난다.

## 2. 전달 경로 — 포털을 거치면 안 된다

"포털이 안 보인다" 는 알람을 포털을 통해 보내면 쓸모가 없다.

- `postEvents()` 는 포털 큐에만 넣는다 → 끊긴 동안 **아무에게도 전달되지 않고
  복구된 뒤에야 도착한다.** 이 알람에선 전부 무의미해진다.
- `emit()` 은 **로컬 통지를 먼저** 하고(`local-notify`: 콘솔·메일·Teams·ITSM)
  포털에는 큐로 넣는다. → 링크 알람은 `emit()` 을 쓴다.

`CLOCK_DRIFT` 가 `postEvents()` 를 쓰고 있다. P4 이고 급하지 않아 지금은 두지만
같은 약점을 갖는다 — 별건으로 남긴다 (§7).

## 3. 임계값과 그 이유

| 항목 | 값 | 이유 |
|---|---|---|
| 끊김 판정 | **300초 무성공 AND 실패 3회 이상** | 300초는 포털 `PROBE_OFFLINE` 과 같은 지평이다. 한쪽은 끊겼다고 하고 다른 쪽은 괜찮다고 하는 창을 만들지 않는다. |
| 실패 횟수 하한 | 3회 | 백오프가 재시도 간격을 5분까지 늘리므로(D-07) **시간만 보면 한 번의 긴 멈춤에도 떠버린다.** |
| 시간 조건 필요성 | — | 반대로 **횟수만 보면 시간을 못 잰다.** 둘 다 본다. |
| 복구 판정 | **첫 성공 즉시** | 복구는 빨리 알려야 한다. |
| 재발 억제 | clear 후 **600초** | 90초마다 끊기는 링크를 막는 건 clear 를 늦추는 게 아니라 **raise 를 무는 것**이다. |
| `alarm_update` | **보내지 않는다** | 끊긴 동안 포털엔 어차피 안 가고, 로컬 메일을 반복하면 사람이 필터를 만든다. raise 하나, clear 하나. |

### 한 번도 연결된 적 없는 노드

**올리지 않는다.** 설치 중에는 링크가 정의상 끊겨 있고, 설치할 때마다 호출기가
울리면 사람은 이 알람을 무시하게 된다. 콘솔 단계 사다리가 `mTLS 연결 확인 ·
FAIL` 로 이미 보여준다.

**예외 — 24시간 백스톱.** 인증서가 설치된 뒤 24시간이 지나도 한 번도 못 붙었으면
그건 설치 중이 아니라 **실패한 설치**다. 그때 한 번 올린다 (`never_connected: true`).
한 번뿐이다.

## 4. 이벤트 모양

```jsonc
// raise
{
  "code": "PORTAL_LINK_DOWN", "severity": "P3", "kind": "alarm_raise",
  "device_id": null,            // 노드 알람 — 장비에 매달지 않는다
  "site_id": "HAEA-HQ", "source": "system",
  "title": "포털 연결 끊김 420 s (https://cflex.fms.support)",
  "detail": {
    "endpoint": "https://cflex.fms.support",
    "cause": "proxy",           // proxy|cert|auth|throttled|portal|dns|tls|network|unknown
    "hint": "프록시 인증/허용 목록을 확인하라 (D-09: Basic 만)",
    "never_connected": false,
    "down_since": "...", "last_success": "...",
    "attempts": 7, "last_status": 407,
    "queue_depth": 412          // 7일 버퍼가 얼마나 찼나 = 데이터가 위험한가
  }
}
// clear — 같은 alarm_id 로 내린다 (ITSM 티켓이 닫히는 조건)
{ "kind": "alarm_clear", "detail": { "down_s": 1860, "cause_was": "proxy", "queued_while_down": 412 } }
```

### 원인 분류를 왜 하나

상태 코드만으로는 **401 이 토큰 문제인지 장치 인증서 문제인지 구분되지 않고,
그 둘은 조치가 완전히 다르다.** 포털이 `mtls_certificate_required` 같은 코드를
돌려주므로 본문에서 꺼내 분류한다. `hint` 는 HAEA IT 가 개발자를 부르지 않고
손댈 곳을 가리킨다.

## 5. 심각도와 통지 임계값 — 해결해야 할 충돌

- 계약 부록 B: `PORTAL_LINK_DOWN` = **P3**
- `local-notify` 기본 정책: `email_min` / `teams_min` / `itsm_min` = **P2**

그대로 두면 **아무에게도 가지 않는다.** 계약의 P3 는 *포털로 보내는 이벤트의
라우팅 심각도*를 정한 것이고, 로컬 통지 임계값은 내부 정책(`docs/spec/01` 범위)
이므로 **이 코드에 한해 로컬 통지 임계값을 P3 로 내리는 예외**가 맞다고 본다.
"우리가 안 보인다" 는 단 하나의 알람을 아무에게도 안 알리는 건 무의미하다.

- 심각도를 P2 로 올리는 선택은 **하지 않았다** — 계약 변경이고 내 권한이 아니다.
- 적용 방식: `notify.json` 에 코드별 예외. 기본값 변경이 아니라 이 코드만.
- 관리자 확인 사항으로 `DECISIONS.md` 에 올린다 (§6).

## 6. 관리자 확인이 필요한 두 가지

`DECISIONS.md` 에 질문으로 올린다. 기본값은 위대로 구현해 두었고, 답에 따라
숫자만 바꾸면 된다.

1. **로컬 통지 임계값 예외** — `PORTAL_LINK_DOWN`(P3) 을 메일·Teams·ITSM 로
   보낼 것인가. 보내지 않으면 콘솔 화면에만 남는다.
2. **24시간 백스톱** — 설치 후 하루가 지나도 못 붙은 노드에 알람을 올릴 것인가.
   올리지 않으면 실패한 설치가 조용히 남는다.

## 7. 범위에서 뺀 것

- `CLOCK_DRIFT` 의 `postEvents()` → `emit()` 전환 (P4, 별건)
- 포털 `PROBE_OFFLINE` 쪽 동작 — Codex 범위, 건드리지 않는다
- 새 이벤트 코드·허트비트 필드 — 계약 변경이므로 `DECISIONS.md`/`INTERFACE.md` 선행
