# C-Flex Platform

Multi-portal C-Flex platform: FMS (HAEA umbrella facility monitoring) + Sentinel
(Claude-style LLM Ops Copilot) + cflex shell (NOC / iPilot for dealer + voice)
+ RingOn compliance pages.

Originally an FMS-only repo; this snapshot folds in **all related infrastructure
we built across the cflex-v2-vm + VM1 deployments** so it can be reproduced from
git alone.

## Live deployment map (2026-06)

| Portal | URL | Host | Backend port |
|---|---|---|---|
| cflex shell (NOC + Admin) | https://cflex.runless.co.uk | cflex-v2-vm 20.25.17.81 | :3000 cflex-api-v2 |
| FMS | https://fms.runless.co.uk | VM1 172.172.161.236 | :3000 cflex-fms-api |
| Sentinel (LLM Ops Copilot) | https://sentinel.runless.co.uk | VM1 172.172.161.236 | :4000 cflex-sentinel-api |
| RingOn compliance pages | https://ringonservice.net | cflex-v2-vm | static nginx |

## Repo layout

```
backend/                 — FMS standalone API (deployed at VM1:/opt/cflex-fms/backend)
  routes/
    fms.routes.js          /v1/fms/* — channels, mutes, channel health, simulate
    integrations-slack.routes.js  Slack interactivity webhook (signed HMAC)
    fms-push.routes.js     Expo push notifications
  services/
    alarm-notifier.js      9-channel dispatcher: line / sms / teams / email /
                           slack / discord / pagerduty / servicenow / webhook
    fms-derive-status.js, fms-device-control.js, fms-rca.js, etc.

frontend/                — FMS standalone React app
  src/pages/Fms.jsx        Channels admin, simulation modal, M365 SSO subtab

cflex-shell/             — central cflex platform (cflex-v2-vm)
  cflex-frontend/
    src/App.jsx            Portal routing, ROLE_ALLOWED, cross-domain redirect
    src/pages/Fms.jsx      Shared with FMS standalone
    src/pages/Sentinel.jsx Claude-style LLM chat UI + per-tab AI toggle
    src/pages/Login.jsx    Sign in with Microsoft button + persona redirect
    src/pages/M365SsoPage.jsx  Standalone M365 SSO admin (BYO Entra ID)
    src/hooks/useAuth.jsx, index.html, public/sw.js (kill-switch)
  cflex-api/
    src/server.js          /v1/me with persona-aware landingRoute, M365 mount
    src/routes/m365.routes.js, m365.lib.js   Per-tenant Azure AD config CRUD,
                                              JWKS verification, PKCE flow,
                                              client_secret AES-256-GCM
    src/routes/fms.routes.js                 Channel CRUD, mute admin, health
    src/routes/integrations-slack.routes.js  Same as backend/ but cflex-side
    src/services/alarm-notifier.js           Same 9-channel dispatcher
    src/models/tenant.model.js               hydrate() — parse JSON cols
  sentinel-connect/
    src/server.js                            dotenv override:true for env reload
    src/adapters/twilio-sms.js               MessagingServiceSid support

sentinel-api/            — Sentinel LLM agent (VM1:/opt/cflex-sentinel-api)
  server.js                Claude Sonnet 4.6 tool-use loop, SSE streaming,
                           5 tools (query_alarms / query_tickets / create_ticket
                           / query_devices / send_message)
  package.json

ringonservice-net/       — RingOn compliance static pages (A2P 10DLC)
  sms-optin.html           Carrier-required opt-in form with STOP/HELP +
                           inline Terms/Privacy links + voluntary disclosure
  sms-optout.html          Web fallback to STOP keyword
  sms-terms.html           Dedicated SMS Program Terms (carrier review target)
  privacy-policy.html      Up-to-30-msg/month, 5.5 "consent is not a condition"
  terms.html, index.html, sms-signup.html

nginx/                   — vhost configs (cflex-v2-vm + VM1)
  cflex-v2-vhost.conf         cflex.runless.co.uk
  ringonservice-net-vhost.conf ringonservice.net
  sentinel-connect-snippet.conf  /sc/* routes
  vm1-fms-vhost.conf            fms.runless.co.uk
  vm1-sentinel-vhost.conf       sentinel.runless.co.uk

docs/                    — sales/dev plan documents
deploy/                  — install scripts, systemd units
```

## Key features shipped in this batch

- **Multi-channel notification dispatcher** — Slack (Block Kit + Ack/Mute
  buttons), Teams (dual-mode webhook / Graph), Discord, PagerDuty (Events v2),
  ServiceNow (Table API), Generic webhook, LINE, SMS, Email
- **Slack interactivity** — HMAC v0 signature verification, ack writes
  `alerts.acked_at`, mute writes `fms_alarm_mutes` (60-min TTL by default)
- **Channel health dashboard** — 24h / 7d / 30d success ratios, recent failures
- **Microsoft 365 SSO** — BYO Entra ID per tenant. Admin pastes Directory/Client
  IDs + secret (AES-256-GCM at rest), groups → C-Flex role mapping via Graph
  `/groups`. PKCE auth code flow, JWKS-verified ID tokens, auto-provisioning.
- **Sentinel LLM Ops Copilot** — Claude Sonnet 4.6 + tool-use, SSE streaming,
  per-thread history, per-browser AI toggle (zero tokens when off).
- **Portal routing rule** — Each persona has exactly one home portal:
  - super_admin/admin/oem_admin/engineer → cflex.runless.co.uk
  - fms_admin + SKU=fms/ups/network/sbc → fms.runless.co.uk
  - SKU=sentinel/ebond + noc_operator → sentinel.runless.co.uk
  - dealer_* → dealer.runless.co.uk (planned)
- **RingOn A2P 10DLC compliance** — 4 pages with carrier-aligned voluntary
  disclosure, STOP/HELP in opt-in label, inline Terms/Privacy links.

## Reproducing

```bash
# 1. FMS standalone backend (VM1)
cd backend && npm install
cp .env.example .env  # fill JWT_SECRET, ANTHROPIC_API_KEY, SLACK_SIGNING_SECRET
node src/server.js

# 2. Sentinel agent (VM1)
cd sentinel-api && npm install
cp .env.example .env
node server.js

# 3. cflex shell (cflex-v2-vm) — see cflex-shell/cflex-api + cflex-frontend
#    follow upstream cflex-v2 setup, then drop in our patched files.

# 4. nginx — drop vhost files from nginx/ into /etc/nginx/sites-available/
#    and symlink to sites-enabled/. Run certbot for each domain.
```

## Notes

- Many of the cflex-shell files are **patches on top of** the closed-source
  cflex-v2 base repo; the originals are not redistributed here. The diffs in
  these files represent the changes we made.
- `.env` files (with Twilio / Anthropic / JWT secrets) are intentionally not
  committed.
- See individual route/service comments for endpoint specifications.
