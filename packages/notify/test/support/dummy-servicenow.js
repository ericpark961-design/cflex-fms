// A dummy ServiceNow Table API for tests: POST creates an incident, PATCH
// updates one. Checks the Authorization header like an instance would.
// `state.faults` answers the next request(s) with a status instead. 127.0.0.1.
const http = require('node:http');
const crypto = require('node:crypto');

function startDummyServiceNow({ auth = 'Basic ' + Buffer.from('svc:secret').toString('base64'), table = 'incident' } = {}) {
  const state = { incidents: new Map(), requests: [], faults: [], seq: 10000 };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { return send(400, { error: { message: 'bad json' } }); }
      state.requests.push({ method: req.method, url: req.url, body });
      const fault = state.faults.shift();
      if (fault) return send(fault.status, { error: { message: fault.message || 'injected', detail: '' }, status: 'failure' });
      if (req.headers.authorization !== auth) return send(401, { error: { message: 'User Not Authenticated' }, status: 'failure' });
      const m = new RegExp(`^/api/now/table/${table}(?:/([0-9a-f]{32}))?$`).exec(req.url.split('?')[0]);
      if (!m) return send(404, { error: { message: 'No such table' } });
      if (req.method === 'POST' && !m[1]) {
        const rec = { ...body, sys_id: crypto.randomBytes(16).toString('hex'), number: `INC00${++state.seq}`, state: '1', work_notes_log: [] };
        state.incidents.set(rec.sys_id, rec);
        return send(201, { result: rec });
      }
      if (req.method === 'PATCH' && m[1]) {
        const rec = state.incidents.get(m[1]);
        if (!rec) return send(404, { error: { message: 'No Record found' } });
        if (body.work_notes) rec.work_notes_log.push(body.work_notes);
        Object.assign(rec, { ...body, work_notes: undefined });
        return send(200, { result: rec });
      }
      send(405, { error: { message: 'method' } });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`, auth, state,
    close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }),
  })));
}

module.exports = { startDummyServiceNow };
