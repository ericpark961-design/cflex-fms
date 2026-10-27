# cflex-probe

The collector (`cap01`, `cap02` …) of RingOn C-Flex FMS on the customer site: polls the site's
devices over SNMP (read only, D-05), receives their traps, classifies alarms, and sends all of it
to the **FMS** (the Local Console, `apps/console`) — and nowhere else.

## Architecture (D-13, WO-INT-012)

```
[HAEA network]                                                         [Internet]
  NMC ◀─ SNMP 161 / trap 162 ─ cap01 (sites A,B) ─┐
  NMC ◀─ SNMP 161 / trap 162 ─ cap02 (site C)  ───┼─ 443 (FW-7) ─▶ app01/app02 (FMS) ─ 443 (FW-4, mTLS, proxy) ─▶ cflex.fms.support
                                                  ┘                 merge by device_id,
                                                                    one alarm_id, 7-day outbox
```

A collector has **no external path**: no Portal URL, no device certificate, no proxy, no
old-cloud path. The Portal sender (contract 00 v1.2) is the FMS's — `apps/console/src/portal.js`,
see `apps/console/README.md`. Its node id becomes `collector_id` at the Portal.

## Quick start

```
npm install
CFLEX_CONSOLE_URL=https://<app01>,https://<app02> CFLEX_CONSOLE_KEY_FILE=… CFLEX_CONSOLE_CA=… \
  TENANT_ID=HAEA CFLEX_NODE_ID=cap01 node src/index.js
```

On HAEA it is installed by `install/cflex-install` (Podman Quadlet or bare systemd), which renders
`collector.env` from `site.yaml`.

## The FMS link (WO-INT-004c, WO-INT-012)

The collector's inventory comes from the Local Console, and its telemetry, alarm events and
heartbeat go there (spec 01 §2.1; v3 FW-7, cap → app 443 via nginx). `src/console/client.js`:

| | |
|---|---|
| `GET /collector/v1/config`, `/devices?sites=…` | at boot and every `CONFIG_RELOAD_MS` (5 min): the UPSs **of this collector's sites** with their SNMP credentials, thresholds (console-wide, then per device), maintenance windows → alarm engine. Unreachable: the last list is kept |
| `POST /collector/v1/telemetry` | contract §3.3 points, batched every `TELEMETRY_FLUSH_MS` or at 500 |
| `POST /collector/v1/events` | alarm events (the console merges collectors, notifies, sends on to the Portal) |
| `POST /collector/v1/heartbeat` | contract §3.1 fields; the FMS relays it to the Portal as this collector's |

While the console cannot be reached, everything waits in order in the buffer file (`q_console`)
with its own backoff, and is re-sent (events marked `X-CFlex-Replay: 1`). No proxy, no client
certificate — the trust anchor is the CA of the console's nginx certificate.

| Env | Default | |
|---|---|---|
| `CFLEX_CONSOLE_URL` | — | `https://<app01>,https://<app02>` (nginx 443), active first; the next one when one cannot be reached. Required: without it the collector has nowhere to send |
| `CFLEX_CONSOLE_KEY_FILE` | — | collector key **path** (`node src/cli.js collector-key cap01` on the console), 0600 |
| `CFLEX_CONSOLE_CA` | system store | CA of the console's nginx certificate |
| `TENANT_ID` / `CFLEX_NODE_ID` / `CFLEX_SITE_ID` | `HAEA` / `cap01` / `HAEA-HQ` | node id = the console key's node; site is the fallback for a device row without a valid site code |
| `CFLEX_COLLECTOR_SITES` | — (every site) | site scope, comma-separated (`HMA-FV,KUS-IRV`). The installer sets it from `site.yaml` `hosts.collectors[].sites` when there is more than one collector |
| `CONFIG_RELOAD_MS` | `300000` | |
| `HEARTBEAT_INTERVAL_MS`, `TELEMETRY_FLUSH_MS` | `60000` | |
| `BUFFER_DB_PATH`, `BUFFER_RETENTION_DAYS` | `./data/buffer.db`, `7` | the collector → FMS store-and-forward |
| `SNMP_PORT` | `161` | a simulator's port on a test host only |

Several collectors may see the same device (overlapping scopes): the FMS keeps one device row
(`device_id`) and one alarm (`alarm_id`), cleared when the last collector clears it.

`sim/sim-ups.js` is an APC Smart-UPS SNMP simulator (stdin `battery` / `online`).
`test/console.e2e.test.js` runs it, the console and one collector as three processes;
`test/distributed.e2e.test.js` runs two collectors and the console (merge, one `alarm_id`, no
external path on a collector, checked by grep); `test/smoke.test.js` (`npm run smoke`) boots
`src/index.js` alone against a console stub: poll cycles, the console refusing pushes so everything
lands in the buffer, the HEALTHCHECK script, exit 0 on SIGTERM.

Tests (no network beyond 127.0.0.1, needs the `openssl` CLI and `npm install` here —
better-sqlite3 is the only SQLite driver, in the tests too; the E2E tests also need
`npm install --include=dev` in `apps/console`). Node 20, the version the images and the bare
profile run, and Node 22 both pass:

```
node --test test/*.test.js
npm run smoke
node test/support/mock-portal.js     # a strict local Portal to point the FMS (apps/console) at
```

## Alarms and local notification (WO-INT-003)

`src/alarms/engine.js` classifies before anything is sent:

| Rule | Behaviour | Tunable (env) |
|---|---|---|
| Classification | severity = the appendix-B code's (`src/alarms/codes.js`), never the poller's own P-level | — |
| De-duplication | one alarm per (device, code); repeats become `alarm_update` at most every 15 min | `ALARM_UPDATE_EVERY_MS` |
| Flapping | 3 raises within 15 min → `detail.flapping=true`, held open until 15 min quiet | `ALARM_FLAP_RAISES`, `ALARM_FLAP_WINDOW_MS`, `ALARM_FLAP_QUIET_MS` |
| Maintenance | events still go on (FMS, Portal) with `detail.maintenance=true`; nothing sent locally; still active when the window ends → notified then | windows set on the Local Console (pulled with the config) |
| Comm loss | `UPS_COMM_LOST` only after 30 min without an answer (appendix B), cleared by the first good poll | — |

**Who notifies: the Local Console** (DECISIONS Q-2026-10-25-10 (A), firewall
request v3 FW-8 is app → SMTP/proxy; a collector has no such route), and only
when its channels are switched on (D-12a: off by default). The collector posts
each alarm event to the console; the console runs `src/alarms/local-notify.js`
with the channels set in its Settings and puts what was **delivered**
(`local_notified`) in the event it sends the Portal, so the Portal (WO-PTL-003)
can send what HAEA did not get. An event replayed after the console was
unreachable for more than 15 min is recorded but pages nobody
(`CONSOLE_NOTIFY_REPLAY_MAX_S` on the console).

The rules, wherever they run:

| Event | E-mail (SMTP relay) | Teams | ServiceNow |
|---|---|---|---|
| `alarm_raise` | ≥ `email_min` | ≥ `teams_min` | ≥ `itsm_min`: incident opened, alarm_id → INC stored |
| `alarm_update` | — | — | work note on the stored INC |
| `alarm_clear` | if `notify_clear` | if `notify_clear` | INC resolved (also during maintenance) |

A collector does not notify by itself any more (D-13: no external path); the
old `CFLEX_COLLECTOR_NOTIFY` / `CFLEX_NOTIFY_CONFIG` settings are gone.

**ServiceNow test ticket** (SOW acceptance D1): opens an INC, adds a work note,
resolves it, prints the number. The Local Console's Settings button runs the
same `testTicket()` with the console's channels; the CLI below is a stand-alone
tool for a notify.json (it is not part of the collector process).

```
node bin/cflex-test-ticket.js --config /opt/app/cflex/config/notify.json [--keep-open] [--json]
# OK  ServiceNow test ticket INC0010001 created, updated and resolved     (exit 0; 1 failed; 2 usage)
```

**NMC onboarding** (WO-INT-014, spec 04): `bin/cflex-onboard.js` reads card
settings and puts in the SNMPv3 user, access control and trap receiver (fixed
write scope, backup → apply → verify → rollback). An operator-run CLI, not part
of the collector process (D-12a) — `docs/onboard/README.md`.

Devices without a serial (Q-2026-10-25-05) are inventoried by the FMS with
`provisional: true, id_basis: "ledger"`; once the serial is known the old ID is
sent once more with `replaced_by` the new one.

## SNMP traps (WO-INT-006)

`src/trap/` receives SNMP traps (v1, v2c, v3 up to authPriv; informs are
acknowledged) and puts them into **the same alarm engine** as the polls. A trap
and a poll that see the same fault share the (device, code) key, so they are one
alarm with one `alarm_id`, and de-duplication, flapping and maintenance windows
apply unchanged. Events carry `source: "trap"` and go out the same way
(to the Local Console, which sends them on). Receive only: nothing is ever written to a device (D-05).

| Env | Default | |
|---|---|---|
| `CFLEX_TRAP_PORT` | `1162` | UDP port inside the process. Container: the host maps 162 → 1162 (firewalld forward or sysctl, `docs/install/CONTAINER_PROFILE.md` §2). Bare: `162`, the unit has `CAP_NET_BIND_SERVICE`. The code never asks for privileges |
| `CFLEX_TRAP_BIND` | `0.0.0.0` | |
| `CFLEX_TRAP_ENABLED` | on | `0` = no listener |

**Who sent it.** The source address is looked up in the Local Console's inventory
(the rows the pollers use). The trap must carry *that device's* credential — its
community, or its v3 user — not just one the node knows. **No credentials are
configured for traps**: they are the console's per-device SNMP credentials. For
v3, set the NMC's trap receiver to the same user, auth (SHA…) and priv (AES…)
keys as the console holds for it; the NMC is the authoritative engine for its
traps, so no engine ID needs configuring here. A v3 user name with different keys
on two devices is checked with the first one's (logged). A v3 device sending v2c
is accepted only if the console holds a community for it.

**What it means.** `src/trap/apc-mib.js` maps APC PowerNet-MIB traps to appendix-B
codes and nothing else:

| Trap (specific) | Code | |
|---|---|---|
| upsOnBattery (5) / powerRestored (9) | `UPS_ON_BATTERY` | raise / clear |
| lowBattery (7) / returnFromLowBattery (11) | `UPS_LOW_BATTERY` | raise / clear |
| upsOverload (2) / upsOverloadCleared (33) | `UPS_OVERLOAD` | raise / clear |
| communicationLost (1) / communicationEstablished (8) | `UPS_COMM_LOST` | raised only if not re-established within 30 min (appendix B) / clear |
| upsBatteryNeedsReplacement (17) / upsBatteryReplaced (36) | `UPS_BATTERY_REPLACE` | raise / clear |
| upsDiagnosticsFailed (3) / upsDiagnosticsPassed (10) | `UPS_SELFTEST_FAIL` | raise / clear |
| upsTurnedOff (12) / upsTurnedOn (30) | `UPS_OUTPUT_OFF` | raise / clear |
| hardwareFailure/software/switchedBypass (20–22) / returnFromBypass (23) | `UPS_ON_BYPASS` | raise / clear |

For codes the UPS poller also sees, the poll still judges "still there", as for
any poll alarm; trap-only ones (`UPS_SELFTEST_FAIL`, `UPS_COMM_LOST`) stay open
until their clear trap. Appendix B has no environment, NetBotz or Rack PDU codes,
so those traps are not mapped (DECISIONS Q-2026-10-26-05).

**Unknown and rejected.** A trap from an address not in the inventory, or with an
OID not in the table, is `SNMP_TRAP_UNKNOWN`: not an appendix-B code, so never
an event — counted, logged, and kept in a list of the last 200
(`handler.stats()`, `handler.recent()`; DECISIONS Q-2026-10-26-04). A wrong community,
an unknown v3 user, a bad digest or an undecodable packet is dropped and counted
(`discarded.auth` / `discarded.malformed`); another device's credential,
`discarded.wrong_device_credential`.

**Testing.** `node --test test/trap.test.js` (127.0.0.1 only). By hand, against a
running probe:

```
TRAP_HOST=127.0.0.1 TRAP_PORT=1162 SNMP_COMMUNITY=<device community> node sim/sim-trap.js
SNMP_V3_USER=<user> SNMP_V3_AUTH_KEY=<…> SNMP_V3_PRIV_KEY=<…> node sim/sim-trap.js upsOverload v3
```

The scenario sends 15 traps — 13 APC kinds plus two with no code — over v1, v2c and v3.
In forward mode, send from another host: firewalld does not forward the host's
own traffic to 162.
