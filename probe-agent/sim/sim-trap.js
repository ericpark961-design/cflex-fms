// SNMP trap simulator — sends APC PowerNet-MIB traps the way an NMC does, as
// v1, v2c or v3 (authPriv), at the trap listener (trap/listener.js). Dev and
// tests only; it sends traps and nothing else.
//
//   TRAP_HOST=127.0.0.1 TRAP_PORT=1162 node sim/sim-trap.js            # the whole scenario
//   node sim/sim-trap.js upsOnBattery v2c                              # one trap
//
// v2c uses SNMP_COMMUNITY (default public). v3 uses SNMP_V3_USER,
// SNMP_V3_AUTH_KEY, SNMP_V3_PRIV_KEY (SHA / AES) — set them to what the
// console holds for the device; nothing secret is built in.
const { snmp } = require('./lib');
const { APC_ENTERPRISE, TRAPS } = require('../src/trap/apc-mib');

const BY_NAME = Object.fromEntries(Object.entries(TRAPS).map(([n, t]) => [t.name, Number(n)]));

/**
 * The scenario: 12 trap kinds, every version at least once, and two the
 * Probe cannot map (a NetBotz-style OID with no appendix-B code, and a
 * generic coldStart).
 */
const SCENARIO = [
  { trap: 'upsOnBattery', version: 'v1' },
  { trap: 'lowBattery', version: 'v2c' },
  { trap: 'returnFromLowBattery', version: 'v2c' },
  { trap: 'powerRestored', version: 'v1' },
  { trap: 'upsOverload', version: 'v3' },
  { trap: 'upsOverloadCleared', version: 'v3' },
  { trap: 'upsBatteryNeedsReplacement', version: 'v2c' },
  { trap: 'upsDiagnosticsFailed', version: 'v3' },
  { trap: 'upsDiagnosticsPassed', version: 'v2c' },
  { trap: 'communicationLost', version: 'v2c' },
  { trap: 'communicationEstablished', version: 'v2c' },
  { trap: 'switchedBypass', version: 'v1' },
  { trap: 'returnFromBypass', version: 'v1' },
  { oid: '1.3.6.1.4.1.5528.100.10.2.1', version: 'v2c', note: 'NetBotz-style, no appendix-B code' },
  { oid: '1.3.6.1.6.3.1.1.5.1', version: 'v2c', note: 'coldStart' },
];

const oidOf = (s) => (s.oid ? s.oid : `${APC_ENTERPRISE}.0.${BY_NAME[s.trap]}`);

/**
 * Send one trap. Resolves when it is on the wire.
 * @param {object} o  {host, port, version, trap|oid, community, user:{name, authKey, privKey, ...}, agentAddr, varbinds}
 */
function send(o) {
  const host = o.host || '127.0.0.1';
  const oid = oidOf(o);
  if (!o.oid && !BY_NAME[o.trap]) return Promise.reject(new Error(`unknown trap name ${o.trap}`));
  const varbinds = o.varbinds || [{ oid: '1.3.6.1.4.1.318.2.3.10.0', type: snmp.ObjectType.OctetString, value: `${o.trap || o.note || oid} (sim)` }];
  let session;
  if (o.version === 'v3') {
    const u = o.user || {};
    session = snmp.createV3Session(host, {
      name: u.name, level: u.level ?? snmp.SecurityLevel.authPriv,
      authProtocol: u.authProtocol || snmp.AuthProtocols.sha, authKey: u.authKey,
      privProtocol: u.privProtocol || snmp.PrivProtocols.aes, privKey: u.privKey,
    }, { version: snmp.Version3, trapPort: o.port });
  } else {
    session = snmp.createSession(host, o.community || 'public', {
      version: o.version === 'v1' ? snmp.Version1 : snmp.Version2c, trapPort: o.port,
    });
  }
  return new Promise((resolve, reject) => {
    // A v1 generic trap (coldStart …) is sent by number; everything else as an OID.
    const generic = /^1\.3\.6\.1\.6\.3\.1\.1\.5\.(\d+)$/.exec(oid);
    // v1 enterprise-specific: net-snmp splits at the last arc (enterprise, specific),
    // so E.0.S (RFC 3584) goes as E.S.
    const typeOrOid = o.version !== 'v1' ? oid
      : generic ? Number(generic[1]) - 1
      : oid.replace(/\.0\.(\d+)$/, '.$1');
    const done = (e) => { session.close(); e ? reject(e) : resolve({ oid, version: o.version }); };
    if (o.version === 'v1') session.trap(typeOrOid, varbinds, o.agentAddr || host, done);
    else session.trap(typeOrOid, varbinds, done);
  });
}

async function main() {
  const env = process.env;
  const base = {
    host: env.TRAP_HOST || '127.0.0.1', port: parseInt(env.TRAP_PORT || '1162', 10),
    community: env.SNMP_COMMUNITY || 'public',
    user: { name: env.SNMP_V3_USER || 'cflex-sim', authKey: env.SNMP_V3_AUTH_KEY, privKey: env.SNMP_V3_PRIV_KEY },
  };
  const [one, version] = process.argv.slice(2);
  const list = one ? [{ trap: one, version: version || 'v2c' }] : SCENARIO;
  for (const s of list) {
    if (s.version === 'v3' && !(base.user.authKey && base.user.privKey)) {
      console.log(`skip ${s.trap || s.oid} v3: set SNMP_V3_AUTH_KEY and SNMP_V3_PRIV_KEY`);
      continue;
    }
    const r = await send({ ...base, ...s });
    console.log(`sent ${s.version} ${s.trap || s.note} ${r.oid} → ${base.host}:${base.port}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { send, SCENARIO, oidOf };
