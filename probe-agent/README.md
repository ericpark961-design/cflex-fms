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
- HTTPS Bearer-auth forward to cflex
- Long-poll for inbound commands (no inbound port needed)
- systemd service + log rotation

## Endpoints

| Direction | Endpoint | Purpose |
|---|---|---|
| Probe → cflex | POST /v1/probe/event | Telemetry + alerts |
| Probe → cflex | POST /v1/probe/heartbeat | 30s liveness |
| Probe ← cflex | GET /v1/probe/poll-cmd | Long-poll for commands |
| Probe → cflex | POST /v1/probe/cmd-result | Command execution result |
