# cflex-probe

Customer-site probe agent for RingOn C-Flex FMS. Runs on customer VM (e.g. HAEA VM1), polls local devices over SNMP/Modbus/REST, forwards normalized events to cflex central (cflex.runless.co.uk) over outbound HTTPS only.

## Architecture

```
[Customer LAN]                  [Internet]                   [RingOn cflex]
  ┌──── VM1 ────┐                                                 │
  │ cflex-probe │ ────── HTTPS 443 outbound only ───────────► /v1/probe/*
  │             │                                                 │
  │ pollers ──► │                                                 │
  │ buffer ◄──► │                                                 │
  └─────────────┘                                                 │
        ▲                                                         │
        │ SNMP 161, Modbus 502, etc.                              │
        ▼                                                         │
  [UPS, Network, SBC, etc.]
```

## Quick start

```
cp .env.example .env       # edit CFLEX_URL, CFLEX_TOKEN, TENANT_ID
npm install
node src/index.js          # foreground

# Production install (Ubuntu 22.04):
sudo bash install.sh
sudo systemctl status cflex-probe
```

## Features (Phase 1 MVP)

- SNMP v2c/v3 UPS polling (UPS-MIB / RFC 1628)
- 60-second poll interval
- Local sqlite buffer (7-day retention if cflex unreachable)
- mTLS forward to the Portal per contract v1.0 (below); the old Bearer path only behind a flag
- Command queue (§3.6) — not yet; heartbeat records `commands_pending`
- systemd service + log rotation

## Portal forwarder (contract IFC-CFLEX-2026-1023 v1.0)

The forwarder speaks `docs/spec/00_INTERFACE_CONTRACT_Probe-Portal_v1.md`.
Every body is pruned to the schema whitelist (§5) and validated against
`docs/spec/schemas/*.json` before it is queued; a payload that fails is logged
and not sent.

| Endpoint | When |
|---|---|
| `POST /api/v1/heartbeat` | every 60 s, direct (not queued) |
| `PUT /api/v1/inventory` | on ledger change, and in full once a day |
| `POST /api/v1/telemetry` | batched every 60 s or at 500 points |
| `POST /api/v1/events` | immediately |

Every request carries `X-CFlex-Tenant`, `X-CFlex-Node` and an `Idempotency-Key`
(UUIDv4) fixed when the item is queued, so a retry is the same request.
5xx/network → exponential backoff 1 s … 5 min ±20 %, queue held in order;
429 → `Retry-After`; 409 → retried; other 4xx → dropped and counted.

| Env | Default | |
|---|---|---|
| `CFLEX_PORTAL_ENABLED` | `1` | `0` turns the contract path off |
| `CFLEX_PORTAL_URL` | `https://cflex.fms.support` | |
| `TENANT_ID` / `CFLEX_NODE_ID` / `CFLEX_SITE_ID` | `HAEA` / `cap01` / `HAEA-HQ` | site is the fallback for ledger rows without a valid site code |
| `CFLEX_TLS_CERT`, `CFLEX_TLS_KEY` | — | device certificate and key **paths** (mTLS); key file 0600, never logged |
| `CFLEX_TLS_CA` | system store | Portal CA, added to the system store |
| `HTTPS_PROXY`, `NO_PROXY` | — | `http://user:pass@proxy:port`; Basic auth (NTLM: not yet) |
| `CFLEX_PROXY_CA` | — | CA of a TLS-inspecting proxy, added to trust |
| `HEARTBEAT_INTERVAL_MS`, `TELEMETRY_FLUSH_MS` | `60000` | |
| `CFLEX_LEGACY_FORWARD` | off | `1` keeps sending to the old `/v1/probe/event` + `/v1/probe/heartbeat` (`CFLEX_URL`, `CFLEX_TOKEN`) |

## Local Console link (WO-INT-004c)

The Collector's inventory comes from the Local Console, and its telemetry and
alarm events go there as well as to the Portal (spec 01 §2.1; v3 FW-7, cap01 →
app 443 via nginx). `src/console/client.js`:

| | |
|---|---|
| `GET /collector/v1/config`, `/devices` | at boot and every `CONFIG_RELOAD_MS` (5 min): UPSs with their SNMP credentials, thresholds (console-wide, then per device), maintenance windows → alarm engine. Unreachable: the last list is kept |
| `POST /collector/v1/telemetry` | the same contract points as the Portal's, batched on the same timer |
| `POST /collector/v1/events` | alarm events; answered with `local_notified` (above) |
| `POST /collector/v1/heartbeat` | with the Portal link state, shown on the console's status page |

Its own queue (`q_console` in the buffer file) and backoff: a console outage
never holds up the Portal, nor the reverse. No proxy, no client certificate.

| Env | Default | |
|---|---|---|
| `CFLEX_CONSOLE_URL` | — | `https://<console>` (nginx 443). Unset = old-cloud ledger pull, no console |
| `CFLEX_CONSOLE_KEY_FILE` | — | collector key **path** (`node src/cli.js collector-key cap01` on the console), 0600 |
| `CFLEX_CONSOLE_CA` | system store | CA of the console's nginx certificate |
| `CONFIG_RELOAD_MS` | `300000` | |
| `SNMP_PORT` | `161` | a simulator's port on a test host only |

`sim/sim-ups.js` is an APC Smart-UPS SNMP simulator (stdin `battery` / `online`);
`test/console.e2e.test.js` runs it, the console and the collector as three
processes. `test/smoke.test.js` (`npm run smoke`) boots `src/index.js` alone
against it: poll cycles, the Portal unreachable so everything lands in the
buffer, the HEALTHCHECK script, exit 0 on SIGTERM.

Tests (no network beyond 127.0.0.1, needs the `openssl` CLI and `npm install`
here — better-sqlite3 is the only SQLite driver, in the tests too; the console
E2E also needs `npm install` in `apps/console`). Node 20, the version the
images and the bare profile run, and Node 22 both pass:

```
node --test test/*.test.js
npm run smoke
node test/support/mock-portal.js     # a strict local Portal to point a probe at
```

## Alarms and local notification (WO-INT-003)

`src/alarms/engine.js` classifies before anything is sent:

| Rule | Behaviour | Tunable (env) |
|---|---|---|
| Classification | severity = the appendix-B code's (`src/alarms/codes.js`), never the poller's own P-level | — |
| De-duplication | one alarm per (device, code); repeats become `alarm_update` at most every 15 min | `ALARM_UPDATE_EVERY_MS` |
| Flapping | 3 raises within 15 min → `detail.flapping=true`, held open until 15 min quiet | `ALARM_FLAP_RAISES`, `ALARM_FLAP_WINDOW_MS`, `ALARM_FLAP_QUIET_MS` |
| Maintenance | events still go to the Portal with `detail.maintenance=true`; nothing sent locally; still active when the window ends → notified then | windows set on the Local Console (pulled with the config) |
| Comm loss | `UPS_COMM_LOST` only after 30 min without an answer (appendix B), cleared by the first good poll | — |

**Who notifies: the Local Console** (DECISIONS Q-2026-10-25-10 (A), firewall
request v3 FW-8 is app → SMTP/proxy; cap01 has no such route). The Collector
posts each alarm event to the console; the console runs
`src/alarms/local-notify.js` with the channels set in its Settings and answers
`event_id → local_notified`, which the Collector puts in the event before it
goes to the Portal. `local_notified` is what was **delivered**, so the Portal
(WO-PTL-003) can send what HAEA did not get. An event the console could not be
reached for goes to the Portal without the field and to the console later,
marked as a replay (`X-CFlex-Replay: 1`); one older than 15 min by then is
recorded but pages nobody (`CONSOLE_NOTIFY_REPLAY_MAX_S` on the console).

The rules, wherever they run:

| Event | E-mail (SMTP relay) | Teams | ServiceNow |
|---|---|---|---|
| `alarm_raise` | ≥ `email_min` | ≥ `teams_min` | ≥ `itsm_min`: incident opened, alarm_id → INC stored |
| `alarm_update` | — | — | work note on the stored INC |
| `alarm_clear` | if `notify_clear` | if `notify_clear` | INC resolved (also during maintenance) |

The Collector notifying by itself is kept only for a site without a console:
`CFLEX_COLLECTOR_NOTIFY=1` plus `CFLEX_NOTIFY_CONFIG=…/notify.json` (0600, see
`notify.example.json`; secrets in `passFile`s). `CFLEX_NOTIFY_CONFIG` alone is
ignored with a warning. Events it notified carry their own `local_notified`,
and the console then sends nothing for them.

| Env | Default | |
|---|---|---|
| `CFLEX_COLLECTOR_NOTIFY` | off | `1` = the Collector notifies (no-console sites only) |
| `CFLEX_NOTIFY_CONFIG` | — | notify.json path, with the above |
| `CFLEX_ITSM_STORE` | `./data/itsm-map.json` | alarm_id ↔ INC (0600, atomic replace) — Collector-notify mode; the console keeps its own in `itsm_map` |
| `CFLEX_ID_STORE` | `./data/device-ids.json` | ledger id → last device_id, for `replaced_by` |

**ServiceNow test ticket** (SOW acceptance D1): opens an INC, adds a work note,
resolves it, prints the number. The Local Console's Settings button runs the
same `testTicket()` with the console's channels; the CLI below is for a
notify.json.

```
node bin/cflex-test-ticket.js --config /opt/app/cflex/config/notify.json [--keep-open] [--json]
# OK  ServiceNow test ticket INC0010001 created, updated and resolved     (exit 0; 1 failed; 2 usage)
```

Devices without a serial (Q-2026-10-25-05) are inventoried with
`provisional: true, id_basis: "ledger"`; once the serial is known the old ID is
sent once more with `replaced_by` the new one.

## Legacy endpoints (only with `CFLEX_LEGACY_FORWARD=1`)

| Direction | Endpoint | Purpose |
|---|---|---|
| Probe → cflex | POST /v1/probe/event | Telemetry + alerts |
| Probe → cflex | POST /v1/probe/heartbeat | liveness |
| Probe ← cflex | GET /v1/probe/devices, /v1/probe/objects | device ledger pull — only when `CFLEX_CONSOLE_URL` is not set |
