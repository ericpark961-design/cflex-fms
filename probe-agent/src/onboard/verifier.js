// onboard/verifier.js — `cflex-onboard verify` and apply's verify step
// (spec 04 §4.3–4.4).
//
// SNMP here is GET only, SNMPv3 only: sysDescr and upsBasicIdentModel with
// the run's user and keys. There is no SET in cflex-onboard (spec 04 §3) —
// net-snmp's session.set is never called, and the test suite greps for it.
//
// Trap test: a temporary SNMPv3 receiver (--trap-test, port --trap-port)
// waits for a trap from the card. What makes the card send one is the
// operator's step (the card's web UI test, or any event); no CLI command that
// sends a test trap is confirmed in the guides, so none is sent. Without
// --trap-test the trap check is `not_tested` and does not fail the card.
const snmp = require('net-snmp');
const { authProtocolOf, privProtocolOf } = require('../services/snmp-helpers');

const OID = { sysDescr: '1.3.6.1.2.1.1.1.0', upsBasicIdentModel: '1.3.6.1.4.1.318.1.1.1.1.1.1.0' };

const v3user = (d) => ({
  name: d.v3.user, level: snmp.SecurityLevel.authPriv,
  authProtocol: authProtocolOf(d.v3.auth), authKey: d.v3.authKey,
  privProtocol: privProtocolOf(d.v3.priv), privKey: d.v3.privKey,
});

/**
 * @param {object} o
 * @param {object} o.gate
 * @param {Function} [o.endpoint]  ip → {host, snmpPort}
 * @param {number} [o.timeoutMs]
 * @param {object} [o.trap]        {port, bind, waitMs} — set only with --trap-test
 */
function createVerifier({ gate, endpoint = null, timeoutMs = 5000, retries = 1, trap = null, log = console }) {
  const ep = endpoint || ((ip) => ({ host: ip, snmpPort: 161 }));

  function snmpV3Get(ip, desired) {
    gate.assert(ip);
    const { host, snmpPort } = ep(ip);
    return new Promise((resolve) => {
      let s;
      try {
        s = snmp.createV3Session(host, v3user(desired), { port: snmpPort || 161, version: snmp.Version3, timeout: timeoutMs, retries });
      } catch (e) { return resolve({ ok: false, error: 'session' }); }
      s.on('error', () => {});
      s.get([OID.sysDescr, OID.upsBasicIdentModel], (err, vbs) => {
        try { s.close(); } catch { /* closed */ }
        if (err) return resolve({ ok: false, error: err.name === 'RequestTimedOutError' ? 'timeout' : (err.name || 'error') });
        const bad = vbs.find(v => snmp.isVarbindError(v));
        if (bad) return resolve({ ok: false, error: 'no_such_object' });
        resolve({ ok: true, sysDescr: String(vbs[0].value), model: String(vbs[1].value) });
      });
    });
  }

  /** Wait for one trap from `ip` on a temporary receiver. */
  function trapTest(ip, desired) {
    if (!trap) return Promise.resolve({ status: 'not_tested' });
    gate.assert(ip);
    const { host } = ep(ip);
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { rx.close(); } catch { /* closed */ } resolve(r); };
      const rx = snmp.createReceiver({ port: trap.port, address: trap.bind || '0.0.0.0', transport: 'udp4', disableAuthorization: false }, (err, n) => {
        if (err) return; // a trap with other credentials, or bind trouble — keep waiting
        if (n?.rinfo?.address === host) finish({ status: 'pass', version: 'v3' });
      });
      rx.getAuthorizer().addUser(v3user(desired));
      log.log(`[onboard] ${ip}: waiting ${Math.round((trap.waitMs || 60000) / 1000)} s for a test trap on udp/${trap.port}`);
      const t = setTimeout(() => finish({ status: 'fail', error: 'no_trap' }), trap.waitMs || 60000);
    });
  }

  return { snmpV3Get, trapTest };
}

module.exports = { createVerifier, OID };
