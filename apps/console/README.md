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

nginx: `deploy/console/nginx-cflex-console.conf` (TLS 443 → app01:8080, app02:8080 backup).

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

Portal-scope endpoints get honest empty answers rather than twin's sample fallback (D-01, D-05):
- `GET /v1/fms/routes` returns no routes.
- `GET /v1/fms/control/actions` returns no actions.
- Copilot, power chain, topology, tickets and incidents return 404.

**Collector payloads** are the contract's own (00 §3.3, §3.4) and are validated with
`docs/spec/schemas`. Replays are harmless: an `event_id` or a `(device_id, ts)` that is already stored
is skipped.

**Secrets** (SNMP community and v3 keys, SMTP password, Teams webhook, ServiceNow password) are sealed
with AES-256-GCM (`CONSOLE_SECRET_KEY_FILE`). Reading them back returns `{ "set": true }`. Only the
collector's `GET /collector/v1/{devices,config}` returns them opened, because the collector needs them
to poll and to notify.

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
