// settings.js — the Admin side of the console (spec 01 §2.2 "설정"): sites,
// devices and the Exhibit 1 / seed CSV import with the inventory checks,
// SNMP credentials, alarm thresholds, local notification channels, users,
// collector keys. Every change is written to the audit log by the caller.
//
// Secrets go in sealed (seal.js) and never come back out of the API: a GET
// answers `{ set: true }` where a secret is stored. Only the Collector's
// config pull (ingest path, collector key) receives them opened.
const crypto = require('crypto');
const auth = require('./auth');
const adapt = require('../../../probe-agent/src/contract/adapt');
const { DEFAULT_THRESHOLDS } = require('./views');

const SITE_RE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const bad = (code, message, extra) => Object.assign(new Error(message || code), { status: 400, code, extra });
const json = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clean = (v, n = 128) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
/** "AUG/31/2025", "AUG 2025", "2025-08", "2025-08-31" → "2025-08"; anything else null. */
function yearMonth(v) {
  const s = String(v || '').trim().toUpperCase();
  let m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^([A-Z]{3})[\s/-]+(?:\d{1,2}[\s/-]+)?(\d{4})$/.exec(s);
  if (m && MONTHS[m[1]]) return `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}`;
  return null;
}

/** APC serials carry the build year+week at positions 2–5 (AS2535… = 2025 week 35). */
function serialYearMonth(serial) {
  const m = /^[A-Z]{2}(\d{2})(\d{2})/.exec(String(serial || '').toUpperCase());
  if (!m) return null;
  const yy = 2000 + +m[1], ww = +m[2];
  if (ww < 1 || ww > 53) return null;
  const month = Math.min(12, Math.floor(((ww - 1) * 7) / 30.44) + 1);
  return `${yy}-${String(month).padStart(2, '0')}`;
}
const monthsApart = (a, b) => { const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number); return Math.abs((ya * 12 + ma) - (yb * 12 + mb)); };

/** Minimal RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF. */
function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
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

// Header aliases: the console's own names, the Q3 seed CSV's, and Exhibit 1's.
const ALIAS = {
  site: ['site', 'site_id', 'cbu'], label: ['label', 'unit', 'name', 'device'], nmc_ip: ['nmc_ip', 'ip', 'nmc ip', 'ip address'],
  vendor: ['vendor'], model: ['model'], serial: ['serial', 'serial_number'], serial_alt: ['serial_alt'],
  firmware: ['firmware'], building: ['building'], floor: ['floor'], room: ['room', 'location'], rack: ['rack'],
  mfg_date: ['mfg_date', 'mfg_date_reported'], battery_installed: ['battery_installed', 'battery_install'],
  battery_due: ['battery_due', 'battery_replace_due'], in_sow: ['in_sow', 'exhibit1', 'exhibit 1'],
  snmp_version: ['snmp_version'], snmp_community: ['snmp_community', 'community'], snmp_user: ['snmp_user'],
  snmp_auth_proto: ['snmp_auth_proto'], snmp_auth_key: ['snmp_auth_key'], snmp_priv_proto: ['snmp_priv_proto'], snmp_priv_key: ['snmp_priv_key'],
};

function createSettings(db, { sealer, tenant, now = Date.now } = {}) {
  const ctx = { tenant, siteId: null };
  const getSetting = async (k, d) => json((await db.one('SELECT value FROM settings WHERE key = ?', k))?.value, d);
  const putSetting = (k, v, by) => db.run(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    k, JSON.stringify(v), by, now());

  // ── sites ────────────────────────────────────────────────────────────────
  const listSites = () => db.all('SELECT * FROM sites ORDER BY id');
  async function putSite(id, b) {
    const sid = String(id || b.id || '').toUpperCase();
    if (!SITE_RE.test(sid)) throw bad('invalid_site_id', 'site id must match ^[A-Z0-9][A-Z0-9-]{0,31}$ (contract site code)');
    const name = clean(b.name, 128);
    if (!name) throw bad('name_required');
    await db.run(`INSERT INTO sites (id, name, company, timezone) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, company = excluded.company, timezone = excluded.timezone`,
      sid, name, clean(b.company, 64), clean(b.timezone, 64) || 'America/Los_Angeles');
    return db.one('SELECT * FROM sites WHERE id = ?', sid);
  }
  async function resolveSite(v) {
    const s = String(v || '').trim().toUpperCase();
    if (!s) return null;
    const exact = await db.one('SELECT id FROM sites WHERE id = ?', s);
    if (exact) return exact.id;
    const pre = await db.all('SELECT id FROM sites WHERE id LIKE ?', `${s}-%`);
    return pre.length === 1 ? pre[0].id : null;
  }

  // ── devices ──────────────────────────────────────────────────────────────
  const FIELDS = ['label', 'vendor', 'model', 'serial', 'nmc_ip', 'building', 'floor', 'room', 'rack', 'firmware', 'mfg_date', 'battery_installed', 'battery_due'];

  function normDevice(b, site) {
    const d = { site_id: site };
    for (const k of FIELDS) d[k] = clean(b[k]);
    if (d.serial) d.serial = d.serial.toUpperCase();
    for (const k of ['mfg_date', 'battery_installed', 'battery_due']) if (d[k]) d[k] = yearMonth(d[k]) || d[k];
    if (d.nmc_ip && !IPV4.test(d.nmc_ip)) d.nmc_ip = null;
    const alt = Array.isArray(b.serial_alt) ? b.serial_alt : String(b.serial_alt || '').split(/[;|]/);
    d.serial_alt = JSON.stringify(alt.map(x => String(x).trim().toUpperCase()).filter(Boolean));
    const sow = b.in_sow;
    d.in_sow = sow == null || sow === '' ? 1 : (/^(1|y|yes|true)$/i.test(String(sow)) ? 1 : 0);
    d.polling_enabled = b.polling_enabled == null ? 1 : (b.polling_enabled ? 1 : 0);
    d.thresholds = b.thresholds && typeof b.thresholds === 'object' ? JSON.stringify(b.thresholds) : null;
    return d;
  }

  /** The §2.2 inventory checks: warnings, not refusals — the site's data is what it is. */
  async function checks(d, selfId = null) {
    const w = [];
    if (d.serial) {
      const dup = await db.all('SELECT id, label FROM devices WHERE (serial = ? OR serial_alt LIKE ?) AND id IS DISTINCT FROM ?::bigint', d.serial, `%"${d.serial}"%`, selfId);
      if (dup.length) w.push({ code: 'serial_duplicate', message: `serial ${d.serial} also on ${dup.map(x => x.label).join(', ')}` });
      const sy = serialYearMonth(d.serial);
      if (sy && d.mfg_date && /^\d{4}-\d{2}$/.test(d.mfg_date)) {
        if (/-01$/.test(d.mfg_date) && monthsApart(sy, d.mfg_date) > 2) w.push({ code: 'mfg_date_default_suspect', message: `mfg ${d.mfg_date} looks like a 1/1 default; serial says ${sy}` });
        else if (monthsApart(sy, d.mfg_date) > 3) w.push({ code: 'mfg_date_serial_mismatch', message: `mfg ${d.mfg_date} vs serial YYWW ${sy}` });
      }
    } else {
      w.push({ code: 'serial_missing', message: 'no serial: device_id is provisional (ledger-based) until it is known' });
    }
    const lab = await db.all('SELECT id FROM devices WHERE site_id = ? AND label = ? AND id IS DISTINCT FROM ?::bigint', d.site_id, d.label, selfId);
    if (lab.length) w.push({ code: 'label_duplicate', message: `label ${d.label} already used ${lab.length}× at ${d.site_id}` });
    if (!d.in_sow) w.push({ code: 'not_in_sow', message: 'not in Exhibit 1: in_sow=false' });
    return w;
  }

  const contractId = (row) => adapt.deviceIdFor({ id: row.id, site_id: row.site_id, serial: row.serial }, { ...ctx, siteId: row.site_id });

  /** Insert or update one device; returns {device, warnings, created}. Keeps telemetry/alarms on a device_id change. */
  async function saveDevice(b, { id = null } = {}) {
    const site = await resolveSite(b.site_id || b.site);
    if (!site) throw bad('unknown_site', `site ${b.site_id || b.site || '(blank)'} is not configured`);
    const d = normDevice(b, site);
    if (!d.label) throw bad('label_required');
    const warnings = await checks(d, id);
    const t = now();
    const isNew = !id;
    return db.tx(async (tx) => {
      let row;
      if (id) {
        row = await tx.one('SELECT * FROM devices WHERE id = ?', id);
        if (!row) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
        await tx.run(`UPDATE devices SET site_id=?, label=?, vendor=?, model=?, serial=?, serial_alt=?, nmc_ip=?, building=?, floor=?, room=?, rack=?,
          firmware=?, mfg_date=?, battery_installed=?, battery_due=?, in_sow=?, polling_enabled=?, thresholds=COALESCE(?, thresholds), updated_at=? WHERE id=?`,
          d.site_id, d.label, d.vendor, d.model, d.serial, d.serial_alt, d.nmc_ip, d.building, d.floor, d.room, d.rack,
            d.firmware, d.mfg_date, d.battery_installed, d.battery_due, d.in_sow, d.polling_enabled, d.thresholds, t, id);
      } else {
        const r = await tx.run(`INSERT INTO devices (device_id, site_id, label, vendor, model, serial, serial_alt, nmc_ip, building, floor, room, rack,
          firmware, mfg_date, battery_installed, battery_due, in_sow, polling_enabled, thresholds, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          `tmp-${crypto.randomUUID()}`, d.site_id, d.label, d.vendor, d.model, d.serial, d.serial_alt, d.nmc_ip, d.building, d.floor, d.room, d.rack,
            d.firmware, d.mfg_date, d.battery_installed, d.battery_due, d.in_sow, d.polling_enabled, d.thresholds, t, t);
        id = r.rows[0].id;
      }
      row = await tx.one('SELECT * FROM devices WHERE id = ?', id);
      const cid = contractId(row);
      if (row.device_id !== cid) {
        // A serial learned later changes the contract ID (Q-2026-10-25-05);
        // the console keeps the device's history under the new one.
        for (const tbl of ['telemetry', 'alarms', 'maintenance', 'credentials']) await tx.run(`UPDATE ${tbl} SET device_id = ? WHERE device_id = ?`, cid, row.device_id);
        await tx.run('UPDATE devices SET device_id = ? WHERE id = ?', cid, id);
      }
      return { device: await tx.one('SELECT * FROM devices WHERE id = ?', id), warnings, created: isNew };
    });
  }

  async function deleteDevice(id) {
    const r = await db.run('DELETE FROM devices WHERE id = ?', id);
    if (!r.changes) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
  }

  // ── credentials ──────────────────────────────────────────────────────────
  /** {site_id?, device_id?, version, community? | username, auth_proto, auth_key, priv_proto, priv_key}. */
  async function putCredential(b, by) {
    const version = String(b.version || '').replace(/^v/i, '');
    if (!['1', '2c', '3'].includes(version)) throw bad('invalid_version', 'version must be 1, 2c or 3');
    const site = b.site_id ? await resolveSite(b.site_id) : null;
    if (b.site_id && !site) throw bad('unknown_site');
    const did = b.device_id ? String(b.device_id) : null;
    if (!site && !did) throw bad('scope_required', 'site_id or device_id');
    const secret = version === '3'
      ? { auth_key: b.auth_key || null, priv_key: b.priv_key || null }
      : { community: b.community || null };
    if (version === '3' && !b.username) throw bad('username_required');
    const hasSecret = Object.values(secret).some(Boolean);
    const sealed = hasSecret ? sealer.seal(secret) : null;
    await db.run(`INSERT INTO credentials (site_id, device_id, version, username, auth_proto, priv_proto, secret, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_id, device_id) DO UPDATE SET version=excluded.version, username=excluded.username, auth_proto=excluded.auth_proto,
        priv_proto=excluded.priv_proto, secret=COALESCE(excluded.secret, credentials.secret), updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      site, did, version, clean(b.username, 64), clean(b.auth_proto, 16), clean(b.priv_proto, 16), sealed, by, now());
  }
  const listCredentials = async () => (await db.all('SELECT id, site_id, device_id, version, username, auth_proto, priv_proto, secret IS NOT NULL AS secret_set, updated_by, updated_at FROM credentials ORDER BY site_id NULLS FIRST, device_id NULLS FIRST'))
    .map(c => ({ ...c, secret_set: !!c.secret_set }));

  // ── CSV import ───────────────────────────────────────────────────────────
  /**
   * Import Exhibit 1 / seed rows. Upsert on serial, else on (site, label).
   * `dryRun` validates and reports without writing. Credential columns, when
   * present, become a per-device credential (sealed).
   */
  async function importCsv(text, { dryRun = false, by } = {}) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw bad('empty_csv', 'a header row and at least one data row');
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = {};
    for (const [k, names] of Object.entries(ALIAS)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[k] = i; }
    if (col.site == null || col.label == null) throw bad('missing_columns', 'site and label (or unit) columns are required');
    const report = [];
    let created = 0, updated = 0, failed = 0;
    for (let n = 1; n < rows.length; n++) {
      const r = rows[n];
      const v = {};
      for (const [k, i] of Object.entries(col)) v[k] = r[i] != null ? r[i].trim() : '';
      const line = { row: n + 1, label: v.label, site: v.site };
      try {
        const site = await resolveSite(v.site);
        if (!site) throw bad('unknown_site', `site ${v.site} is not configured`);
        const serial = clean(v.serial)?.toUpperCase();
        const existing = (serial && await db.one('SELECT id FROM devices WHERE serial = ?', serial))
          || await db.one('SELECT id FROM devices WHERE site_id = ? AND label = ?', site, clean(v.label));
        if (dryRun) {
          const d = normDevice({ ...v, site_id: site }, site);
          line.action = existing ? 'update' : 'create';
          line.warnings = await checks(d, existing?.id ?? null);
        } else {
          const res = await saveDevice({ ...v, site_id: site }, { id: existing?.id ?? null });
          line.action = existing ? 'update' : 'create';
          line.device_id = res.device.device_id;
          line.warnings = res.warnings;
          if (v.snmp_version) await putCredential({ device_id: res.device.device_id, version: v.snmp_version, community: v.snmp_community, username: v.snmp_user,
            auth_proto: v.snmp_auth_proto, auth_key: v.snmp_auth_key, priv_proto: v.snmp_priv_proto, priv_key: v.snmp_priv_key }, by);
        }
        if (line.action === 'create') created++; else updated++;
      } catch (e) {
        failed++; line.error = e.code || 'error'; line.message = e.message;
      }
      report.push(line);
    }
    return { ok: failed === 0, dry_run: !!dryRun, created, updated, failed, rows: report };
  }

  // ── thresholds ───────────────────────────────────────────────────────────
  const getThresholds = async () => ({ ...DEFAULT_THRESHOLDS, ...await getSetting('thresholds', {}) });
  async function putThresholds(b, by) {
    const out = {};
    for (const [k, v] of Object.entries(b || {})) {
      if (!DEFAULT_THRESHOLDS[k]) throw bad('unknown_metric', k);
      const crit = Number(v.critical), warn = Number(v.warn);
      if (!Number.isFinite(crit) || !Number.isFinite(warn)) throw bad('invalid_threshold', k);
      out[k] = { critical: crit, warn, direction: DEFAULT_THRESHOLDS[k].direction };
    }
    await putSetting('thresholds', { ...await getSetting('thresholds', {}), ...out }, by);
    return getThresholds();
  }

  // ── local notification channels ──────────────────────────────────────────
  // Stored in probe-agent's notify.json shape (README §로컬 알림), secrets sealed
  // in place: email.smtp.auth.pass, teams.webhook, servicenow.pass.
  const SECRET_PATHS = [['email', 'smtp', 'auth', 'pass'], ['teams', 'webhook'], ['servicenow', 'pass']];
  const at = (o, p) => p.reduce((x, k) => (x == null ? undefined : x[k]), o);
  const setAt = (o, p, v) => { let x = o; for (const k of p.slice(0, -1)) x = x[k] = x[k] && typeof x[k] === 'object' ? x[k] : {}; if (v === undefined) delete x[p[p.length - 1]]; else x[p[p.length - 1]] = v; };

  async function getNotify({ open = false } = {}) {
    const n = await getSetting('notify', {});
    for (const p of SECRET_PATHS) {
      const v = at(n, p);
      if (v && typeof v === 'object' && v.sealed) setAt(n, p, open ? sealer.open(v.sealed).v : { set: true });
    }
    return n;
  }

  async function putNotify(b, by) {
    const cur = await getSetting('notify', {});
    const next = { ...cur };
    for (const k of ['productName', 'siteName', 'dashboardUrl', 'policy', 'email', 'teams', 'servicenow']) {
      if (b[k] === undefined) continue;
      next[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? { ...(cur[k] || {}), ...b[k] } : b[k];
      if (k === 'email' && b.email?.smtp) next.email.smtp = { ...(cur.email?.smtp || {}), ...b.email.smtp, ...(b.email.smtp.auth ? { auth: { ...(cur.email?.smtp?.auth || {}), ...b.email.smtp.auth } } : {}) };
    }
    for (const p of SECRET_PATHS) {
      const given = at(b, p);
      if (given === undefined || (given && typeof given === 'object' && given.set)) { setAt(next, p, at(cur, p)); continue; }
      setAt(next, p, given === null || given === '' ? undefined : { sealed: sealer.seal({ v: String(given) }) });
    }
    if (next.policy) {
      const P = ['P1', 'P2', 'P3', 'P4'];
      for (const k of ['email_min', 'teams_min', 'itsm_min']) if (next.policy[k] != null && !P.includes(next.policy[k])) throw bad('invalid_policy', k);
      for (const k of ['local_email', 'local_teams', 'local_itsm', 'notify_clear']) if (next.policy[k] != null) next.policy[k] = !!next.policy[k];
    }
    await putSetting('notify', next, by);
    return getNotify();
  }

  async function channelsHealth() {
    const n = await getNotify();
    return [
      { channel: 'email', configured: !!(n.email?.smtp?.host && (n.email?.to || []).length), enabled: n.policy?.local_email !== false },
      { channel: 'teams', configured: !!n.teams?.webhook, enabled: n.policy?.local_teams !== false },
      { channel: 'servicenow', configured: !!n.servicenow?.instanceUrl, enabled: n.policy?.local_itsm !== false },
    ].map(c => ({ ...c, ok: c.configured && c.enabled, last_ok: null, last_error: null }));
  }

  // ── users ────────────────────────────────────────────────────────────────
  const userOut = (u) => u && ({ id: u.id, username: u.username, display_name: u.display_name, email: u.email, role: u.role,
    must_change: !!u.must_change, disabled: !!u.disabled, created_at: u.created_at, last_login_at: u.last_login_at, pw_changed_at: u.pw_changed_at });
  const listUsers = async () => (await db.all('SELECT * FROM users ORDER BY lower(username), id')).map(userOut);

  async function createUser(b) {
    const username = clean(b.username, 64);
    if (!username || !/^[A-Za-z0-9._@-]{3,64}$/.test(username)) throw bad('invalid_username');
    if (!auth.ROLES[b.role]) throw bad('invalid_role', 'admin | operator | viewer');
    const why = auth.passwordProblem(b.password, username);
    if (why) throw bad('weak_password', why);
    if (await db.one('SELECT 1 FROM users WHERE lower(username) = lower(?)', username)) throw Object.assign(new Error('exists'), { status: 409, code: 'user_exists' });
    const t = now();
    const r = await db.run(`INSERT INTO users (username, display_name, email, role, pw_hash, pw_changed_at, must_change, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
      username, clean(b.display_name), clean(b.email), b.role, auth.hashPassword(b.password), t, b.must_change === false ? 0 : 1, t);
    if (!r.rows.length) throw Object.assign(new Error('exists'), { status: 409, code: 'user_exists' });
    return userOut(r.rows[0]);
  }

  async function updateUser(id, b) {
    const u = await db.one('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
    if (b.role != null && !auth.ROLES[b.role]) throw bad('invalid_role');
    // The last enabled admin cannot demote or disable itself out of existence.
    const demoting = (b.role && b.role !== 'admin') || b.disabled === true;
    if (u.role === 'admin' && demoting && (await db.one(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0`)).c <= 1) {
      throw Object.assign(new Error('last admin'), { status: 409, code: 'last_admin' });
    }
    if (b.password != null) {
      const why = auth.passwordProblem(b.password, u.username);
      if (why) throw bad('weak_password', why);
      await db.run('UPDATE users SET pw_hash = ?, pw_changed_at = ?, must_change = 1 WHERE id = ?', auth.hashPassword(b.password), now(), id);
    }
    await db.run(`UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), role = COALESCE(?, role),
      disabled = COALESCE(?::integer, disabled) WHERE id = ?`,
      clean(b.display_name), clean(b.email), b.role || null, b.disabled == null ? null : (b.disabled ? 1 : 0), id);
    return userOut(await db.one('SELECT * FROM users WHERE id = ?', id));
  }

  // ── collectors ───────────────────────────────────────────────────────────
  /** A new key for a collector node; shown once, stored as its SHA-256. */
  async function issueCollectorKey(nodeId) {
    const id = String(nodeId || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw bad('invalid_node_id');
    const key = crypto.randomBytes(32).toString('base64url');
    const h = crypto.createHash('sha256').update(key).digest('hex');
    await db.run(`INSERT INTO collectors (node_id, key_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET key_hash = excluded.key_hash`, id, h, now());
    return { node_id: id, key };
  }
  const listCollectors = async () => (await db.all('SELECT node_id, created_at, last_seen, heartbeat FROM collectors ORDER BY node_id'))
    .map(c => ({ ...c, heartbeat: json(c.heartbeat) }));

  /** What a collector polls: devices with their credentials opened (device override, else site default). */
  async function collectorDevices() {
    const creds = await db.all('SELECT * FROM credentials ORDER BY id');
    return (await db.all('SELECT * FROM devices WHERE polling_enabled = 1 ORDER BY site_id, label')).map(d => {
      const c = creds.find(x => x.device_id === d.device_id) || creds.find(x => x.device_id == null && x.site_id === d.site_id);
      const s = c?.secret ? sealer.open(c.secret) : {};
      return {
        id: d.id, device_id: d.device_id, name: d.label, kind: 'ups', site_id: d.site_id, ip: d.nmc_ip, vendor: d.vendor, model: d.model,
        serial: d.serial, thresholds: json(d.thresholds),
        snmp_version: c?.version || null, snmp_community: s.community || null,
        snmp_v3: c?.version === '3' ? { user: c.username, auth_proto: c.auth_proto, auth_key: s.auth_key || null, priv_proto: c.priv_proto, priv_key: s.priv_key || null } : null,
      };
    });
  }

  return {
    listSites, putSite, resolveSite, saveDevice, deleteDevice, checks, importCsv,
    putCredential, listCredentials, getThresholds, putThresholds,
    getNotify, putNotify, channelsHealth,
    listUsers, createUser, updateUser, userOut,
    issueCollectorKey, listCollectors, collectorDevices,
    getSetting, putSetting,
  };
}

module.exports = { createSettings, parseCsv, yearMonth, serialYearMonth };
