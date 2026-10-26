// trap/listener.js — the SNMP trap receiver: v1, v2c and v3 (up to authPriv),
// on UDP CFLEX_TRAP_PORT (default 1162).
//
// The process never binds 162 itself. In the container profile firewalld
// forwards 162 → 1162 (or the sysctl mode publishes 162 onto 1162), and on
// bare the systemd unit grants CAP_NET_BIND_SERVICE with CFLEX_TRAP_PORT=162 —
// docs/install/CONTAINER_PROFILE.md §2. No privilege is asked for here.
//
// Credentials are the Local Console's SNMP credentials for the inventory, the
// same the pollers read with: every device's community, and every device's v3
// user (auth and priv keys). The receiver rejects anything else; the handler
// then insists on the *sending* device's own credential. A rejected trap is
// dropped and counted, never decoded further.
//
// Receive only. Informs are acknowledged (the protocol requires the
// response); nothing is ever sent to a device beyond that — no SET (D-05).
const snmp = require('net-snmp');
const { authProtocolOf, privProtocolOf } = require('../services/snmp-helpers');

/** Inventory rows → { communities, users } for the receiver's authorizer. */
function credentialsOf(devices, { defaultCommunity = 'public', log = console } = {}) {
  const communities = new Set();
  const users = new Map();
  for (const d of devices || []) {
    if (d.snmp_version === 'v3' && d.snmp_v3_user) {
      const auth = authProtocolOf(d.snmp_v3_auth_protocol);
      const priv = privProtocolOf(d.snmp_v3_priv_protocol);
      const u = {
        name: d.snmp_v3_user,
        level: priv ? snmp.SecurityLevel.authPriv : auth ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
        authProtocol: auth || snmp.AuthProtocols.none, authKey: d.snmp_v3_auth_password || '',
        privProtocol: priv || snmp.PrivProtocols.none, privKey: d.snmp_v3_priv_password || '',
      };
      const had = users.get(u.name);
      // One user name, one set of keys: USM looks the user up by name only.
      if (had && (had.authKey !== u.authKey || had.privKey !== u.privKey || had.level !== u.level)) {
        log.warn(`[trap] v3 user ${u.name} has different keys on ${d.name || d.id}; traps are checked with the first device's`);
      } else if (!had) users.set(u.name, u);
    }
    // A v1/v2c device: its community, or the pollers' default. A v3 device
    // only with a community of its own — v3 does not imply "public".
    if (d.snmp_version !== 'v3') communities.add(d.snmp_community || defaultCommunity);
    else if (d.snmp_community) communities.add(d.snmp_community);
  }
  return { communities: [...communities], users: [...users.values()] };
}

/**
 * @param {object} o
 * @param {object} o.handler          trap/handler.js instance
 * @param {number} [o.port]           1162
 * @param {string} [o.bind]           0.0.0.0
 * @param {string} [o.defaultCommunity]
 * @param {number} [o.tickMs]         how often handler.tick() runs (comm-lost hold)
 * @param {object} [o.log]
 */
function createTrapListener({ handler, port = 1162, bind = '0.0.0.0', defaultCommunity = 'public', tickMs = 60000, log = console }) {
  let receiver = null;
  let timer = null;
  let listenError = null;
  let creds = { communities: [], users: [] };

  function onNotification(error, n) {
    if (error) {
      // Socket-level (bind) errors have no source; everything else is a rejected trap.
      if (!error.rinfo && /EADDRINUSE|EACCES|EADDRNOTAVAIL|bind/i.test(`${error.code || ''} ${error.message}`)) {
        listenError = error.code || error.message;
        log.error(`[trap] cannot listen on ${bind}:${port}/udp: ${listenError}`);
        return;
      }
      const auth = /community|user|digest|authentic|privacy|decrypt/i.test(error.message || '');
      handler.discard(auth ? 'auth' : 'malformed', error.rinfo?.address);
      return;
    }
    handler.handle(n).catch(e => log.error(`[trap] handling failed: ${e.message}`));
  }

  /** Replace the accepted credentials (after each inventory pull). */
  function apply() {
    if (!receiver) return;
    const a = receiver.getAuthorizer();
    for (const c of [...a.getCommunities()]) a.deleteCommunity(c);
    for (const u of [...a.getUsers()]) a.deleteUser(u.name);
    for (const c of creds.communities) a.addCommunity(c);
    for (const u of creds.users) a.addUser(u);
  }

  function setInventory(devices) {
    handler.setInventory(devices);
    creds = credentialsOf(devices, { defaultCommunity, log });
    apply();
  }

  function start() {
    receiver = snmp.createReceiver({
      port, address: bind, transport: 'udp4',
      disableAuthorization: false, includeAuthentication: true,
    }, onNotification);
    apply();
    timer = setInterval(() => handler.tick().catch(e => log.error(`[trap] tick failed: ${e.message}`)), tickMs);
    timer.unref?.();
    log.log(`[trap] listening on ${bind}:${port}/udp (v1/v2c/v3)`);
    return api;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return new Promise(resolve => { if (!receiver) return resolve(); receiver.close(() => resolve()); receiver = null; });
  }

  const api = {
    start, stop, setInventory,
    stats: () => ({ ...handler.stats(), port, listen_error: listenError, communities: creds.communities.length, v3_users: creds.users.length }),
  };
  return api;
}

module.exports = { createTrapListener, credentialsOf };
