// redis.js — the few Redis commands the console needs, over RESP2, no package.
//
// The site has no internet and only Satellite AppStream: a Redis client from
// npm is one more thing to vendor, audit and SBOM for six commands. This
// speaks the protocol directly: one TCP connection, commands pipelined in
// order, replies matched first-in first-out.
//
// A dropped connection fails the commands in flight (the caller answers 503)
// and the next command reconnects, so a Redis restart costs a request, not
// the process.
const net = require('net');

/** Parse one RESP2 reply from buf at offset i. Returns [value, nextIndex] or null if incomplete. */
function parse(buf, i = 0) {
  if (i >= buf.length) return null;
  const eol = buf.indexOf('\r\n', i);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.toString('utf8', i + 1, eol);
  const next = eol + 2;
  switch (type) {
    case '+': return [line, next];
    case '-': { const e = new Error(line); e.redis = true; return [e, next]; }
    case ':': return [parseInt(line, 10), next];
    case '$': {
      const n = parseInt(line, 10);
      if (n < 0) return [null, next];
      if (buf.length < next + n + 2) return null;
      return [buf.toString('utf8', next, next + n), next + n + 2];
    }
    case '*': {
      const n = parseInt(line, 10);
      if (n < 0) return [null, next];
      const out = [];
      let j = next;
      for (let k = 0; k < n; k++) {
        const r = parse(buf, j);
        if (!r) return null;
        out.push(r[0]); j = r[1];
      }
      return [out, j];
    }
    default: throw new Error(`RESP: unexpected type byte ${JSON.stringify(type)}`);
  }
}

function encode(args) {
  let s = `*${args.length}\r\n`;
  for (const a of args) { const b = Buffer.from(String(a)); s += `$${b.length}\r\n${b}\r\n`; }
  return s;
}

/**
 * @param {string} url       redis://[:password@]host:port[/db]
 * @param {object} [o]
 * @param {string} [o.password]  overrides the URL's
 * @param {number} [o.timeoutMs]
 */
function createRedis(url, { password = null, timeoutMs = 3000 } = {}) {
  const u = new URL(url);
  const host = u.hostname || '127.0.0.1';
  const port = parseInt(u.port || '6379', 10);
  const dbIndex = parseInt((u.pathname || '/0').slice(1) || '0', 10);
  const pass = password || (u.password ? decodeURIComponent(u.password) : null);

  let sock = null;
  let ready = null;          // Promise of a connected, authenticated socket
  let buf = Buffer.alloc(0);
  const pending = [];        // {resolve, reject}

  function failAll(err) {
    while (pending.length) pending.shift().reject(err);
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      s.setNoDelay(true);
      s.setTimeout(timeoutMs);
      s.on('connect', () => { s.setTimeout(0); sock = s; resolve(s); });
      s.on('timeout', () => s.destroy(new Error(`redis ${host}:${port} timed out`)));
      s.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let r;
        while (pending.length && (r = parse(buf))) {
          buf = buf.subarray(r[1]);
          const p = pending.shift();
          if (r[0] instanceof Error) p.reject(r[0]); else p.resolve(r[0]);
        }
      });
      const down = (err) => {
        const e = err || new Error('redis connection closed');
        e.redisDown = true;   // the server answers 503 for these, whatever the socket said
        sock = null; ready = null; buf = Buffer.alloc(0);
        failAll(e);
        reject(e);
      };
      s.on('error', down);
      s.on('close', () => down());
    }).then(async (s) => {
      if (pass) await raw(s, ['AUTH', pass]);
      if (dbIndex) await raw(s, ['SELECT', dbIndex]);
      return s;
    });
    ready.catch(() => {});
    return ready;
  }

  function raw(s, args) {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      s.write(encode(args));
    });
  }

  async function command(...args) {
    const s = await connect();
    return raw(s, args);
  }

  return {
    command,
    get: (k) => command('GET', k),
    set: (k, v, ttlS) => (ttlS ? command('SET', k, v, 'EX', ttlS) : command('SET', k, v)),
    del: (k) => command('DEL', k),
    expire: (k, s) => command('EXPIRE', k, s),
    incr: (k) => command('INCR', k),
    ping: () => command('PING'),
    close() { if (sock) sock.end(); sock = null; ready = null; },
  };
}

module.exports = { createRedis, parse, encode };
