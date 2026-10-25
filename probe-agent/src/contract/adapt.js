// contract/adapt.js — today's internal shapes → contract v1.0 payloads.
//
// The pollers still speak the shape the old cloud stored (battery_pct,
// runtime_min, output_source, an alert per threshold breach). Rewriting them
// is not this work order; translating at the boundary is. What cannot be
// translated is counted, not guessed.
//
// Alarms are not translated here: classification, lifecycle, flapping and
// maintenance are alarms/engine.js (WO-INT-003).
const crypto = require('crypto');
const { classify } = require('../alarms/codes');

const iso = (ms) => new Date(ms ?? Date.now()).toISOString();

/** Contract §2: device_id = sha1(tenant|site_id|serial)[:16]. */
function deviceId(tenant, siteId, serial) {
  return crypto.createHash('sha1').update(`${tenant}|${siteId}|${serial}`).digest('hex').slice(0, 16);
}

/**
 * The contract ID for a ledger device. A device whose serial the ledger does
 * not carry yet is keyed on its ledger id instead, so it still has a stable ID
 * — but that ID will change once the serial is known (DECISIONS Q-2026-10-25-05).
 */
function deviceIdFor(device, ctx) {
  const serial = device.serial || device.serial_number;
  return deviceId(ctx.tenant, siteOf(device, ctx), serial ? String(serial) : `ledger:${device.id}`);
}

/** The contract site code (`HMA-FV`); a ledger value that is not one falls back to the node's site. */
function siteOf(device, ctx) {
  const s = device.site_id != null ? String(device.site_id).toUpperCase() : '';
  return /^[A-Z0-9][A-Z0-9-]{0,31}$/.test(s) ? s : ctx.siteId;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const str = (v, n) => (v == null || v === '' ? undefined : String(v).slice(0, n));

/** A ledger device → an inventory entry (§3.2). Only what the ledger actually knows. */
function inventoryDevice(d, ctx) {
  const serial = d.serial || d.serial_number;
  const e = {
    device_id: deviceIdFor(d, ctx),
    site_id: siteOf(d, ctx),
    label: str(d.name, 128),
    vendor: str(d.vendor, 64),
    model: str(d.model, 64),
    serial: str(serial, 64),
    nmc_ip: IPV4.test(String(d.ip || '')) ? d.ip : undefined,
    tags: d.kind ? [String(d.kind).toLowerCase().slice(0, 32)] : undefined,
    // Q-2026-10-25-05: an ID not keyed on a serial says so, so the Portal can
    // show it as unconfirmed and merge history when the successor arrives.
    ...(serial ? {} : { provisional: true, id_basis: 'ledger' }),
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

const STATUS = {
  onLine: 'online', normal: 'online', onSmartBoost: 'online', onSmartTrim: 'online',
  onBattery: 'on_battery', bypass: 'bypass', softwareBypass: 'bypass', off: 'off',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A UPS poll (ok or not) → one telemetry point. */
function upsPoint(device, p, ctx) {
  const m = { comm_ok: p.ok !== false, poll_latency_ms: num(p.took_ms) };
  const x = p.metrics || {};
  if (p.ok !== false) {
    Object.assign(m, {
      bat_pct: num(x.battery_pct),
      load_pct: num(x.load_pct),
      bat_temp_c: num(x.temp_c),
      runtime_s: num(x.runtime_min) != null ? x.runtime_min * 60 : null,
      status: STATUS[x.output_source] ?? null,
      bat_replace_flag: x.battery_status ? /replace/i.test(x.battery_status) : null,
    });
    if (num(x.input_v) != null) m.in_v = [x.input_v];
    if (num(x.output_v) != null) m.out_v = [x.output_v];
    if (x.firmware) m.fw = String(x.firmware).slice(0, 128);
  }
  return { device_id: deviceIdFor(device, ctx), ts: iso(p.ts), m };
}

const snake = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 64);

/** A non-UPS collector result ({metric, value, str_value, unit…}[]) → one point; m is flat. */
function collectorPoint(device, p, ctx) {
  const m = { comm_ok: p.ok !== false };
  for (const r of p.metrics || []) {
    const k = snake(r.metric);
    if (!k) continue;
    if (num(r.value) != null) m[k] = r.value;
    else if (r.str_value != null) m[k] = String(r.str_value).slice(0, 128);
  }
  return { device_id: deviceIdFor(device, ctx), ts: iso(p.ts), m };
}

/** Which appendix-B code a poller threshold alert is (alarms/codes.js). null = none. */
const codeFor = classify;

module.exports = { deviceId, deviceIdFor, siteOf, inventoryDevice, upsPoint, collectorPoint, codeFor, iso };
