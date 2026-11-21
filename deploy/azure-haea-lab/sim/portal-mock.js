// HAEA mirror lab — the Portal stand-in for SAT 5 (store-and-forward), WO-INT-015.
// The same strict mock the E2E tests use (probe-agent/test/support/mock-portal.js: mTLS,
// tenant/node headers, schema validation, Idempotency-Key replay), listening on :443 as
// "cflex.fms.support" (svc's /etc/hosts points the proxy at this VM). Lab CA only.
//
// Control (loopback): GET http://127.0.0.1:9180/stats[?from=ISO&to=ISO]
//   → requests, accepted per route, telemetry points (total / unique device+ts / in window),
//     duplicate points, events, last receive time
const http = require('http');
const fs = require('fs');
const { startMockPortal } = require('./probe-agent/test/support/mock-portal');

const D = process.env.LAB_CA_DIR || '/opt/lab-portal/ca';
const tenant = process.env.LAB_TENANT || 'HAEA';
const server = {
  cert: fs.readFileSync(`${D}/server.pem`), key: fs.readFileSync(`${D}/server.key`), ca: fs.readFileSync(`${D}/ca.pem`),
};

startMockPortal({ server, tenant, port: 443, host: '0.0.0.0' }).then((m) => {
  console.log(`portal mock :443 tenant ${tenant}`);
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const from = u.searchParams.get('from') || '';
    const to = u.searchParams.get('to') || '9999';
    const keys = new Map();
    let points = 0; let inWindow = 0; let last = null;
    for (const r of m.state.received) {
      if (r.route !== 'POST /api/v1/telemetry') continue;
      for (const p of r.body.points) {
        points += 1;
        const k = `${p.device_id}|${p.ts}`;
        keys.set(k, (keys.get(k) || 0) + 1);
        if (p.ts >= from && p.ts < to) inWindow += 1;
        if (!last || p.ts > last) last = p.ts;
      }
    }
    const routes = {};
    for (const r of m.state.received) routes[r.route] = (routes[r.route] || 0) + 1;
    const events = m.of('POST /api/v1/events').reduce((n, b) => n + b.events.length, 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requests: m.state.requests.length, routes, points, unique_points: keys.size,
      duplicate_points: points - keys.size, points_in_window: inWindow, events, last_point_ts: last,
    }));
  }).listen(9180, '127.0.0.1');
});
