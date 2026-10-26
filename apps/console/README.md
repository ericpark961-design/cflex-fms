# cflex-app — Local Console API (HAEA on-prem)

Spec 01 §2.2, WO-INT-004. The API and pages behind nginx 443 on app01/app02. The UI is the existing
`apps/twin`, built for the console with `npm run build:console` and served at `/twin/`.
Two pages twin does not have are served here: `/login` and `/settings`.

No npm dependencies. `better-sqlite3` is optional; without it the store opens with `node:sqlite`.
Redis is reached over RESP by `src/redis.js`, so no client package is needed either.

## Run

```sh
# Node 20+. Redis 6 reachable at REDIS_URL. 32-byte key file for stored secrets.
cp console.env.example /opt/app/cflex/config/console.env    # edit
node src/cli.js create-user admin admin       # password on stdin; must be changed at first login
node src/cli.js collector-key cap01           # prints the collector key once
node src/server.js                            # listens on CONSOLE_BIND:CONSOLE_PORT (0.0.0.0:8080)
```

nginx: rendered per node by `cflex-install` (`install/templates/nginx/cflex-console.conf`; bare-profile
reference copy in `deploy/console/nginx-cflex-console.conf`). TLS 443 → the local app on 127.0.0.1:8080; local
app down → the peer node's nginx on 443. Nothing between the nodes uses 8080 (firewall request v3, Q-2026-10-25-10).

## Stateless (app01 / app02)

The process keeps nothing of its own:
- **Sessions are in Redis.** The token is an HttpOnly, SameSite=Strict cookie. Redis stores only its SHA-256.
  The idle timeout is 30 min and the absolute limit is 12 h.
- **Login-failure counters are in Redis**, so 5 failures lock an account on both nodes for 15 min.
- **Data is in the database.** For now that is SQLite on a path both nodes use. It becomes PostgreSQL on
  db01 with WO-INT-008. Two VMs cannot share one SQLite file, so the production app01/app02 split
  depends on WO-INT-008.

The integration test runs two instances on one database and one Redis. It checks that a session made
on app01 is honoured by app02, and that app02 keeps serving once app01 is stopped (SAT 6).

## Roles

| | Viewer | Operator | Admin |
|---|---|---|---|
| Sites/devices, alarms, trends, status | ✓ | ✓ | ✓ |
| Alarm ACK / un-ACK / comment, maintenance windows (twin "mute") | | ✓ | ✓ |
| Sites, devices, CSV import, SNMP credentials, thresholds, channels, test ticket, users, collector keys, audit log | | | ✓ |

Role changes and disabling take effect on the next request, not the next login.

Passwords must be at least 12 characters, use 3 of the 4 character classes, and not contain the
username. They are hashed with scrypt, and users must change theirs at first login.

The audit log is append-only: SQLite triggers refuse UPDATE and DELETE on it.

SAML 2.0 can be turned on through `CONSOLE_SAML=1`, but that only reports the flag. Nothing is
implemented until the IdP date is known (spec §6-5).

## API

| Path | Role | |
|---|---|---|
| `POST /v1/auth/login` · `logout` · `password` | — / any | |
| `GET /v1/me` | any | the shape twin reads |
| `GET /v1/fms/summary` · `assets` · `assets/:id?range=1h\|24h\|7d\|30d` · `floor` · `alerts?hours&state&priority&cbu` · `alerts/:id` · `fleet-live` · `channels/health` | viewer | twin's keys, unchanged |
| `POST /v1/fms/alerts/:id/ack` · `unack` · `comments` | operator | |
| `POST /v1/fms/devices/:id/mute` · `unmute` | operator | = maintenance window |
| `GET/POST/DELETE /v1/console/maintenance` | viewer / operator | |
| `/v1/console/{sites,devices,import,credentials,thresholds,notify,notify/test-ticket,users,collectors/:node/key,audit}` | admin (reads of sites/devices/thresholds: viewer) | |
| `GET /v1/console/status` | viewer | this node, Redis, collectors, Portal link as the collectors report it |
| `POST /collector/v1/{heartbeat,telemetry,events}` · `GET /collector/v1/{devices,config}` | collector key | |
| `GET /healthz` | — | 503 when Redis is down |

**Profile** (`CONSOLE_PROFILE`, DECISIONS Q-2026-10-25-09 (B)). The default, `internal`, serves no
portal-scope API at all: alarm routing, control actions, copilot, power chain, topology, tickets and
incidents all answer 404, and the internal twin build has no screen that asks. `portal` adds back the
two honest empty answers the full twin build reads (`/v1/fms/routes`, `/v1/fms/control/actions`)
instead of falling back to its sample data. Nothing else differs.

**Collector payloads** are the contract's own (00 §3.3, §3.4) and are validated with
`docs/spec/schemas`. Replays are harmless: an `event_id` or a `(device_id, ts)` that is already stored
is skipped.

**Local notification is sent from here** (Q-2026-10-25-10 (A); firewall request v3 FW-8:
app → SMTP relay 25/587, app → proxy → Teams/ServiceNow 443). `POST /collector/v1/events` stores the
events, then notifies with the channels in Settings (`src/notify.js` → probe-agent `local-notify.js`) and
answers `{accepted, duplicate, local_notified: {event_id: {email, teams, itsm}}}`. The collector puts
that in the event it sends the Portal. Details:
- alarm_id → ServiceNow INC is in the `itsm_map` table, so a clear on app02 resolves what app01 opened.
- A replayed `event_id` gets the stored answer; nobody is told twice.
- Suppressed (nothing sent, an open INC still resolves on clear): the event's `detail.maintenance`, a
  window set here since the collector last pulled its config, and a replay (`X-CFlex-Replay: 1`, the
  collector could not reach the console) older than `CONSOLE_NOTIFY_REPLAY_MAX_S` (900).
- An event that already carries `local_notified` (a collector notifying by itself) is not notified again.

**Secrets** (SNMP community and v3 keys, SMTP password, Teams webhook, ServiceNow password) are sealed
with AES-256-GCM (`CONSOLE_SECRET_KEY_FILE`). Reading them back returns `{ "set": true }`. Only the
collector's `GET /collector/v1/devices` returns SNMP credentials opened, because the collector polls.
The notification secrets never leave the console: `GET /collector/v1/config` has no channel section.

## 포털 연동 / Managed service (설정 탭)

포털 연결은 **collector 의 것**이다. cap01 의 forwarder 가 아웃바운드로 걸고, 큐를
들고, 장치 인증서를 가진다. 이 화면은 그 설정을 저장하고 collector 가
`GET /collector/v1/config` 로 가져간다 — 계약 00 이 허용하는 유일한 방향이고,
app 이 collector 를 호출하는 일은 없다.

그래서 "연동이 안 된다"에 cap01 로 ssh 해서 `.env` 를 읽지 않아도 된다.

### 저장되는 것

`url`(https 만) · `ip_pin`(계약 §1, 비우면 검사 안 함) · `proxy` + 비밀번호(봉인) ·
`heartbeat_ms`(≥30s) · `poll_ms`(**≥10s** — spec 01 §2.1, 그 아래로는 48대 한 주기가
끝나지 않는다) · `telemetry_flush_ms` · `buffer_days`(1–30) · `enabled` ·
`legacy_forward`(구 `/v1/probe/event`, 기본 off).

기본값은 계약서 숫자다 — `https://cflex.fms.support`, `40.114.79.164`,
heartbeat 60s, 버퍼 7일 (계약 §1·§3.1, D-07).

### 장치 인증서 (계약 §6) — 개인키는 움직이지 않는다

CA 와 얘기하는 사람은 이 콘솔 앞의 admin 인데, 키는 collector 에 있어야 한다.
그래서 셋으로 나눈다:

```
collector  POST /collector/v1/enroll   { csr, pubkey_sha256 }   ← 키는 그 노드에 남는다
admin      화면에서 CSR 을 복사 → 포털 CA 서명 → 인증서를 붙여넣는다
collector  GET  /collector/v1/certs    { cert, ca }             ← 가져간다
```

인증서와 CSR 은 공개 정보다. **개인키는 이 DB·이 프로세스·이 화면에 없고**,
테스트가 그걸 강제한다.

붙여넣은 인증서는 거부 조건이 넷이다. 막으려는 실패가 조용하기 때문이다 —
다른 노드 인증서를 넣으면 collector 가 설치하고, 포털이 모든 호출을 거부하고,
화면은 정상으로 보인다:

| 거부 | code |
|---|---|
| CN 이 `<tenant>.<node-id>` 가 아님 (계약 §1) | `cn_mismatch` |
| clientAuth EKU 없음 | `no_client_auth` |
| 이미 만료 | `expired` |
| **공개키가 등록된 CSR 과 불일치** ← 이게 뒤바뀐 붙여넣기를 잡는다 | `key_mismatch` |

새 CSR 이 올라오면 들고 있던 인증서를 버린다(새 키쌍이므로 죽은 인증서다).
같은 CSR 재전송은 무효 동작이라 collector 재시작으로 인증서가 날아가지 않는다.
`인증서 내리기`는 CSR 을 남겨 두므로 키를 다시 만들지 않고 재서명할 수 있다.
만료 60일 이내면 `renew_due` 로 표시된다 (계약 §1, §6-2).

### 연동 점검

`probe-agent/src/portal/check.js` — `cflex-portal-check` CLI 와 **같은 코드**다.
둘로 구현하면 갈라지고, 그러면 화면과 CLI 가 연동 여부를 두고 서로 다른 말을 한다.

점검은 **app 노드에서** 실행되므로 app 호스트의 포털 경로를 답한다. 두 호스트는
같은 egress 규칙을 쓰므로(spec 01 §1) 그게 admin 이 원하는 답이지만, collector 의
실제 mTLS 접속 성립은 아래 "collector 보고"로 확인한다 — 응답에 그렇게 적혀 온다.

### 아직 아닌 것

**probe-agent 가 콘솔에서 config·인증서를 가져오는 쪽은 미구현이다.** 수신 API 와
저장·검증은 여기 있고, collector 가 `POST /collector/v1/enroll` ·
`GET /collector/v1/certs` · `GET /collector/v1/config` 를 호출하도록 바꾸는 작업이
남아 있다. 그때까지 cap01 은 `.env` 로 동작한다.

## No external calls

- Every response carries `Content-Security-Policy: default-src 'self'` with no external origin.
- The console twin build has no Google Fonts and no map tiles.
- `test/console.integration.test.js` scans `public/` and `apps/twin/dist-console/` for anything a
  browser would fetch off-origin, and checks that the scanner does catch the portal build.

## Test

```sh
npm test                           # integration: two app instances, a RESP server, real HTTP
(cd ../twin && npm run build:console)   # then re-run: the twin bundle scan stops being skipped
```

## Not done here

| Item | Where it goes |
|---|---|
| The collector sending to and pulling from this API | probe-agent side (`forwarder` second sink, device pull). The endpoints exist here. |
| XLSX import | CSV only for now. Exhibit 1 XLSX → "Save as CSV". |
| Portal routing result on alarms (contract §4) | Shown only once that query exists. |
