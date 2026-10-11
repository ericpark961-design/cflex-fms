// get / walk on top of net-snmp, shaped so a partial answer is still an answer.
//
// The UPS path asks for every OID in one `get`, which fails the whole request
// if any single OID is absent. That is fine for a UPS profile where all of them
// exist; it is wrong for a PDU, a NetBotz or a CRAC, where which objects are
// present depends on what is plugged in and which options were bought. A basic
// rack PDU has no outlet table; a NetBotz with no leak cable has no leak
// sensor. Losing the eleven readings that DID answer because the twelfth did
// not is how a collector reports nothing from a device that is working.
//
// So: errors are per-varbind, and the caller gets what came back plus what
// did not.
const snmp = require('net-snmp');
const { createSession } = require('./snmp-helpers');

/**
 * Read a set of scalar OIDs.
 * @returns {{ok, values:{key:raw}, missing:string[], error?:string}}
 */
function get(device, oidsByKey, opts = {}) {
  const keys = Object.keys(oidsByKey);
  if (!keys.length) return Promise.resolve({ ok: true, values: {}, missing: [] });
  return new Promise((resolve) => {
    let session;
    try {
      session = createSession(device, { timeout: opts.timeoutMs || 3000, retries: opts.retries ?? 1 });
    } catch (e) {
      return resolve({ ok: false, values: {}, missing: keys, error: 'session: ' + e.message });
    }
    const oids = keys.map(k => oidsByKey[k]);
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { session.close(); } catch { /* already closed */ } resolve(r); };
    // net-snmp's own timeout governs each retry; this is the backstop for a
    // callback that never fires, which leaks a session and stalls the cycle.
    const guard = setTimeout(() => done({ ok: false, values: {}, missing: keys, error: 'no callback' }),
      (opts.timeoutMs || 3000) * ((opts.retries ?? 1) + 1) + 2000);
    session.get(oids, (err, varbinds) => {
      clearTimeout(guard);
      if (err) return done({ ok: false, values: {}, missing: keys, error: err.message });
      const values = {};
      const missing = [];
      (varbinds || []).forEach((vb, i) => {
        const key = keys[i];
        if (!vb || snmp.isVarbindError(vb)) { missing.push(key); return; }
        values[key] = normalize(vb.value);
      });
      done({ ok: true, values, missing });
    });
  });
}

/**
 * Walk one table and return it as rows keyed by index.
 *
 * @param table   the table's entry OID, e.g. '1.3.6.1.2.1.2.2.1'
 * @param columns {name: {sub: '8'}} — which columns to collect
 * @returns {{ok, rows:{index:{col:raw}}, error?:string}}
 */
function walkTable(device, table, columns, opts = {}) {
  const subs = Object.entries(columns).map(([name, c]) => ({ name, prefix: `${table}.${c.sub}.` }));
  return new Promise((resolve) => {
    let session;
    try {
      session = createSession(device, { timeout: opts.timeoutMs || 3000, retries: opts.retries ?? 1 });
    } catch (e) {
      return resolve({ ok: false, rows: {}, error: 'session: ' + e.message });
    }
    const rows = {};
    let errored = null;
    let pending = subs.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { session.close(); } catch { /* already closed */ }
      // A column that is absent is not a failure of the walk: a switch with no
      // ENTITY-SENSOR support still has an IF-MIB table worth having.
      resolve({ ok: Object.keys(rows).length > 0 || !errored, rows, error: errored || undefined });
    };
    const guard = setTimeout(() => { errored = errored || 'walk timeout'; finish(); },
      (opts.timeoutMs || 3000) * ((opts.retries ?? 1) + 1) * Math.max(1, subs.length) + 3000);

    for (const { name, prefix } of subs) {
      session.subtree(prefix.slice(0, -1), (varbinds) => {
        for (const vb of varbinds || []) {
          if (!vb || snmp.isVarbindError(vb)) continue;
          const idx = String(vb.oid).startsWith(prefix) ? String(vb.oid).slice(prefix.length) : null;
          if (idx == null) continue;
          (rows[idx] = rows[idx] || {})[name] = normalize(vb.value);
        }
      }, (err) => {
        if (err) errored = errored || err.message;
        if (--pending === 0) { clearTimeout(guard); finish(); }
      });
    }
    if (!subs.length) { clearTimeout(guard); finish(); }
  });
}

/** Buffers come back for OCTET STRING; everything else is already a number. */
function normalize(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/\0+$/, '').trim();
  if (typeof v === 'bigint') return Number(v);
  return v;
}

module.exports = { get, walkTable, normalize };
