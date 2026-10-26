// trap/handler.js — a received trap → the alarm engine (WO-INT-006).
//
// The listener (trap/listener.js) has already checked that the trap carries a
// credential this node knows. Here:
//
//   1. which device sent it — the source address, looked up in the Local
//      Console's inventory (the same rows the pollers use);
//   2. whether it used *that* device's credential (its community, or its v3
//      user) — a credential valid for another NMC is not good enough;
//   3. what it means — trap/apc-mib.js, appendix-B codes only;
//   4. into the alarm engine, exactly like a poll alarm: same (device, code)
//      key, so a trap and a poll seeing the same fault share one alarm_id,
//      and de-duplication, flapping and maintenance windows apply unchanged.
//
// A trap from an address not in the inventory, or with an OID that has no
// appendix-B code, is "SNMP_TRAP_UNKNOWN": that code is not in appendix B, so
// it is not an alarm — it is counted and kept in a short list of recent ones
// (stats()/recent()), and logged, nothing more (DECISIONS Q-2026-10-26-04).
const { lookup } = require('./apc-mib');
const { COMM_LOST_AFTER_MS } = require('../alarms/codes');

const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const PDU_TRAP_V1 = 164;
const UNKNOWN = 'SNMP_TRAP_UNKNOWN';

/** A net-snmp trap PDU → { version, trapOid, agentAddr, varbinds }. */
function decode(pdu) {
  if (pdu.type === PDU_TRAP_V1) {
    // RFC 3584 §3.1: enterprise-specific = enterprise.0.specific; generic g = snmpTraps.(g+1).
    const trapOid = pdu.generic === 6 ? `${pdu.enterprise}.0.${pdu.specific}` : `1.3.6.1.6.3.1.1.5.${pdu.generic + 1}`;
    return { version: 'v1', trapOid, agentAddr: pdu.agentAddr || null, varbinds: pdu.varbinds || [] };
  }
  const vbs = pdu.varbinds || [];
  const t = vbs.find(v => v.oid === SNMP_TRAP_OID);
  return {
    version: pdu.user != null ? 'v3' : 'v2c',
    trapOid: t ? String(t.value) : null,
    agentAddr: null,
    varbinds: vbs.filter(v => v.oid !== SNMP_TRAP_OID && v.oid !== SYS_UPTIME),
  };
}

/** The few varbinds worth keeping in an event's detail: scalar values, short. */
function varbindDetail(vbs) {
  const d = {};
  vbs.slice(0, 4).forEach((v, i) => {
    let val = v.value;
    if (Buffer.isBuffer(val)) val = val.toString('utf8').replace(/[^\x20-\x7e]/g, '');
    if (typeof val === 'bigint') val = Number(val);
    if (['string', 'number', 'boolean'].includes(typeof val)) d[`vb${i + 1}`] = typeof val === 'string' ? val.slice(0, 120) : val;
  });
  return d;
}

/**
 * @param {object} o
 * @param {object} o.engine            alarms/engine.js instance (the forwarder's)
 * @param {Function} o.emit            engine items → console + Portal (forwarder.emitAlarms)
 * @param {string} [o.defaultCommunity] what the pollers use when a device has none (cfg.snmp.community)
 * @param {number} [o.commLostAfterMs]
 * @param {number} [o.recentMax]
 * @param {Function} [o.now]
 * @param {object} [o.log]
 */
function createTrapHandler({ engine, emit, defaultCommunity = 'public', commLostAfterMs = COMM_LOST_AFTER_MS,
  recentMax = 200, now = Date.now, log = console } = {}) {
  let byIp = new Map();
  const lost = new Map();      // device_id → { device, since } — communicationLost, not yet 30 min
  const clearing = new Map();  // engine key → { device, code } — clear deferred by the flap rule
  const recentUnknown = [];
  const stats = {
    received: 0, by_version: { v1: 0, v2c: 0, v3: 0 }, raised: 0, cleared: 0, duplicates: 0,
    unknown_oid: 0, unknown_source: 0, discarded: { auth: 0, wrong_device_credential: 0, malformed: 0 },
    last_at: null,
  };

  /** The inventory to match source addresses against (UPSs and objects alike). */
  function setInventory(devices) {
    const m = new Map();
    for (const d of devices || []) {
      if (!d || !d.ip) continue;
      if (m.has(d.ip)) log.warn(`[trap] two inventory rows share ${d.ip} (${m.get(d.ip).name} / ${d.name}); traps go to the first`);
      else m.set(d.ip, d);
    }
    byIp = m;
  }

  function record(kind, info) {
    recentUnknown.push({ at: new Date(now()).toISOString(), kind, ...info });
    if (recentUnknown.length > recentMax) recentUnknown.splice(0, recentUnknown.length - recentMax);
    log.info(`[trap] ${UNKNOWN} (${kind}) from ${info.source} ${info.trap_oid || ''}${info.device ? ` device ${info.device}` : ''} — recorded only`);
  }

  /** A trap the receiver rejected (wrong community, unknown v3 user, bad digest, undecodable). */
  function discard(reason, source) {
    const k = reason === 'auth' ? 'auth' : 'malformed';
    stats.discarded[k]++;
    log.warn(`[trap] discarded (${reason}) from ${source || '?'}`);
  }

  /** Did the trap use this device's own credential? */
  function ownCredential(device, pdu, version) {
    if (version === 'v3') return device.snmp_version === 'v3' && pdu.user === device.snmp_v3_user;
    if (device.snmp_version === 'v3') return !!device.snmp_community && pdu.community === device.snmp_community;
    return pdu.community === (device.snmp_community || defaultCommunity);
  }

  /**
   * @param {{pdu:object, rinfo:{address:string}}} n  net-snmp receiver notification (includeAuthentication)
   * @returns {Promise<{status:string, code?:string, items?:object[]}>}
   */
  async function handle({ pdu, rinfo }) {
    const ts = now();
    const source = rinfo?.address || null;
    let t;
    try { t = decode(pdu); } catch (e) { discard('malformed', source); return { status: 'discarded' }; }
    if (!t.trapOid) { discard('malformed', source); return { status: 'discarded' }; }
    stats.received++;
    stats.by_version[t.version]++;
    stats.last_at = ts;

    const device = byIp.get(source) || (t.agentAddr && byIp.get(t.agentAddr)) || null;
    if (!device) {
      stats.unknown_source++;
      record('unknown_source', { source, trap_oid: t.trapOid, version: t.version });
      return { status: 'unknown_source' };
    }
    if (!ownCredential(device, pdu, t.version)) {
      stats.discarded.wrong_device_credential++;
      log.warn(`[trap] discarded from ${source} (${device.name}): not this device's ${t.version === 'v3' ? 'v3 user' : 'community'}`);
      return { status: 'discarded' };
    }
    const m = lookup(t.trapOid);
    if (!m) {
      stats.unknown_oid++;
      record('unknown_oid', { source, trap_oid: t.trapOid, version: t.version, device: device.name || String(device.id) });
      return { status: 'unknown_oid' };
    }

    const detail = { trap: m.name, trap_oid: m.oid, snmp_version: t.version, ...varbindDetail(t.varbinds) };
    let items;
    if (m.action === 'clear') {
      if (m.code === 'UPS_COMM_LOST') lost.delete(engineKey(device));
      items = engine.clear(device, m.code, { ts, source: 'trap' });
      if (!items.length && engine.isOpen(device, m.code)) clearing.set(`${engineKey(device)}|${m.code}`, { device, code: m.code });
      stats.cleared += items.length;
    } else if (m.hold === 'comm_lost' && !engine.isOpen(device, m.code)) {
      // Appendix B: UPS_COMM_LOST only after 30 minutes. tick() raises it then.
      const k = engineKey(device);
      if (!lost.has(k)) lost.set(k, { device, since: ts, detail });
      return { status: 'held', code: m.code };
    } else {
      const was = engine.isOpen(device, m.code);
      items = engine.observe(device, m.code, {
        ts, source: 'trap', latched: m.latched, detail,
        title: `${device.name ? `${device.name}: ` : ''}${m.name} (trap)`,
      });
      if (was) stats.duplicates++;
      else stats.raised += items.filter(i => i.event.kind === 'alarm_raise').length;
    }
    if (items.length) await emit(items);
    return { status: m.action === 'clear' ? 'cleared' : 'mapped', code: m.code, items };
  }

  const engineKey = (device) => `${device.serial || device.serial_number || ''}|${device.id}`;

  /**
   * Run every minute or so: a communicationLost older than 30 minutes becomes
   * UPS_COMM_LOST, and a clear the flap rule deferred is tried again.
   */
  async function tick() {
    const ts = now();
    const items = [];
    for (const [k, l] of [...lost]) {
      if (ts - l.since < commLostAfterMs) continue;
      lost.delete(k);
      const mins = Math.round((ts - l.since) / 60000);
      const r = engine.observe(l.device, 'UPS_COMM_LOST', {
        ts, source: 'trap', latched: true, detail: { ...l.detail, down_min: mins },
        title: `${l.device.name ? `${l.device.name}: ` : ''}UPS communication lost for ${mins} min (trap)`,
      });
      stats.raised += r.filter(i => i.event.kind === 'alarm_raise').length;
      items.push(...r);
    }
    for (const [k, c] of [...clearing]) {
      if (!engine.isOpen(c.device, c.code)) { clearing.delete(k); continue; }
      const r = engine.clear(c.device, c.code, { ts, source: 'trap' });
      if (r.length) { clearing.delete(k); stats.cleared += r.length; items.push(...r); }
    }
    if (items.length) await emit(items);
    return items;
  }

  return {
    setInventory, handle, discard, tick,
    stats: () => ({ ...stats, by_version: { ...stats.by_version }, discarded: { ...stats.discarded },
      devices: byIp.size, comm_lost_pending: lost.size }),
    recent: () => recentUnknown.map(r => ({ ...r })),
  };
}

module.exports = { createTrapHandler, decode, UNKNOWN, SNMP_TRAP_OID };
