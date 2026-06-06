# C-Flex FMS

Facility Monitoring System for the HAEA umbrella (HMA / KUS / HAEA HQ — 44 APC UPS).
Drop-in extension of the `cflex-v2` central API + frontend. Runs on
`cflex.runless.co.uk` today; designed to be repackaged on-prem (VMware OVA)
for closed-network customers.

## What's in here

```
backend/
  routes/
    fms.routes.js         — /v1/fms/* (50+ endpoints)
    probe.routes.js       — /v1/probe/* (P1 auto-RCA hook)
  services/
    alarm-notifier.js     — fan out alarms to LINE / SMS / Teams / Email
    fms-pdf-gen.js        — monthly PDF report (3 pages, Carbon styling, KO font)
    fms-report-mailer.js  — Resend integration
    fms-report-scheduler.js — monthly cron (1st @ 09:00 UTC)
    fms-rca.js            — Claude Haiku 4.5 root-cause analysis
    fms-derive-status.js  — SNMP reading → ok|warn|critical|unreachable
    fms-device-control.js — 3-way control adapter (SNMP / NMC HTTP / EcoStruxure)
  migrations/
    001_fms_schema.sql    — full schema delta (idempotent)

frontend/
  src/pages/Fms.jsx       — entire /fms workspace (2,800+ lines, IBM Carbon)
  public/
    assets/ups/*.svg      — 6 photorealistic APC UPS icons (traced)
    us-states-10m.json    — kept for SVG fallback (history)
    us-counties-10m.json  — same
                            (Live map uses MapLibre + Carto positron tiles.)

reference/
  HMA_KUS_HAEA_UPS_List_Updated.xlsx — 44-device inventory source of truth
  sample-readings.json  — synthetic SNMP poll for the whole fleet
  icons-spec.md         — APC icon family / theming hooks
  CLAUDE.md             — brief for future automated work

docs/
  ARCHITECTURE.md       — request flow + module map
```

## Architecture (one-liner)

```
HAEA VM1 (cflex-probe, outbound-only)
   └── SNMP v2c/v3 → 44 UPS  ⇉  /v1/probe/event (X-Probe-Key auth)
                                 │
                                 ├── derive-status → ups_devices.status
                                 ├── dedup (10-min window) → alerts
                                 ├── auto-ticket on P1 → tickets
                                 │    └── fire-and-forget fms-rca → Claude Haiku
                                 └── alarm-notifier → SMS / Teams / LINE / Email
```

## /v1/fms/* endpoint catalogue

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/summary`                          | KPI dashboard data + cbu_list |
| GET  | `/floor`                            | Location → Room → Rack → Device tree |
| GET  | `/sites-map`                        | CBU-grouped pins + addresses |
| GET  | `/assets`                           | Full inventory (cbu filterable) |
| GET  | `/assets/:id`                       | Single device + 24h/7d/30d metrics |
| PUT  | `/assets/:id`                       | Update IP/SNMP/location/criticality |
| POST | `/assets/bulk-import`               | CSV upsert (label, ip, ...) |
| GET/PUT | `/assets/:id/thresholds`         | Per-device threshold overrides |
| GET  | `/alerts?hours=N`                   | Recent alarms + recurring flag |
| GET  | `/alerts/:id/ticket`                | Linked ticket lookup |
| POST | `/devices/:id/mute` / `/unmute`     | Silence alarms for N hours |
| POST | `/tickets/from-alert`               | Create ticket from alarm (+ P1 auto-RCA) |
| GET  | `/tickets/:id`                      | Ticket + RCA |
| POST | `/tickets/:id/rca`                  | Regenerate RCA on demand |
| GET  | `/tickets`                          | Ticket list |
| GET  | `/reports/monthly?year=&month=`     | Summary numbers for the month |
| GET  | `/reports/monthly/pdf?year=&month=` | Download styled PDF |
| POST | `/reports/monthly/send`             | Email PDF to recipients |
| GET  | `/reports/monthly/history`          | Send history |
| GET  | `/fleet-live?minutes=N`             | 1-min buckets for live trend |
| GET  | `/control/actions`                  | Catalog of control actions (incl. allowed) |
| POST | `/devices/:id/action`               | Execute action (channel auto-picked) |
| GET  | `/control/log`                      | Audit log |
| GET/PUT | `/control/config`                | Master switch + EcoStruxure creds |

## Front-end stack

- React 18 + Vite (lives inside cflex-frontend SPA).
- **MapLibre GL** + Carto positron tiles (free, attribution baked in).
- IBM Plex Sans, Carbon color tokens.
- KO+EN bilingual via `tx(ko, en)` helper, localStorage `lang`.
- All clicks go through a global modal context — never a route swap.
- Toast system for new alarms (animated slide-in, 7s auto-dismiss).

## Device control (read/write to APC fleet)

The `/control/*` system is fully built but **disabled by default**. Calls
hit the audit log only (`dry_run=1`). To go live:

1. **Schneider Electric Partner Manager** → request OAuth2 credentials for
   *EcoStruxure IT Expert for ISV/MSP integration* (Client ID, Secret,
   Org ID). Also ask for the latest `PowerNet-MIB`.
2. Admin → Device Control → enter creds, tick channel(s), pick allowed
   actions, flip the master switch.

Action catalogue (key | risk):

```
self_test       low     — UPS battery self-test
mute_alarms     low     — silence audible alarm
battery_calib   low     — runtime calibration
shutdown_delay  medium  — set graceful shutdown delay
outlet_on / off / reboot   medium — outlet group control
output_off      high    — master output off (service interruption!)
firmware_push   high    — push NMC firmware via SFTP/SCP
```

Each action targets one of three channels (SNMP SET / NMC HTTP / EcoStruxure
SDK) — the service auto-picks based on flags + device capabilities.

## Run locally

This is not a standalone repo — drop the files into a running `cflex-v2`
deployment:

```
backend/services/* → /opt/cflex-v2/cflex-api/src/services/
backend/routes/*   → /opt/cflex-v2/cflex-api/src/routes/
sqlite3 cflex.db   < backend/migrations/001_fms_schema.sql

frontend/src/pages/Fms.jsx → /opt/cflex-v2/cflex-frontend/src/pages/
frontend/public/*  → /opt/cflex-v2/cflex-frontend/public/
cd cflex-frontend && npm install maplibre-gl && npm run build
pm2 restart cflex-api-v2
```

Dependencies the FMS code expects to be already in cflex-v2:
- `axios`, `pdfkit`, `better-sqlite3` (cflex-api)
- `react`, `react-router-dom`, `lucide-react`, `maplibre-gl` (cflex-frontend)

## License / attribution

- APC product photos in `reference/` are © Schneider Electric. Do not ship.
- SVG icons in `frontend/public/assets/ups/` are traced for fair-use within
  RingOn's APC partner program.
- US states/counties topology: us-atlas (Apache-2.0).
- MapLibre / OpenStreetMap / Carto positron tiles per their respective
  licenses (attribution rendered in the AlarmMap).
