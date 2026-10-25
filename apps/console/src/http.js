// http.js — a router small enough to read in one sitting, on node:http.
//
// No framework: the console has some forty routes, all JSON, and the bundle
// has to be carried into a site with no internet. Each route declares the
// role it needs; the router does authentication before the handler runs, so
// a handler that forgets to check cannot leak.
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}

const MAX_BODY = 5 * 1024 * 1024;   // a 48-row inventory CSV is a few KB; 5 MB is generous

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Every response: no framing, no sniffing, and a CSP that allows nothing off
// this origin — so "no external CDN calls" is enforced by the browser, not
// just by having checked the bundle once.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
    + "script-src 'self'; worker-src 'self' blob:; connect-src 'self'; font-src 'self' data:; "
    + "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** A file under root, or false. Refuses anything that resolves outside root. */
function serveFile(res, root, rel, { fallback = null } = {}) {
  const base = path.resolve(root);
  let file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  let st = null;
  try { st = fs.statSync(file); } catch { /* not there */ }
  if (st && st.isDirectory()) { file = path.join(file, 'index.html'); try { st = fs.statSync(file); } catch { st = null; } }
  if (!st && fallback) { file = path.join(base, fallback); try { st = fs.statSync(file); } catch { st = null; } }
  if (!st || !st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  // Vite's hashed assets never change under the same name; HTML always revalidates.
  const cache = /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
  return true;
}

function createRouter() {
  const routes = [];
  /**
   * @param {string} method
   * @param {string} pattern   '/v1/fms/alerts/:id/ack'
   * @param {object} opts      { role: 'viewer'|'operator'|'admin'|null(public)|'collector' }
   * @param {Function} handler (ctx) => body | {status, body, headers}
   */
  function add(method, pattern, opts, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, opts, handler });
  }
  function match(method, pathname) {
    let pathHit = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathHit = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathHit ? { methodNotAllowed: true } : null;
  }
  return { add, match, routes };
}

module.exports = { HttpError, readBody, parseCookies, send, serveFile, createRouter, SECURITY_HEADERS };
