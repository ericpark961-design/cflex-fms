// A Redis stand-in for the tests: the RESP2 commands the console uses, in
// memory, with expiry. Not a fake of the client — a real TCP server the
// real client (src/redis.js) talks to, so the protocol code is exercised.
const net = require('net');
const { parse } = require('../../src/redis');

const bulk = (v) => (v == null ? '$-1\r\n' : `$${Buffer.byteLength(String(v))}\r\n${v}\r\n`);

function startMiniRedis({ password = null } = {}) {
  const data = new Map();   // key → { v, exp }
  const live = (k) => { const e = data.get(k); if (e && e.exp && e.exp <= Date.now()) { data.delete(k); return null; } return e || null; };
  const commands = [];

  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let authed = !password;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let r;
      while ((r = parse(buf))) {
        buf = buf.subarray(r[1]);
        const [cmd, ...a] = r[0];
        const C = String(cmd).toUpperCase();
        commands.push(C);
        if (C === 'AUTH') { authed = a[0] === password; sock.write(authed ? '+OK\r\n' : '-WRONGPASS invalid password\r\n'); continue; }
        if (!authed) { sock.write('-NOAUTH Authentication required.\r\n'); continue; }
        switch (C) {
          case 'PING': sock.write('+PONG\r\n'); break;
          case 'SELECT': sock.write('+OK\r\n'); break;
          case 'GET': sock.write(bulk(live(a[0])?.v)); break;
          case 'SET': {
            let exp = null;
            for (let i = 2; i < a.length; i++) {
              if (String(a[i]).toUpperCase() === 'EX') exp = Date.now() + +a[++i] * 1000;
              else if (String(a[i]).toUpperCase() === 'PX') exp = Date.now() + +a[++i];
            }
            data.set(a[0], { v: a[1], exp }); sock.write('+OK\r\n'); break;
          }
          case 'DEL': { const had = live(a[0]) ? 1 : 0; data.delete(a[0]); sock.write(`:${had}\r\n`); break; }
          case 'EXPIRE': { const e = live(a[0]); if (e) e.exp = Date.now() + +a[1] * 1000; sock.write(`:${e ? 1 : 0}\r\n`); break; }
          case 'INCR': { const e = live(a[0]); const n = (e ? parseInt(e.v, 10) : 0) + 1; data.set(a[0], { v: String(n), exp: e?.exp || null }); sock.write(`:${n}\r\n`); break; }
          default: sock.write(`-ERR unknown command '${C}'\r\n`);
        }
      }
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    resolve({
      url: `redis://127.0.0.1:${port}/0`, port, data, commands,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    });
  }));
}

module.exports = { startMiniRedis };
