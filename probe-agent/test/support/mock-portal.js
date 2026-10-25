// A local stand-in for the Portal's ingest (contract §3.1–3.4), for E2E tests
// and for running the probe against something on a laptop. It is strict where
// the real one must be: mTLS required, tenant/node/Idempotency-Key headers
// required, every body validated against the same schema files, and a repeated
// Idempotency-Key answered from cache without being stored twice.
//
// Not the Portal's /_mock (Codex, WO-PTL-001) — this exists so the Probe can
// be proven without it. Run standalone:
//   node test/support/mock-portal.js   (prints port + a temp CA/client cert)
const https = require('https');
const schema = require('../../src/contract/schema');

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ROUTES = {
  'POST /api/v1/heartbeat': { schema: 'heartbeat', reply: () => ({ ack: true, commands_pending: 0, config_version: 1 }) },
  'PUT /api/v1/inventory': { schema: 'inventory', reply: (b) => ({ accepted: b.devices.length, rejected: [] }) },
  'POST /api/v1/telemetry': { schema: 'telemetry', reply: (b) => ({ accepted: b.points.length, dropped: 0 }) },
  'POST /api/v1/events': { schema: 'events', reply: (b) => ({ accepted: b.events.length, routing: [] }) },
};

function startMockPortal({ server: tlsMaterial, tenant = 'TEST', dateOffsetMs = 0 } = {}) {
  const state = {
    received: [],           // accepted, de-duplicated: { route, body, headers }
    requests: [],           // every request, including retries and rejects
    idem: new Map(),        // Idempotency-Key → { status, body }
    faults: [],             // queued: { status, headers?, body? } answered before routing
    legacy: [],             // anything that arrived at the old /v1/probe/* path
    dateOffsetMs,
  };

  const srv = https.createServer({
    ...tlsMaterial, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
  }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (status, body, headers = {}) => {
        res.writeHead(status, {
          'Content-Type': 'application/json', 'X-CFlex-API-Version': '1.0',
          Date: new Date(Date.now() + state.dateOffsetMs).toUTCString(), ...headers,
        });
        res.end(JSON.stringify(body));
      };
      const err = (status, code, message) => send(status, { error: { code, message } });
      const peer = req.socket.getPeerCertificate();
      const route = `${req.method} ${req.url.split('?')[0]}`;
      state.requests.push({ route, headers: req.headers, peerCN: peer?.subject?.CN });

      if (req.url.startsWith('/v1/probe/')) { state.legacy.push({ route, raw }); return send(200, { ok: true }); }

      const fault = state.faults.shift();
      if (fault) return send(fault.status, fault.body || { error: { code: 'fault', message: 'injected' } }, fault.headers);

      const r = ROUTES[route];
      if (!r) return err(404, 'not_found', route);
      if (req.headers['x-cflex-tenant'] !== tenant) return err(401, 'tenant', 'X-CFlex-Tenant mismatch');
      if (!req.headers['x-cflex-node']) return err(401, 'node', 'X-CFlex-Node missing');
      if (peer?.subject?.CN !== `${tenant}.${req.headers['x-cflex-node']}`) return err(401, 'cert', 'certificate CN does not match tenant.node');
      const key = req.headers['idempotency-key'];
      if (!UUID4.test(key || '')) return err(400, 'idempotency_key', 'Idempotency-Key must be a UUIDv4');
      if (state.idem.has(key)) { const c = state.idem.get(key); return send(c.status, c.body); }

      let body;
      try { body = JSON.parse(raw); } catch { return err(400, 'json', 'body is not JSON'); }
      const v = schema.validate(r.schema, body);
      if (!v.ok) return err(422, 'schema', v.errors.slice(0, 5).join('; '));
      const reply = r.reply(body);
      state.idem.set(key, { status: 200, body: reply });
      state.received.push({ route, body, headers: req.headers });
      send(200, reply);
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `https://localhost:${port}`, port, state,
        of: (route) => state.received.filter(x => x.route === route).map(x => x.body),
        close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }),
      });
    });
  });
}

module.exports = { startMockPortal };

if (require.main === module) {
  const { makeCerts } = require('./certs');
  const c = makeCerts();
  startMockPortal({ server: c.server }).then(m => {
    console.log(`mock portal on ${m.url} (tenant TEST)`);
    console.log(`  CFLEX_PORTAL_URL=${m.url} TENANT_ID=TEST CFLEX_NODE_ID=cap01`);
    console.log(`  CFLEX_TLS_CA=${c.client.caPath} CFLEX_TLS_CERT=${c.client.certPath} CFLEX_TLS_KEY=${c.client.keyPath}`);
    process.on('SIGINT', () => { c.cleanup(); process.exit(0); });
    setInterval(() => console.log(`received: ${m.state.received.length}`), 60000);
  });
}
