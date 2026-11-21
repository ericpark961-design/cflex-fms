# cflex-probe

The collector (`cap01`, `cap02` …) of RingOn C-Flex FMS on the customer site: polls the site's
devices over SNMP (read only, D-05) — and, where the ledger says so, Modbus TCP (read only,
WO-INT-017) — receives their traps, classifies alarms, and sends all of it
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

## Modbus TCP (WO-INT-017)

For devices that do not speak SNMP: CRAC controllers that offer Modbus (directly or behind an
RS-485 → TCP gateway) and contact-input I/O modules wired to a fire panel. **Read only**: the
request builder (`src/services/modbus-read.js`) sends function codes 1, 2, 3, 4 and refuses 5, 6,
15, 16, 22, 23 by name — there is no write path (D-12a). `node:net` only, no npm dependency.
A site without Modbus devices in its ledger never opens a Modbus connection.

| Device row | Collector | |
|---|---|---|
| `kind: crac`, `attrs.protocol: modbus` / `modbus-tcp`, `attrs.modbus: { unit_id, port?, profile }` | `pollers/crac-modbus.js` (via `crac.js`) | registers from a profile; same metric names as iCOM SNMP, so `cooling_available` (standby = 0) and `delta_t_c` derive the same way |
| `kind: dio`, `attrs.protocol: modbus-tcp`, `attrs.modbus: { unit_id, port?, type: coil\|discrete, address_base: 0\|1 }`, `attrs.inputs: [{ channel, metric, active_state: closed\|open, label? }]` | `pollers/dio.js` | `value` 0 normal / 1 active, `str_value`, `raw_value` = the bit read. No `active_state` → not converted, named in `notes`. Module not answering → `ok:false`, no values (never 0) |

`dio` metric names: `fire_alarm`, `fire_trouble`, `fire_supervisory`, `fire_predischarge`,
`fire_discharge`, `smoke_zone_<n>`, `leak_alarm`, `contact_<n>`; anything else makes the device
`unsupported`. Values only — no alarm codes (contract 00 appendix B has none for these; WO-INT-017 §8-1).

**Profiles** (`profiles/modbus/<name>.json`, `src/services/modbus-profiles.js`): one per model or
controller family, with `source_doc` (the vendor point list it came from), `address_base` (0 or 1,
mandatory — converted to the 0-based PDU address), and per point `type` (holding · input · coil ·
discrete), `address`, `data` (uint16 · int16 · uint32 · int32 · float32 · bit), `word_order`
(ABCD · CDAB, mandatory for 32-bit), `scale` and `unit` (mandatory), `enum`, `label`, `confidence`
(`documented` until compared with the unit's display on site, then `verified`). Write the
register number as the vendor document does within its table (not the `4xxxx` prefix). A profile
that fails validation makes the device `unsupported` with the reasons; the cycle goes on. A
profile cannot name a host: the device IP is the ledger's. **No address without a vendor
document** — the only profile shipped is `sim-crac.json`, for the simulator (Stulz: DECISIONS
Q-2026-11-20-01).

Each value keeps where it came from in the metric's `oid` slot: `modbus:<unit_id>:<table>:<pdu address>`.

**Connections.** One per `host:port` per poll cycle, shared by every unit ID behind it (a gateway),
one request at a time even with `POLL_CONCURRENCY` workers, closed at the end of the cycle.
Requests are split at 125 registers / 2000 bits. Every answer is checked (transaction id,
protocol id, unit id, length, function code, byte count) and discarded on any mismatch. Exception
02 is reported as "register map mismatch", apart from device exceptions (04 …) and communication
failures (timeout, refused, reset).

| Env | Default | |
|---|---|---|
| `MODBUS_TIMEOUT_MS` | `3000` | per request |
| `MODBUS_RETRIES` | `1` | on comms / malformed answers; not on an exception |
| `MODBUS_PORT` | `502` | when the device row gives none; a simulator's port on a test host |

Firewall: collector → device TCP 502 is **not** in HAEA's request v3. `cflex-install netcheck` has
it as site row MB-1, N/A unless `site.yaml` sets `modbus.targets_file`.

`sim/sim-modbus.js` is the simulator (unit 1 = the `sim-crac` CRAC, unit 2 = a 16-input contact
module; tables, fragmentation, delay, exception and disconnect by env — usage in its header). It
answers every write code with exception 01 and records it. `test/modbus.test.js` (127.0.0.1) and
`test/modbus.e2e.test.js` (simulator → collector cycle → console) end by checking it received none.

The Local Console has no feed for non-UPS devices yet (`forwarder.fetchObjectConfig()` returns
`[]`, Q-2026-10-26-14), so against a console these collectors — SNMP and Modbus alike — do not run
until it has one (DECISIONS Q-2026-11-20-02). The E2E supplies its two devices with a test-only
preload (`test/support/object-feed.js`).

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
