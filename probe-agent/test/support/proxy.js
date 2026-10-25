// A dummy forward proxy: HTTP CONNECT only, Basic auth required — what an
// enterprise egress proxy looks like to the Probe, minus NTLM.
const http = require('http');
const net = require('net');

function startProxy({ user = 'probe', pass = 'test-only' } = {}) {
  const state = { tunnels: [], refused: 0 };
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); };
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  srv.on('connect', (req, client, head) => {
    track(client);
    if (req.headers['proxy-authorization'] !== expected) {
      state.refused++;
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    state.tunnels.push(req.url);
    const up = net.connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    track(up);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    resolve({
      port, state,
      openSockets: () => sockets.size,
      url: (u = user, p = pass) => `http://${encodeURIComponent(u)}:${encodeURIComponent(p)}@127.0.0.1:${port}`,
      close: () => new Promise(r => { for (const s of sockets) s.destroy(); srv.closeAllConnections?.(); srv.close(r); }),
    });
  }));
}

module.exports = { startProxy };
