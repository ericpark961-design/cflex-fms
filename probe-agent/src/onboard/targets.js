// onboard/targets.js — which cards cflex-onboard may talk to (spec 04 §1).
//
// Option 1, the default: the inventory. Sources, merged by IP:
//   · the NMC target list (install/nmc-targets.example.txt format, one IP per
//     line — site.yaml nmc.targets_file names it on the VMs),
//   · an inventory CSV (the console's import columns, the Q3 seed CSV,
//     Exhibit 1: nmc_ip|ip, site, label|unit, model, serial, firmware),
//   · the Local Console's device list (GET /v1/console/devices).
// The gate built from it is checked by every transport before it opens a
// socket: an address that is not in the list gets no packet at all.
//
// Option 2 (scanner.js) has its own gate — the CIDR the operator typed — and
// its results are candidates only: they reach this list only when the
// operator adds them to the inventory.
const fs = require('fs');
const http = require('http');
const https = require('https');
const { loads } = require('./yaml-lite');
const { IPV4_RE } = require('./commands');

class TargetError extends Error { constructor(m) { super(m); this.code = 'not_in_inventory'; } }

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

const ALIAS = {
  ip: ['nmc_ip', 'ip', 'nmc ip', 'ip address'], site: ['site', 'site_id', 'cbu'], label: ['label', 'unit', 'name', 'device'],
  model: ['model'], serial: ['serial', 'serial_number'], firmware: ['firmware'],
};

/** One file: a plain IP list, or a CSV with a header. */
function parseTargetsFile(text, { source = 'file' } = {}) {
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
  if (!lines.length) return [];
  if (!lines[0].includes(',')) {
    return lines.map((l) => {
      if (!IPV4_RE.test(l)) throw new Error(`${source}: not an IPv4 address: ${l}`);
      return { ip: l, source };
    });
  }
  const rows = parseCsv(text);
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(ALIAS)) {
    const i = head.findIndex(h => names.includes(h));
    if (i >= 0) col[k] = i;
  }
  if (col.ip == null) throw new Error(`${source}: no IP column (nmc_ip / ip)`);
  const out = [];
  for (const r of rows.slice(1)) {
    const ip = String(r[col.ip] || '').trim();
    if (!ip) continue; // a unit without an IP yet (HMA has three) — inventory only
    if (!IPV4_RE.test(ip)) throw new Error(`${source}: not an IPv4 address: ${ip}`);
    const t = { ip, source };
    for (const k of ['site', 'label', 'model', 'serial', 'firmware']) if (col[k] != null && String(r[col[k]] || '').trim()) t[k] = String(r[col[k]]).trim();
    out.push(t);
  }
  return out;
}

function loadSiteYaml(path) {
  const site = loads(fs.readFileSync(path, 'utf8')) || {};
  return {
    raw: site,
    tenant: site.tenant?.code || null,
    targetsFile: site.nmc?.targets_file || null,
    collectors: (site.hosts?.collectors || []).map(c => ({ id: c.id, ip: c.ip, sites: (c.sites || []).map(String) })),
    onboard: site.onboard || {},
  };
}

/** Console device rows → targets (only rows with an NMC IP). */
function fromConsole(devices) {
  return (devices || []).filter(d => d.nmc_ip && IPV4_RE.test(d.nmc_ip)).map(d => ({
    ip: d.nmc_ip, site: d.site_id || undefined, label: d.label || undefined, model: d.model || undefined,
    serial: d.serial || undefined, firmware: d.firmware || undefined, device_id: d.device_id, source: 'console',
  }));
}

/**
 * Merge sources by IP; later sources fill what earlier ones lack, the console
 * (when given) wins on site/label because it is the operator's inventory.
 */
function mergeTargets(lists, { site = null, only = null, maxDevices = 64 } = {}) {
  const by = new Map();
  for (const list of lists) {
    for (const t of list || []) {
      const had = by.get(t.ip);
      if (!had) { by.set(t.ip, { ...t, sources: [t.source] }); continue; }
      const win = t.source === 'console';
      for (const [k, v] of Object.entries(t)) if (v != null && k !== 'source' && (win || had[k] == null)) had[k] = v;
      had.sources.push(t.source);
    }
  }
  let out = [...by.values()];
  if (site) out = out.filter(t => String(t.site || '').toUpperCase() === String(site).toUpperCase());
  if (only && only.length) {
    const want = new Set(only);
    for (const ip of want) if (!by.has(ip)) throw new TargetError(`${ip} is not in the inventory — option 1 talks to inventory addresses only`);
    out = out.filter(t => want.has(t.ip));
  }
  if (out.length > maxDevices) throw new Error(`${out.length} targets exceed --max-devices ${maxDevices}`);
  return out;
}

/** The inventory gate every transport asks before opening a socket. */
function createGate(targets) {
  const allowed = new Set((targets || []).map(t => t.ip));
  return {
    allows: (ip) => allowed.has(ip),
    assert(ip) { if (!allowed.has(ip)) throw new TargetError(`${ip} is not in the target list — no packet sent`); },
    size: () => allowed.size,
  };
}

// ── Local Console (set_maintenance, inventory) — its existing API only ─────
/**
 * @param {object} o
 * @param {string} o.url        https://<app>/ (or http://127.0.0.1:port in tests)
 * @param {{user,password}} o.login
 * @param {Buffer} [o.ca]
 */
function createConsoleApi({ url, login, ca = null, timeoutMs = 15000 }) {
  const base = new URL(url);
  const lib = base.protocol === 'https:' ? https : http;
  let cookie = null;
  function req(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const r = lib.request(new URL(path, base), {
        method, timeout: timeoutMs, ...(ca ? { ca } : {}),
        headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc && sc.length) cookie = String(sc[0]).split(';')[0];
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* not JSON */ }
          if (res.statusCode >= 400) return reject(new Error(`console ${method} ${path}: HTTP ${res.statusCode}${j?.error ? ` ${j.error}` : ''}`));
          resolve(j);
        });
      });
      r.on('timeout', () => r.destroy(new Error(`console ${method} ${path}: timeout`)));
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }
  return {
    async login() { await req('POST', '/v1/auth/login', { username: login.user, password: login.password }); },
    async devices() { return (await req('GET', '/v1/console/devices'))?.devices || []; },
    /** spec 04 §4.3: the site's maintenance window for the run (POST /v1/console/maintenance). */
    async setMaintenance(siteId, minutes, reason) { return req('POST', '/v1/console/maintenance', { site_id: siteId, minutes, reason }); },
    async endMaintenance(id) { return req('DELETE', `/v1/console/maintenance/${encodeURIComponent(id)}`); },
  };
}

module.exports = { parseTargetsFile, parseCsv, loadSiteYaml, fromConsole, mergeTargets, createGate, createConsoleApi, TargetError };
