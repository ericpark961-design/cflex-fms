# cflex-twin 2.0 — `/twin/`

The whole C-Flex FMS 2.0 app, served at `https://fms.runless.co.uk/twin/`.

Not a route of `frontend/` — a separate Vite bundle with its own dark NOC theme.
It shares the session (`localStorage.cflex_token`) and the `/v1/fms/*` API with
`/fms` 1.x, and nothing in `frontend/src/pages/Fms.jsx` is touched. The only link
back out is "FMS 1.x (관리)".

## Routes (hash router)

| route | screen | real data |
| --- | --- | --- |
| `#/dashboard` (default) | KPI, CBU toggle, asset honeycomb, battery scorecard, sites, recent alarms | yes, except Fleet Live / AI / PUE |
| `#/device?id=<id>` | device detail, gauges, alarm history | yes, except trend / AI prediction / RCA |
| `#/alarms` | alarm centre table | yes, except root-cause grouping / rules / rota |
| `#/powerchain[?panel=copilot]` | power chain twin + AI copilot | sample (Phase 3) |
| `#/twin?scene=real\|demo` | 3D — real UPS fleet, or the KMX CCR demo scene | real scene yes |
| `#/wall` | 1920×1080 NOC wall, scaled to fit | KPI + clock |

Anything still sample is marked by the yellow badge, bottom right. Do not remove it.

## Layout

| file | what it is |
| --- | --- |
| `src/theme.js` | tokens, `tx()`, `api()`, `withCbu()` — verbatim from `Fms.jsx`. Do not restyle. |
| `src/ids.js` | device-id normalisation — see the trap below |
| `src/tpl.js` | template runtime for the mockup markup (`sc-for` / `sc-if` / `{{path}}`) |
| `src/data.js` | `/v1` → screen data. One adapter per screen; sample values fill the gaps |
| `src/screens/*.tpl.html` | markup extracted from the 2.0 mockup, links rewritten to `#/…` |
| `src/screens/*.logic.js` | each screen's sample data, straight from the mockup |
| `src/layout.js` | `/v1/fms/floor` tree → room and rack coordinates, parsed from rack names |
| `src/Twin3D.jsx` | real-data 3D scene |
| `src/DemoScene.js` | KMX CCR demo scene (CRAC, sensors, leak zones, heatmap) |
| `src/App.jsx` | hash router, screen assembly, 3D screen, wall scaling |
| `mock/server.js` | offline `/v1` with the real backend's key names **and id shapes** |

## Two traps worth knowing

**Device ids come in two shapes.** `/v1/fms/alerts` returns `device_id` as
`'ups-41'`; `/v1/fms/floor`, `/v1/fms/assets` and `/v1/fms/assets/:id` all use the
bare `41`, and `:id` is `parseInt`ed. Anything that turns an alert into a device
link or fetch must go through `devId()` first. This fails quietly rather than
loudly: the fetch 404s and the screen shows whichever device the fallback picks.
`mock/server.js` reproduces both shapes on purpose — do not "tidy" them into one.

**`sc-for` inside a `<table>` needs `tpl.js`'s rewrite.** The HTML parser
foster-parents unknown elements out of `<table>`/`<tbody>`, so an `<sc-for>` written
inside a `<tbody>` loses its children and the `<tr>` it wrapped is parsed as one
literal row. `tpl.js` rewrites the directives to `<template>` — the one element the
parser must keep in table context — before parsing. Without it the alarm centre and
the device alarm history each render a single blank row, silently.

## Develop

```bash
cd apps/twin
npm ci
node mock/server.js &          # :3001 — 44 UPS, 3 sites, 2 critical, 7 alerts
npm run dev                    # http://localhost:5174/twin/
```

Against the live backend (needs a real `cflex_token` for `localhost:5174`):

```bash
TWIN_API=https://cflex.runless.co.uk npm run dev
```

`npm run build` must emit no warnings. `npm run lint` has 5 known warnings, all in
mockup-derived code (`DemoScene.js` style, `dark`/`onReady` effect deps).

## Deploy

```bash
./deploy/deploy-twin.sh [ssh-host]     # default: vm1
```

nginx is unchanged from v1 and already live. The `^~` on `location ^~ /twin/` in
`nginx/vm1-fms-vhost.conf` is load-bearing — the vhost has a `~* \.(html|json)$`
regex location, which beats a plain prefix location, so without it every `/twin/`
request including the SPA fallback 404s.

## Constraints

- Dark NOC theme. No reverting to the 1.x light theme, no extra links back to `/fms`.
- No CDN scripts — three.js is bundled.
- No backend changes. The screen never evaluates thresholds; it renders the `status`
  the API already computed (the 5-minute staleness gate is in `fms.routes.js`).
- Tokens are never put in a query string.

## Known gaps

- `tpl.js` builds components with `new Function`, so a `script-src 'self'` CSP would
  need `unsafe-eval`. VM1 serves no CSP today; if one is added, the screen logic has
  to be precompiled at build time.
- Rack coordinates are guessed from rack names. When `racks(row_no, col_no)` lands,
  `/v1/fms/floor` should return `row_no`/`col_no`/`face` and `layout.js` prefers them.
- 30s polling, to be replaced by the `device:{id}` / `alarms` WebSocket topics.
- 2.0 screens are Korean-only; `tx()` is wired but the strings are not extracted yet.
