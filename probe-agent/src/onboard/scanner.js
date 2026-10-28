// onboard/scanner.js — `cflex-onboard scan --scan <cidr>` (spec 04 §1 option 2, §4.5).
//
// Only with the explicit CIDR and the operator's yes. Inside that CIDR only,
// at most 20 hosts started per second, one retry. Per host: TCP 22 (SSH
// banner) and 443 (certificate CN), then — only if the scan section of the
// credentials file gives a community — one SNMP GET of sysObjectID/sysDescr
// to tell an APC card (1.3.6.1.4.1.318.*). ICMP is not sent: it needs raw
// sockets (root); a TCP answer is the liveness test.
//
// The result is a candidate list, onboard/scan-<ts>.json. Nothing is
// configured; a candidate becomes a target only when the operator adds it to
// the inventory.
const net = require('net');
const tls = require('tls');
const snmp = require('net-snmp');

const MAX_RATE = 20;      // hosts started per second (spec 04 §1)
const MIN_PREFIX = 22;    // at most 1022 hosts per scan
const APC_ENTERPRISE = '1.3.6.1.4.1.318.';

function ipToInt(ip) { return ip.split('.').reduce((a, o) => (a * 256) + parseInt(o, 10), 0) >>> 0; }
function intToIp(n) { return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.'); }

/** "192.0.2.0/28" → host addresses (network and broadcast excluded below /31). */
function expandCidr(cidr, { minPrefix = MIN_PREFIX } = {}) {
  const m = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m || m[1].split('.').some(o => +o > 255)) throw new Error(`not a CIDR: ${cidr}`);
  const prefix = +m[2];
  if (prefix < minPrefix || prefix > 32) throw new Error(`--scan prefix must be /${minPrefix}../32 (got /${prefix})`);
  const size = 2 ** (32 - prefix);
  const netw = (ipToInt(m[1]) & (prefix === 0 ? 0 : (~(size - 1) >>> 0))) >>> 0;
  const out = [];
  if (size <= 2) for (let i = 0; i < size; i++) out.push(intToIp(netw + i));
  else for (let i = 1; i < size - 1; i++) out.push(intToIp(netw + i));
  return out;
}

function tcpProbe(host, port, timeoutMs, { banner = false } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let text = '';
    const end = (open) => { clearTimeout(t); s.destroy(); resolve({ open, banner: banner && text ? text.split(/\r?\n/)[0].slice(0, 120) : null }); };
    const t = setTimeout(() => end(!!text), timeoutMs);
    s.on('connect', () => { if (!banner) end(true); });
    s.on('data', (d) => { text += d.toString('latin1'); if (text.includes('\n')) end(true); });
    s.on('error', () => end(false));
  });
}

function certCn(host, port, timeoutMs) {
  return new Promise((resolve) => {
    // Reading the presented certificate only; nothing is trusted or sent over it.
    const s = tls.connect({ host, port, rejectUnauthorized: false, servername: undefined });
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.on('secureConnect', () => { const c = s.getPeerCertificate(); clearTimeout(t); s.destroy(); resolve(c?.subject?.CN || null); });
    s.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

function snmpIdent(host, port, community, timeoutMs) {
  return new Promise((resolve) => {
    const s = snmp.createSession(host, community, { port, version: snmp.Version2c, timeout: timeoutMs, retries: 0 });
    s.on('error', () => {});
    s.get(['1.3.6.1.2.1.1.2.0', '1.3.6.1.2.1.1.1.0'], (err, vbs) => {
      try { s.close(); } catch { /* closed */ }
      if (err || vbs.some(v => snmp.isVarbindError(v))) return resolve(null);
      const oid = String(vbs[0].value);
      resolve({ sysObjectID: oid, sysDescr: String(vbs[1].value).slice(0, 200), apc: oid.startsWith(APC_ENTERPRISE) });
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.cidr
 * @param {object} o.prompt         credentials.createPrompt()
 * @param {boolean} [o.yes]         --yes-all (the operator's explicit yes for the scan too)
 * @param {string} [o.community]    scan.community (credentials file); none → no SNMP step
 * @param {number} [o.rate]         ≤ 20
 * @param {Function} [o.probeHost]  (ip) → result; tests
 * @param {Function} [o.endpoint]   ip → {host, ssh, https, snmp} ports; tests
 */
async function scan({ cidr, prompt, yes = false, community = null, rate = MAX_RATE, timeoutMs = 1500, retries = 1, probeHost = null, endpoint = null, log = console, now = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  const hosts = expandCidr(cidr);
  const r = Math.min(MAX_RATE, Math.max(1, rate));
  if (!yes && !await prompt.confirm(`Scan ${hosts.length} addresses in ${cidr} (TCP 22/443${community ? ', SNMP GET' : ''}, ≤${r} hosts/s)? Nothing will be configured.`)) {
    return { cidr, declined: true, candidates: [], started: [] };
  }
  const inside = new Set(hosts);
  const ep = endpoint || ((ip) => ({ host: ip, ssh: 22, https: 443, snmp: 161 }));
  const probe = probeHost || (async (ip) => {
    const e = ep(ip);
    const ssh = await tcpProbe(e.host, e.ssh, timeoutMs, { banner: true });
    const tl = await tcpProbe(e.host, e.https, timeoutMs);
    const ports = [ssh.open && 22, tl.open && 443].filter(Boolean);
    const cn = tl.open ? await certCn(e.host, e.https, timeoutMs) : null;
    const id = community && ports.length ? await snmpIdent(e.host, e.snmp, community, timeoutMs) : null;
    return { ip, ports, ssh_banner: ssh.banner, https_cn: cn, ...(id || {}) };
  });

  const gap = 1000 / r;
  const t0 = now();
  const started = [];
  const pending = [];
  for (let i = 0; i < hosts.length; i++) {
    const ip = hosts[i];
    if (!inside.has(ip)) throw new Error('scan target outside the CIDR'); // cannot happen; the guard is the rule
    const due = t0 + i * gap;
    const wait = due - now();
    if (wait > 0) await sleep(wait);
    started.push({ ip, at: now() });
    pending.push((async () => {
      let res = await probe(ip).catch(() => null);
      if ((!res || !res.ports?.length) && retries > 0) res = await probe(ip).catch(() => null);
      return res;
    })());
  }
  const all = (await Promise.all(pending)).filter(x => x && x.ports?.length);
  log.log(`[onboard] scan ${cidr}: ${hosts.length} addresses, ${all.length} answered`);
  return { cidr, hosts: hosts.length, rate: r, candidates: all.map(c => ({ ...c, candidate: true, nmc: c.apc === true ? true : c.apc === false ? false : null })), started };
}

module.exports = { scan, expandCidr, MAX_RATE };
