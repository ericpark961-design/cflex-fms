# cflex-app — Local Console API (HAEA on-prem)

Spec 01 §2.2, WO-INT-004. The API and pages behind nginx 443 on app01/app02. The UI is the existing
`apps/twin`, built for the console with `npm run build:console` and served at `/twin/`.
Two pages twin does not have are served here: `/login` and `/settings`.

The store is PostgreSQL 16 on db01 (WO-INT-008), through `pg` (pure JS). `better-sqlite3` remains only for
`bin/cflex-migrate-sqlite.js`, which reads the pre-008 SQLite file once during the upgrade; there is no
`node:sqlite` fallback (Node 20 does not have it, WO-INT-007). The tests run a real PostgreSQL 16 from the
devDependency `embedded-postgres` (`npm install --include=dev`); without it the database tests report as skipped.
Redis is reached over RESP by `src/redis.js`, so no client package is needed.

## Run

```sh
# Node 20+. PostgreSQL 16 (CFLEX_DB_*), Redis 6 at REDIS_URL, 32-byte key file for stored secrets.
# The schema is applied at start (migrations/, schema_migrations; one advisory lock for both nodes).
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
- **Data is in PostgreSQL on db01**, one database for both nodes. `telemetry`, `alarm_events` and
  `audit_log` are partitioned by month (`src/partitions.js`): made 3 months ahead, dropped past retention
  (raw 3 y, events/audit 10 y), by whichever node holds the advisory lock. Backups: `docs/install/PG_BACKUP_RESTORE.md`.

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

The audit log is append-only: a trigger refuses UPDATE and DELETE on it (the one exception is
moving rows out of the default partition into a new month partition, in one transaction).

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
| `GET /v1/console/status` | viewer | this node, Redis, collectors, the Portal link as each app node last saw it |
| `POST /collector/v1/{heartbeat,telemetry,events}` · `GET /collector/v1/{devices?sites=…,config}` | collector key | `sites`: the collector's scope (D-13) |
| `GET /healthz` | — | 503 when Redis is down |

**Profile** (`CONSOLE_PROFILE`, DECISIONS Q-2026-10-25-09 (B)). The default, `internal`, serves no
portal-scope API at all: alarm routing, control actions, copilot, power chain, topology, tickets and
incidents all answer 404, and the internal twin build has no screen that asks. `portal` adds back the
two honest empty answers the full twin build reads (`/v1/fms/routes`, `/v1/fms/control/actions`)
instead of falling back to its sample data. Nothing else differs.

**Collector payloads** are the contract's own (00 §3.3, §3.4) and are validated with
`docs/spec/schemas`. Replays are harmless: an `event_id` or a `(device_id, ts)` that is already stored
is skipped.

**Several collectors** (D-13, WO-INT-012). Each posts with its own key and node id (`cap01`, `cap02` …),
which is kept as `collector_id`. A device is one row (`device_id`) whoever polls it; the row shows the
latest reading. An alarm is one row too: when a second collector raises the same code on a device that
another collector already has open, its `alarm_id` is mapped onto the open one (`alarm_sources`), its
events go into that alarm's history, and the alarm clears when the last collector clears it. A
collector's own alarms are never merged with each other (its engine already keeps one per fault).

## The Portal link (D-13, WO-INT-012)

The Portal sender — contract 00 **v1.2** to `cflex.fms.support` (FW-4: app → Portal 443, mTLS, through
HAEA's proxy) — is here, not on the collectors (`src/portal.js`, the rules the collector's forwarder had):

| | |
|---|---|
| `POST /api/v1/heartbeat` | every 60 s from **each** app node (`role: app`), and from the sender one per collector heard from in the last 5 min (`role: collector`, `collector_id`) |
| `PUT /api/v1/inventory` | the `devices` table, on change and in full daily; a device whose ID changed is sent once more with `replaced_by` |
| `POST /api/v1/telemetry` | what each collector posted (known devices only), each point with `collector_id` |
| `POST /api/v1/events` | the merged events (FMS `alarm_id`), with `collector_id` and what this console delivered (`local_notified`) |

`node_id` is the app node (`X-CFlex-Node`, certificate CN `<tenant>.app01`). Everything but the heartbeat
goes through `portal_outbox` (db01) in order, with its `Idempotency-Key` fixed at enqueue — the 7-day
buffer of contract §1 (`CFLEX_PORTAL_BUFFER_DAYS`). Both nodes enqueue; **the node holding the sender
lock** (a PostgreSQL session advisory lock on a connection of its own) drains it, syncs the inventory and
relays the collectors; when it stops, the other takes over on its next tick. 5xx/network → backoff
1 s … 5 min ±20 %, 429 → `Retry-After`, 409 → retried, other 4xx → dropped and counted. A Portal `Date`
more than 60 s off raises `CLOCK_DRIFT` (node event, no `collector_id`). Events wait up to 30 s in the
outbox for the notifier's answer, then go without `local_notified`.

| Env | Default | |
|---|---|---|
| `CFLEX_PORTAL_ENABLED` | `1` when `CFLEX_PORTAL_URL` is set | `0` = no Portal link |
| `CFLEX_PORTAL_URL` | `https://cflex.fms.support` | |
| `CFLEX_NODE_ID` | `CONSOLE_NODE_ID` | contract node id (`app01`) |
| `CFLEX_TLS_CERT`, `CFLEX_TLS_KEY` | — | device certificate and key **paths**; key 0600, never logged |
| `CFLEX_TLS_CA`, `CFLEX_PROXY_CA` | system store | Portal CA; CA of a TLS-inspecting proxy |
| `HTTPS_PROXY`, `NO_PROXY` | — | Basic auth (NTLM: not yet, Q-2026-10-25-04) |
| `CFLEX_PORTAL_BUFFER_DAYS` | `7` | outbox purge |
| `CFLEX_PORTAL_HEARTBEAT_MS` · `_FLUSH_MS` · `_INVENTORY_MS` | `60000` · `5000` · `300000` | |

**Local notification is sent from here** (Q-2026-10-25-10 (A); firewall request v3 FW-8:
app → SMTP relay 25/587, app → proxy → Teams/ServiceNow 443). `POST /collector/v1/events` stores the
events, then notifies with the channels in Settings (`src/notify.js` → probe-agent `local-notify.js`) and
answers `{accepted, duplicate, local_notified: {event_id: {email, teams, itsm}}}`. The same goes into
the event this console sends the Portal. Off by default (D-12a). Details:
- alarm_id → ServiceNow INC is in the `itsm_map` table, so a clear on app02 resolves what app01 opened.
- A replayed `event_id` gets the stored answer; nobody is told twice.
- Suppressed (nothing sent, an open INC still resolves on clear): the event's `detail.maintenance`, a
  window set here since the collector last pulled its config, and a replay (`X-CFlex-Replay: 1`, the
  collector could not reach the console) older than `CONSOLE_NOTIFY_REPLAY_MAX_S` (900).
- An event that already carries `local_notified` is not notified again.

**Secrets** (SNMP community and v3 keys, SMTP password, Teams webhook, ServiceNow password) are sealed
with AES-256-GCM (`CONSOLE_SECRET_KEY_FILE`). Reading them back returns `{ "set": true }`. Only the
collector's `GET /collector/v1/devices` returns SNMP credentials opened, because the collector polls.
The notification secrets never leave the console: `GET /collector/v1/config` has no channel section.

## No external calls

- Every response carries `Content-Security-Policy: default-src 'self'` with no external origin.
- The console twin build has no Google Fonts and no map tiles.
- `test/console.integration.test.js` scans `public/` and `apps/twin/dist-console/` for anything a
  browser would fetch off-origin, and checks that the scanner does catch the portal build.

## Test

```sh
npm install --include=dev          # pg, better-sqlite3, embedded-postgres (PostgreSQL 16 for the tests)
npm test                           # integration: two app instances on one PostgreSQL, a RESP server, real HTTP;
                                   # migrations/partitions/retention (db.test.js); SQLite → PG (migrate-sqlite.test.js)
(cd ../twin && npm run build:console)   # then re-run: the twin bundle scan stops being skipped
```

## Not done here

| Item | Where it goes |
|---|---|
| XLSX import | CSV only for now. Exhibit 1 XLSX → "Save as CSV". |
| Portal routing result on alarms (contract §4) | Shown only once that query exists. |
