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

Tests (no network beyond 127.0.0.1, no dependencies, needs the `openssl` CLI):

```
node --test test/*.test.js
node test/support/mock-portal.js     # a strict local Portal to point a probe at
```

## Legacy endpoints (only with `CFLEX_LEGACY_FORWARD=1`)

| Direction | Endpoint | Purpose |
|---|---|---|
| Probe → cflex | POST /v1/probe/event | Telemetry + alerts |
| Probe → cflex | POST /v1/probe/heartbeat | liveness |
| Probe ← cflex | GET /v1/probe/devices, /v1/probe/objects | device ledger pull (still used until the Local Console inventory API, WO-INT-004) |
