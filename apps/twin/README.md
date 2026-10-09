# cflex-twin — `/twin/`

3D digital twin of the UPS fleet, served at `https://fms.runless.co.uk/twin/`.

It is a **separate Vite app**, not a route of `frontend/`. It shares the session
(`localStorage.cflex_token`), the `/v1/fms/*` API, and the Carbon-derived design
tokens with `/fms`, but ships its own bundle so `frontend/src/pages/Fms.jsx`
stays untouched.

## Layout

| file | what it is |
| --- | --- |
| `src/theme.js` | colour tokens, `tx()`, `api()`, `withCbu()` — a verbatim copy of the `C` / `FONT` / `tx` definitions in `frontend/src/pages/Fms.jsx`. **Do not restyle.** |
| `src/ids.js` | device-id normalisation. `/v1/fms/alerts` returns `ups-41`, everything else returns `41`. |
| `src/layout.js` | `/v1/fms/floor` tree → room and rack coordinates, parsed from rack names |
| `src/Twin3D.jsx` | the three.js scene — orbit, picking, status/load/temp colouring, camera presets |
| `src/App.jsx` | shell (sidebar, top bar, KPI tiles) + 3D + detail panel + 24h alert list |
| `mock/server.js` | offline `/v1/me` and `/v1/fms/*` with the real backend's key names and id shapes |

## Develop

Against the mock API (44 UPS across 3 sites, 2 critical / 4 warning):

```bash
cd apps/twin
npm ci
node mock/server.js &          # :3001
npm run dev                    # http://localhost:5174/twin/
```

Against the live backend — needs a real `cflex_token` in `localStorage` for
`localhost:5174`:

```bash
TWIN_API=https://cflex.runless.co.uk npm run dev
```

`npm run lint` must be clean and `npm run build` must emit no warnings.

## Deploy

```bash
./deploy/deploy-twin.sh [ssh-host]     # default: vm1
```

The vhost blocks live in `nginx/vm1-fms-vhost.conf`. The `^~` on
`location ^~ /twin/` is load-bearing: the vhost already has a
`~* \.(html|json)$` regex location, and a regex location beats a plain prefix
location, so without `^~` every `/twin/` request — including the SPA fallback's
internal redirect to `/twin/index.html` — is served from the `/fms` root and
404s.

## Constraints

- No new colours, fonts, rounded corners or gradients. Tokens come from `theme.js`.
- No CDN scripts — three.js is bundled, so the page survives a `script-src 'self'` CSP.
- No backend changes. The screen never evaluates thresholds; it renders the
  `status` the API already computed (the 5-minute staleness gate lives in
  `backend/routes/fms.routes.js`).
- Tokens are never put in a query string.

## Known gaps

- Rack coordinates are guessed from rack names (`A01`, `B-07`, `Row A Rack 7`,
  `R2-C5`), falling back to rows of ten. When `racks(row_no, col_no)` lands,
  `/v1/fms/floor` should return `row_no`/`col_no`/`face` on each rack node and
  `layout.js` should prefer them.
- 30s polling, to be replaced by the `device:{id}` / `alarms` WebSocket topics.
- Two Lighthouse colour-contrast findings are inherited from the `/fms` design
  contract and left in deliberately: the 11px/700 `inkSubtle` KPI labels (3.31:1)
  and white-on-`warn` P2 badges (1.68:1). Changing either would make `/twin`
  diverge from `/fms`. Accessibility score is 96.
