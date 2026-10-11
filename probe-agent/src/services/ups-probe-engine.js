// services/ups-probe-engine.js — SNMP probe engine (runs on probe agent OR in-process local probe).
// Pure logic — no DB, no HTTP. Caller passes credentials and gets results.
const snmp = require('net-snmp');
const { createSession } = require('./snmp-helpers');

const TIMEOUT = 4000;

// ── Vendor sysObjectID prefixes ──────────────────────────────────
const VENDOR_PREFIXES = {
  '1.3.6.1.4.1.318':  'APC',
  '1.3.6.1.4.1.534':  'Eaton',
  '1.3.6.1.4.1.3808': 'CyberPower',
  '1.3.6.1.4.1.476':  'HP',
  '1.3.6.1.4.1.232':  'HPE Compaq',
  '1.3.6.1.4.1.13742':'Vertiv/Liebert',
  '1.3.6.1.4.1.850':  'Tripp Lite',
  '1.3.6.1.4.1.4555': 'Socomec',
};

const OIDS = {
  sysDescr:    '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysName:     '1.3.6.1.2.1.1.5.0',
  upsIdentManufacturer: '1.3.6.1.2.1.33.1.1.1.0',
  upsIdentModel:        '1.3.6.1.2.1.33.1.1.2.0',
  upsBatteryStatus:     '1.3.6.1.2.1.33.1.2.1.0',
  upsBatteryCharge:     '1.3.6.1.2.1.33.1.2.4.0',
  apcModel:    '1.3.6.1.4.1.318.1.1.1.1.1.1.0',
  apcFirmware: '1.3.6.1.4.1.318.1.1.1.1.2.1.0',
  apcSerial:   '1.3.6.1.4.1.318.1.1.1.1.2.3.0',
  apcBatPct:   '1.3.6.1.4.1.318.1.1.1.2.2.1.0',
  eatonModel:    '1.3.6.1.4.1.534.1.1.2.0',
  eatonFirmware: '1.3.6.1.4.1.534.1.1.3.0',
  eatonSerial:   '1.3.6.1.4.1.534.1.1.4.0',
  eatonBatPct:   '1.3.6.1.4.1.534.1.2.4.0',
  cyberModel:    '1.3.6.1.4.1.3808.1.1.1.1.1.1.0',
  cyberFirmware: '1.3.6.1.4.1.3808.1.1.1.1.2.1.0',
  cyberBatPct:   '1.3.6.1.4.1.3808.1.1.1.2.2.1.0',
};

function vendorFromOID(oid) {
  if (!oid) return 'Unknown';
  for (const prefix of Object.keys(VENDOR_PREFIXES)) {
    if (oid.startsWith(prefix)) return VENDOR_PREFIXES[prefix];
  }
  return 'Unknown';
}

function snmpGet(dev, oids) {
  return new Promise((resolve) => {
    let session;
    try { session = createSession(dev, { timeout: TIMEOUT, retries: 1 }); }
    catch (e) { return resolve({ ok: false, error: 'session: ' + e.message }); }
    let settled = false;
    const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
    session.get(oids, (err, varbinds) => {
      try { session.close(); } catch (_) {}
      if (err) return safeResolve({ ok: false, error: err.message });
      const out = {};
      oids.forEach((oid, i) => {
        const vb = varbinds[i];
        if (vb && !snmp.isVarbindError(vb)) {
          let v = vb.value;
          if (Buffer.isBuffer(v)) v = v.toString('utf8').trim();
          out[oid] = v;
        }
      });
      safeResolve({ ok: true, values: out });
    });
    setTimeout(() => safeResolve({ ok: false, error: 'timeout' }), TIMEOUT + 1000);
  });
}

async function probeDevice(dev) {
  const probeOids = [OIDS.sysDescr, OIDS.sysObjectID, OIDS.sysName];
  const r = await snmpGet(dev, probeOids);
  if (!r.ok) return { ok: false, error: r.error };
  const sysDescr = r.values[OIDS.sysDescr] || '';
  const sysObjectID = String(r.values[OIDS.sysObjectID] || '');
  const vendor = vendorFromOID(sysObjectID);

  const idOids = [];
  if (vendor === 'APC') idOids.push(OIDS.apcModel, OIDS.apcFirmware, OIDS.apcSerial, OIDS.apcBatPct);
  else if (vendor === 'Eaton') idOids.push(OIDS.eatonModel, OIDS.eatonFirmware, OIDS.eatonSerial, OIDS.eatonBatPct);
  else if (vendor === 'CyberPower') idOids.push(OIDS.cyberModel, OIDS.cyberFirmware, OIDS.cyberBatPct);
  idOids.push(OIDS.upsIdentManufacturer, OIDS.upsIdentModel, OIDS.upsBatteryCharge, OIDS.upsBatteryStatus);

  const idr = await snmpGet(dev, idOids);
  const id = idr.values || {};
  const isUps = sysDescr.toUpperCase().includes('UPS')
             || vendor === 'APC' || vendor === 'Eaton' || vendor === 'CyberPower'
             || id[OIDS.upsIdentManufacturer] != null || id[OIDS.upsIdentModel] != null;

  return {
    ok: true,
    is_ups: isUps,
    vendor: vendor !== 'Unknown' ? vendor : (id[OIDS.upsIdentManufacturer] || 'Unknown'),
    model:    id[OIDS.apcModel] || id[OIDS.eatonModel] || id[OIDS.cyberModel] || id[OIDS.upsIdentModel] || null,
    firmware: id[OIDS.apcFirmware] || id[OIDS.eatonFirmware] || id[OIDS.cyberFirmware] || null,
    serial:   id[OIDS.apcSerial] || id[OIDS.eatonSerial] || null,
    sys_descr: sysDescr,
    sys_object_id: sysObjectID,
    sys_name: r.values[OIDS.sysName] || null,
    battery_pct: id[OIDS.apcBatPct] || id[OIDS.eatonBatPct] || id[OIDS.cyberBatPct] || id[OIDS.upsBatteryCharge] || null,
  };
}

function expandCidr(cidr) {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) throw new Error('invalid CIDR (expect a.b.c.d/mask)');
  const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
  const mask = parseInt(m[5], 10);
  if (mask < 22 || mask > 32) throw new Error('CIDR mask must be /22 to /32');
  const hostBits = 32 - mask;
  const baseInt = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
  const networkBase = (baseInt >>> hostBits) << hostBits;
  const hostCount = 1 << hostBits;
  const out = [];
  const start = (mask >= 31) ? 0 : 1;
  const end   = (mask >= 31) ? hostCount : hostCount - 1;
  for (let i = start; i < end; i++) {
    const ipInt = (networkBase + i) >>> 0;
    out.push(`${(ipInt >>> 24) & 0xff}.${(ipInt >>> 16) & 0xff}.${(ipInt >>> 8) & 0xff}.${ipInt & 0xff}`);
  }
  return out;
}

async function probeBatch(ips, baseDev, concurrency = 16, onProgress = null) {
  const results = [];
  let cursor = 0;
  let scanned = 0;
  async function worker() {
    while (cursor < ips.length) {
      const my = cursor++;
      const ip = ips[my];
      try {
        const r = await probeDevice({ ...baseDev, ip });
        scanned++;
        if (onProgress) onProgress({ scanned, total: ips.length, ip, ok: r.ok });
        if (r.ok) results.push({ ip, ...r });
      } catch (_) { scanned++; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

module.exports = {
  probeDevice,
  probeBatch,
  expandCidr,
  vendorFromOID,
  VENDOR_PREFIXES,
  OIDS,
};
