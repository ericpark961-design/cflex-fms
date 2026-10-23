# @cflex/notify

알람 발송 9채널. **DB 없음 · `process.env` 안 읽음 · 런타임 의존성 0개.**

Codex 인계용. 기존 `backend/services/alarm-notifier.js`의 디스패처를 그대로 옮기고, 다른 코드베이스에 넘길 수 있도록 결합을 끊은 것이다.

## 왜 뽑았나

연동 자체는 운영 중이었다. 다만 `alarm-notifier.js`가

- DB 테이블 3개(`fms_alarm_routes`, `fms_alarm_dispatch_log`, `fms_alarm_mutes`)를 직접 읽고
- FMS 스키마의 `alert` 행 모양을 전제하고
- 엔드포인트·키를 모듈 로드 시점에 `process.env`에서 읽는다

이 셋 중 하나만 있어도 다른 코드베이스에 줄 수 없고, 컨테이너 이미지에 넣기 어렵고, DB 없이 테스트할 수 없다.

**이 패키지는 발송만 한다. 정책은 호출자 것이다.** 테넌트, 음소거 창, 중복 이력, 발송 로그는 DB가 필요하고 매니지드 포털과 온프레가 다르므로 여기 없다.

## 설치

```sh
# 저장소 내부
const notify = require('../../packages/notify/src');

# 또는 번들에 복사 — 의존성이 0개이므로 파일만 옮기면 된다
cp -r packages/notify /opt/app/cflex/current/packages/
```

Node ≥ 20. `package.json`의 `dependencies`는 **빈 객체**이고 테스트가 그걸 강제한다.

## 쓰는 법

```js
const notify = require('@cflex/notify');

const result = await notify.send(
  {                                   // Notification — FMS alert 행이 아니다
    priority: 'P1',
    title: 'UPS on battery',
    where: 'HMA · IDF2 · Rack 1',
    deviceId: 'ups-57',
    deviceLabel: 'HMA UPS 2E-A',
    metric: 'output_source',
    value: 'onBattery',
    threshold: 'onLine',
    id: 'alarm-9001',
    dedupKey: 'ups-57/on-battery',    // PagerDuty·ServiceNow가 중복 묶는 키
    at: Date.now(),
  },
  [                                   // Route[]
    { channel: 'email', target: 'idc-noc@haeaus.com', minPriority: 'P2' },
    { channel: 'teams', target: 'https://haea.webhook.office.com/webhookb2/x' },
    { channel: 'servicenow', target: 'incident', minPriority: 'P1' },
  ],
  config,                             // 아래 §설정
  { smtpSend },                       // 주입 — 아래 §주입
);

// result = { sent, failed, results[], skipped[] }
// results[] 각 항목 = { ok, channel, target, ms, id?, number?, error?, dryRun? }
```

**절대 throw하지 않는다.** 디스패처가 던져도 잡아서 `dispatcher threw: …`로 보고한다.

### 발송 전에 확인만

```js
const { willSend, skipped } = notify.plan(notification, routes, config);
// skipped[] = [{ channel, target, why }]
//   why: 'disabled' | 'no target' | 'unknown channel "x"'
//      | 'priority P2 below P1' | 'config missing: sentinelConnect.url'
```

`config missing: …`이 중요하다. **라우트에는 있는데 그 채널이 필요한 설정이 없는 상태** — 이게 사람들이 반나절 잡아먹는 실패다. 발송 전에 말해준다.

## 채널 9종

| channel | target | 경유 | 비고 |
|---|---|---|---|
| `email` | 주소 | **SMTP 또는 Resend** | 아래 §이메일 |
| `teams` | Incoming Webhook URL **또는** `teamId/channelId` | 전자는 직접(Adaptive Card), 후자는 runless-uc(Graph) | URL 모양으로 자동 판별 |
| `slack` | Incoming Webhook URL | 직접 | `hooks.slack.com/services/` 아니면 거부 |
| `discord` | Webhook URL | 직접 | `discord.com/api/webhooks/` 아니면 거부 |
| `pagerduty` | Routing key | Events API v2 | P1→critical, P2→error, P3→warning, P4→info |
| `servicenow` | 테이블명 (기본 `incident`) | Table API | P1→impact/urgency 1, 응답의 `number`(INC번호)·`sys_id` 반환 |
| `webhook` | 임의 URL | 직접 | 고정 JSON 엔벨로프 — 아래 |
| `sms` | E.164 번호 | **Sentinel Connect** | ⚠ 오프라인 망에서 불가 |
| `line` | LINE userId | **Sentinel Connect** | ⚠ 오프라인 망에서 불가 |

### ⚠ 온프레(HAEA)에서 주의할 세 가지

1. **SMS·LINE은 Sentinel Connect(RingOn 내부 서비스) 경유다.** LINE/Twilio API 직접 호출이 아니다. 고객 폐쇄망에서는 닿지 않는다 — 스펙이 "SMS는 포털 측에서 처리"라고 한 이유다. 닿는 환경에서만 설정하면 되고, `plan()`이 못 쓰는 채널을 보고한다.
2. **이메일은 전송 2종이다.** Resend는 인터넷 API이고, HAEA는 자체 SMTP 릴레이를 요구한다(§2.3 룰 D, §3.5). `email.transport: 'smtp'`로 바꾸고 **sender를 주입**한다 — 이 패키지는 메일 의존성을 갖지 않는다.
3. **프록시.** HAEA는 Teams·포털 아웃바운드를 자체 HTTPS 프록시로 받는다. HTTP 클라이언트가 주입식이므로 프록시 agent를 그 슬롯에 넣는다. `axios`를 모듈 스코프에서 import하던 옛 코드로는 불가능했다.

### 일반 webhook 엔벨로프 (고정)

```json
{ "source": "C-Flex FMS", "priority": "P1", "title": "[P1] HMA UPS 2E-A",
  "message": "UPS on battery", "where": "HMA · IDF2 · Rack 1",
  "detail": "· metric: output_source · value: onBattery · threshold: onLine",
  "device": { "id": "ups-57", "label": "HMA UPS 2E-A" },
  "metric": "output_source", "value": "onBattery", "threshold": "onLine",
  "url": "https://fms.haeaus.internal/", "at": "2026-10-23T07:30:00.000Z",
  "id": "alarm-9001" }
```

키 집합은 테스트가 고정한다. 바꾸면 테스트가 깨진다 — 고객 연동을 조용히 깨뜨리지 않기 위해서다.

## 설정

**전부 인자로 받는다. 환경변수를 읽지 않는다.** 비밀값 출처는 호출자가 정한다 (systemd credential, 0600 파일, Vault 무엇이든).

```js
const config = {
  productName: 'C-Flex FMS',
  siteName: 'HAEA HQ Irvine',
  dashboardUrl: 'https://fms.haeaus.internal/',   // 메시지의 딥링크 — 옛 코드는 호스티드 URL 하드코딩
  fromName: 'C-Flex FMS',
  fromAddress: 'fms-noreply@haeaus.com',
  timeoutMs: 10000,

  email: {
    transport: 'smtp',                            // 'smtp' | 'resend'
    from: 'C-Flex FMS <fms-noreply@haeaus.com>',
    // transport:'resend'일 때
    resendKey: '…',
    // transport:'smtp'일 때 — 여기 또는 deps.smtpSend
    send: async ({ to, from, subject, text, html }) => ({ messageId: '…' }),
  },

  sentinelConnect: { url: 'http://sc.internal:3200', apiKey: '…', senderEmail: '…' },
  runlessUc:       { url: 'http://uc.internal:3100', apiKey: '…' },
  servicenow:      { instanceUrl: 'https://x.service-now.com', auth: 'Basic …', table: 'incident', category: 'Infrastructure' },
  webhook:         { headers: { 'X-Token': '…' } },

  proxy: 'http://proxy.haeaus.com:8080',          // 기록용 — 실제 라우팅은 agent
  ca: null,
};
```

## 주입

```js
await notify.send(n, routes, config, {
  http,       // (url, body, {headers, method, timeout}) => {ok, status, json, text, error}
  smtpSend,   // ({to, from, subject, text, html}) => {messageId}
  now,        // () => ms — 테스트에서 고정 시계
});
```

`http`를 안 주면 Node 내장 `fetch` 기반 기본 클라이언트를 쓴다. 프록시 agent·재시도·axios가 필요하면 같은 슬롯에 넣는다.

## CLI — 설치기용

스펙 §5.2가 `cflex-install verify`에서 SMTP·Teams·ServiceNow 연결 테스트와 `--send-test`를 요구한다. 그게 이것이다.

```sh
# 설정만 확인, 아무것도 발송하지 않음. 발송 가능한 라우트가 0개면 exit 1
cflex-notify check --config /opt/app/cflex/config/notify.json

# 한 채널 테스트 — 기본은 설정 확인만, --deliver로 실제 발송
cflex-notify test  --config … --channel teams --deliver

# 실제 알람 발송
cflex-notify send  --config … --priority P1 --title "On battery" --where "HMA · IDF2"

# --json 으로 기계 판독
```

출력 예:

```
routes configured: 5
  OK      email       idc-noc@haeaus.com
  OK      teams       https://haea.webhook.office.com/webhookb2/x
  OK      servicenow  incident
  SKIP    sms         config missing: sentinelConnect.url
  SKIP    slack       disabled

would send: 3 · skipped: 2
```

종료코드: `0` 정상 · `1` 발송/확인 실패 · `2` 사용법 오류 · `3` 예기치 못한 예외.

설정 파일은 `{ "config": {...}, "routes": [...] }`. 설치기가 `/opt/app/cflex/config/`에 0600으로 두면 **키가 프로세스 목록에 노출되지 않는다** (CLI 인자로 받지 않는 이유).

SMTP는 `config.email.sendmailPath`를 주면 CLI가 그 바이너리로 보낸다 (`-t -i`). 앱 안에서는 쓰던 메일 라이브러리를 `deps.smtpSend`로 주입하면 된다.

## 호출자가 직접 해야 하는 것 (여기 없음)

| 것 | 왜 여기 없나 |
|---|---|
| 라우팅 규칙 저장 | DB. `fms_alarm_routes` → `Route[]`로 읽어서 넘긴다 |
| 음소거 / 유지보수 창 | DB + 시간 정책 |
| 중복 제거 이력 | DB. `dedupKey`는 받아서 전달만 한다 |
| 발송 로그 | DB. `results[]`를 그대로 기록하면 된다 |
| 에스컬레이션 (N분 후 다음 단계) | 스케줄러 |
| 재시도 | 호출자 정책. `results[]`의 `ok:false`를 보고 결정 |
| 로컬/포털 중복 발송 방지 | 두 경로를 아는 쪽의 일 |

## 기존 운영 코드에서 옮기기

`backend/services/notify-adapter.js`가 FMS `alert` 행 + `fms_alarm_routes`를 이 패키지의 모양으로 바꿔준다. 운영 `alarm-notifier.js`는 그대로 두고, 그 어댑터를 거쳐 쓰면 동작이 같다.

## 테스트

```sh
node packages/notify/test/notify.test.js    # 14종, 네트워크 없음
```

HTTP 클라이언트가 주입식이라 모든 디스패처를 **보냈을 URL·헤더·본문을 기록하는 레코더**에 대고 돌린다. 다른 코드베이스가 신뢰해야 하는 부분이 바로 그것이기 때문이다.

마지막 테스트는 이 패키지의 약속 자체를 검사한다 — `process.env` 읽지 않음, DB import 없음, 런타임 의존성 0개. (첫 판에서 이 검사가 **주석 안의** `process.env`를 잡아서 걸렸다. 지금은 주석을 걷어내고 검사한다.)
