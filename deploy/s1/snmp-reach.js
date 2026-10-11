#!/usr/bin/env node
// SNMP reachability survey — roadmap item 2.
//
// Runs snmpget(sysDescr) against every registered device from WHEREVER THIS IS
// RUN, records the result, and writes the CSV the HAEA request letter is built
// from. Where it was run from is half the finding, so `probe_host` is recorded
// on every row: a timeout from an Azure VM with no route to 10.112/0.0 is a
// different fact from a timeout from a machine on the same LAN, and only the
// second one is evidence about NMC access control.
//
//   node deploy/s1/snmp-reach.js [--cbu HMA] [--v3] [--out docs/] [--timeout 2]
//
// Writes:
//   docs/snmp_reach_<YYYY-MM-DD>.csv      the deliverable
//   snmp_reach table                      so the next survey can be diffed
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH = arg('--db', process.env.FMS_DB || '/opt/cflex-v2/cflex-api/data/cflex.db');
const CBU = arg('--cbu', null);
const OUT = arg('--out', 'docs');
const TIMEOUT = parseInt(arg('--timeout', '2'), 10);
const RETRIES = parseInt(arg('--retries', '1'), 10);
const USE_V3 = argv.includes('--v3');
const NO_DB = argv.includes('--no-db');

function openDb(file) {
  const appDir = path.dirname(path.dirname(file));         // .../cflex-api/data/x.db -> .../cflex-api
  for (const from of [appDir, process.cwd(), __dirname]) {
    try {
      const resolved = require.resolve('better-sqlite3', { paths: [from] });
      return new (require(resolved))(file);
    } catch { /* try the next search path */ }
  }
  try {
    const { DatabaseSync } = require('node:sqlite');       // Node 22+, for local runs
    return new DatabaseSync(file);
  } catch {
    throw new Error('no sqlite driver: better-sqlite3 not resolvable and node:sqlite unavailable');
  }
}

/** Is there a route to this address at all, or does it leave by the default gateway? */
function routeVerdict(ip) {
  try {
    // `ip route get` prints a trailing "cache" line, which turned every CSV
    // row into two and made a 48-device survey a 97-line file.
    const out = execSync(`ip route get ${ip} 2>/dev/null`, { encoding: 'utf8' })
      .split('\n').map(l => l.trim()).filter(l => l && l !== 'cache').join(' ');
    // "via <gw> dev eth0" with the gateway being the default means nothing here
    // knows where that network is; the packet is handed to the upstream router
    // and dropped. A directly-connected or tunnelled route names a different
    // device or says "dev <tun|wg|ipsec>".
    const viaDefault = /via\s/.test(out) && !/dev\s+(tun|wg|ipsec|gre|vti)/.test(out);
    return { route: out, viaDefault };
  } catch { return { route: null, viaDefault: null }; }
}

function hasRouteToPrivateNet() {
  // A single check, reported once: does this host have ANY tunnel interface?
  try {
    const links = execSync('ip -br link 2>/dev/null', { encoding: 'utf8' });
    return /\b(tun|wg|ipsec|gre|vti)\d*/.test(links);
  } catch { return null; }
}

function snmpGet(dev) {
  const ip = dev.ip;
  const port = dev.snmp_port || 161;
  const oid = '1.3.6.1.2.1.1.1.0';            // sysDescr
  const t0 = Date.now();
  let args;
  const v3 = USE_V3 || dev.snmp_version === '3' || (!dev.snmp_community && dev.snmp_v3_user);
  if (v3) {
    if (!dev.snmp_v3_user) return { ok: 0, failure: 'no-v3-credentials', rtt: null, out: null, version: '3' };
    args = ['-v3', '-l', 'authPriv', '-u', dev.snmp_v3_user,
      '-a', dev.snmp_v3_auth_protocol || 'SHA', '-A', dev.snmp_v3_auth_password || '',
      '-x', dev.snmp_v3_priv_protocol || 'AES', '-X', dev.snmp_v3_priv_password || '',
      '-t', String(TIMEOUT), '-r', String(RETRIES), `${ip}:${port}`, oid];
  } else {
    args = ['-v2c', '-c', dev.snmp_community || 'public',
      '-t', String(TIMEOUT), '-r', String(RETRIES), `${ip}:${port}`, oid];
  }
  try {
    const out = execFileSync('snmpget', args, { encoding: 'utf8', timeout: (TIMEOUT * (RETRIES + 1) + 2) * 1000 });
    return { ok: 1, failure: null, rtt: Date.now() - t0, out: out.trim(), version: v3 ? '3' : '2c' };
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '').trim();
    let failure = 'timeout';
    if (/No Response|Timeout/i.test(msg)) failure = 'timeout';
    else if (/Authentication failure|unknownUserName|wrongDigest/i.test(msg)) failure = 'auth';
    else if (/refused|unreachable|No route/i.test(msg)) failure = 'refused';
    else if (msg) failure = msg.split('\n')[0].slice(0, 80);
    return { ok: 0, failure, rtt: Date.now() - t0, out: null, version: v3 ? '3' : '2c' };
  }
}

/** Pull the NMC firmware version out of an APC sysDescr, if it is in there. */
function nmcVersion(sysDescr) {
  if (!sysDescr) return null;
  const m = /\b(?:AOS|v)\s*v?(\d+\.\d+(?:\.\d+)?)/i.exec(sysDescr);
  return m ? m[1] : null;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(function main() {
  const db = openDb(DB_PATH);
  const where = ['decommissioned_at IS NULL', "ip IS NOT NULL", "ip NOT IN ('','0.0.0.0')"];
  const params = [];
  if (CBU) { where.push('cbu = ?'); params.push(CBU); }
  const devices = db.prepare(
    `SELECT id, tenant_id, label, cbu, ip, snmp_community, snmp_port, snmp_version,
            snmp_v3_user, snmp_v3_auth_protocol, snmp_v3_auth_password,
            snmp_v3_priv_protocol, snmp_v3_priv_password
     FROM ups_devices WHERE ${where.join(' AND ')} ORDER BY cbu, label`,
  ).all(...params);

  const host = os.hostname();
  const tunnels = hasRouteToPrivateNet();
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);

  console.log(`probe host     : ${host}`);
  console.log(`tunnel present : ${tunnels === null ? 'unknown' : tunnels}`);
  console.log(`devices        : ${devices.length}${CBU ? ` (cbu=${CBU})` : ''}`);
  console.log(`snmp timeout   : ${TIMEOUT}s x ${RETRIES + 1}`);
  console.log('');

  const rows = [];
  const ins = NO_DB ? null : db.prepare(
    `INSERT INTO snmp_reach (tenant_id, cbu, device_id, label, ip, version, ok, rtt_ms,
                             sys_descr, nmc_version, failure, probe_host, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const d of devices) {
    const rv = routeVerdict(d.ip);
    const r = snmpGet(d);
    // A timeout where the packet left by the default gateway is not evidence
    // about the device's access control — nothing on this host knows where that
    // network is. Saying "timeout" there would send the wrong request letter.
    const failure = r.ok ? null : (rv.viaDefault && r.failure === 'timeout' ? 'no-route' : r.failure);
    const row = {
      cbu: d.cbu || '', label: d.label, ip: d.ip, version: r.version,
      ok: r.ok, rtt_ms: r.rtt, sys_descr: r.out, nmc: nmcVersion(r.out),
      failure, route: rv.route, probe_host: host,
    };
    rows.push(row);
    if (ins) {
      ins.run(d.tenant_id ?? null, d.cbu ?? null, d.id, d.label, d.ip, r.version,
        r.ok, r.rtt, r.out, row.nmc, failure, host, ts);
    }
    console.log(`${(d.cbu || '-').padEnd(9)} ${d.label.slice(0, 26).padEnd(27)} ${d.ip.padEnd(16)} ` +
      `${r.ok ? 'OK  ' + r.rtt + 'ms' : failure}`);
  }

  // ── the deliverable ──
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `snmp_reach_${day}.csv`);
  const header = ['cbu', 'label', 'ip', 'snmp_version', 'answered', 'rtt_ms',
    'nmc_version', 'sys_descr', 'failure', 'route_used', 'probe_host', 'surveyed_at'];
  const csv = [header.join(',')].concat(rows.map(r => [
    r.cbu, r.label, r.ip, r.version, r.ok ? 'yes' : 'no', r.rtt_ms ?? '',
    r.nmc ?? '', r.sys_descr ?? '', r.failure ?? '', r.route ?? '', r.probe_host,
    new Date(ts).toISOString(),
  ].map(csvCell).join(','))).join('\n');
  fs.writeFileSync(file, csv + '\n');

  const ok = rows.filter(r => r.ok).length;
  const byFailure = {};
  for (const r of rows) if (!r.ok) byFailure[r.failure] = (byFailure[r.failure] || 0) + 1;

  console.log('');
  console.log(`answered       : ${ok} / ${rows.length}`);
  for (const [k, v] of Object.entries(byFailure).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log(`csv            : ${file}`);
  if (byFailure['no-route']) {
    console.log('');
    console.log(`NOTE: ${byFailure['no-route']} device(s) could not be reached because this host has no`);
    console.log('      route to their network — the packets left by the default gateway. That is');
    console.log('      NOT evidence about NMC access control, and an "allow our IP" request will');
    console.log('      not change it. A probe inside that network is the prerequisite.');
  }
  db.close?.();
})();
